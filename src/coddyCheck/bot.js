const env = require("../config/env");
const User = require("../models/User");
const CoddyTeacher = require("./models/CoddyTeacher");
const { getWorkerMainKeyboard, adminMainKeyboard, supportMainKeyboard } = require("./keyboards");

let coddyBot = null;
let coddyMode = "disabled";

function isAdmin(ctx) {
  if (env.coddyAdminIds.includes(Number(ctx.from?.id))) return true;
  return ctx.state?.worker?.role === "kurator";
}

function isSupport(ctx) {
  return ctx.state?.worker?.role === "support";
}

function canUseCallRequest(ctx) {
  const role = String(ctx.state?.worker?.role || "").toLowerCase();
  return role === "mentor" || role === "mentor_ta";
}

async function findBotUserByTelegramId(telegramId) {
  const normalized = String(telegramId || "").trim();
  if (!normalized) return null;

  return User.findOne({
    telegramId: normalized,
    isActive: true,
    role: { $in: ["kurator", "mentor", "ta", "mentor_ta"] }
  });
}

async function findSupportByTelegramId(telegramId) {
  const normalized = String(telegramId || "").trim();
  if (!normalized) return null;
  return User.findOne({ telegramId: normalized, isActive: true, role: "support" }).lean();
}

async function userAllowed(ctx) {
  const telegramId = Number(ctx.from?.id);
  if (!telegramId) return { allowed: false, worker: null };

  // Support users: allowed for callback actions only
  const support = await findSupportByTelegramId(String(telegramId));
  if (support) {
    return { allowed: true, worker: support };
  }

  // DB-based: check registered users (kurator, mentor, ta, mentor_ta)
  const user = await findBotUserByTelegramId(String(telegramId));
  if (user) {
    return { allowed: true, worker: user };
  }

  // Env-based fallback for emergency access without DB record
  if (env.coddyAdminIds.includes(telegramId)) {
    return { allowed: true, worker: null };
  }

  return { allowed: false, worker: null };
}

function getMainKeyboard(ctx) {
  if (isAdmin(ctx)) {
    return adminMainKeyboard;
  }

  if (isSupport(ctx)) {
    return supportMainKeyboard;
  }

  return getWorkerMainKeyboard(ctx.state?.worker?.role);
}

async function handleStart(ctx) {
  const { id, first_name: firstName, username = "" } = ctx.from;
  const displayName = ctx.state?.worker?.fullName || firstName || username || "Teacher";

  await CoddyTeacher.findOneAndUpdate(
    { telegramId: id },
    { name: displayName, username },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return ctx.reply(`Xush kelibsiz, ${displayName}!`, {
    reply_markup: {
      keyboard: getMainKeyboard(ctx),
      resize_keyboard: true
    }
  });
}

async function startCoddyCheckBot() {
  if (!env.coddyBotToken || env.coddyBotToken === "disabled") {
    console.log("Coddy bot skipped: CODDY_BOT_TOKEN is missing or disabled");
    return null;
  }

  let Telegraf;
  let Scenes;
  let session;

  try {
    ({ Telegraf, Scenes, session } = require("telegraf"));
  } catch (error) {
    console.error("Coddy bot skipped: telegraf dependency not found.");
    console.error("Run: npm install telegraf luxon");
    return null;
  }

  const teacherController = require("./controllers/teacherController");
  const adminController = require("./controllers/adminController");
  const startCoddyDailyReport = require("./jobs/dailyReport");

  const attendanceScene = require("./scenes/attendanceScene");
  const callRequestScene = require("./scenes/callRequestScene");
  const talkRequestScene = require("./scenes/talkRequestScene");
  const reportScene = require("./scenes/reportScene");
  const settingsScene = require("./scenes/settingsScene");
  const searchScene = require("./scenes/searchScene");
  const editScene = require("./scenes/editScene");
  const messageScene = require("./scenes/messageScene");
  const kuratorReplyScene = require("./scenes/kuratorReplyScene");

  coddyBot = new Telegraf(env.coddyBotToken);

  const stage = new Scenes.Stage([
    attendanceScene,
    callRequestScene,
    talkRequestScene,
    reportScene,
    settingsScene,
    searchScene,
    editScene,
    messageScene,
    kuratorReplyScene
  ]);
  coddyBot.use(session());

  coddyBot.use(async (ctx, next) => {
    try {
      if (!ctx.from) return next();

      const { allowed, worker } = await userAllowed(ctx);
      if (!allowed) {
        return ctx.reply("Sizda botdan foydalanish huquqi yo'q.");
      }

      ctx.state.worker = worker || null;
      return next();
    } catch (error) {
      console.error("Bot middleware error:", error);
      return ctx.reply("Botda texnik xatolik yuz berdi.").catch(() => { });
    }
  });

  coddyBot.use(stage.middleware());

  coddyBot.catch((err, ctx) => {
    console.error(`Telegraf error for update ${ctx.update?.update_id}:`, err);
  });

  coddyBot.start(async (ctx) => {
    try {
      await handleStart(ctx);
    } catch (error) {
      console.error("handleStart error:", error);
      await ctx.reply("Start buyrug'ida xatolik yuz berdi.").catch(() => { });
    }
  });

  coddyBot.hears("📣 O'quvchi chaqirish", (ctx) => {
    if (!canUseCallRequest(ctx)) {
      return ctx.reply(
        "Bu tugma faqat Mentor va Mentor+TA uchun.\n\n" +
        "Quyidagi komandaga bosing:\n" +
        "/start"
      );
    }
    return ctx.scene.enter("coddy_call_request_wizard");
  });

  coddyBot.hears("💬 Murojat", (ctx) => {
    if (!canUseCallRequest(ctx)) {
      return ctx.reply(
        "Bu tugma faqat Mentor va Mentor+TA uchun.\n\n" +
        "Quyidagi komandaga bosing:\n" +
        "/start"
      );
    }
    return ctx.scene.enter("coddy_talk_request_wizard");
  });

  coddyBot.hears("➕ O'quvchi qo'shish", (ctx) => ctx.scene.enter("coddy_attendance_wizard"));

  coddyBot.hears("⚙️ Sozlamalar", (ctx) => ctx.scene.enter("coddy_settings_scene"));
  coddyBot.hears("ℹ️ Yordam", (ctx) => {
    const { Markup } = require("telegraf");
    const role = String(ctx.state?.worker?.role || "").toLowerCase();
    let text;

    if (role === "support") {
      return ctx.reply(
        "ℹ️ Support yordam:\n\n" +
        "👥 Mentorlar:\n" +
        "Barcha mentorlar ro'yxatini va ularning kurator/filial ma'lumotlarini ko'rish, parolini tiklash.\n\n" +
        "📊 Statistika:\n" +
        "Har bir kurator bo'yicha guruhlar, o'quvchilar va xodimlar soni.\n\n" +
        "Har qanday vaziyat uchun: /start\n\n" +
        "Muammo bo'lsa: @mv_nuriddin"
      );
    }

    if (role === "mentor") {
      text =
        "📣 O'quvchi chaqirish:\n" +
        "Darsga kelmagan o'quvchini chaqirish uchun '📣 O'quvchi chaqirish' tugmasini bosing va ko'rsatmalarga amal qiling.\n\n" +
        "💬 Murojat:\n" +
        "Kuratorga o'quvchi bo'yicha murojat yuborish uchun '💬 Murojat' tugmasini bosing.\n\n" +
        "Har qanday vaziyat uchun: /start\n\n" +
        "Shikoyat va takliflar uchun: @mv_nuriddin";
    } else if (role === "ta") {
      text =
        "➕ O'quvchi qo'shish:\n" +
        "Kelgan o'quvchini davomatga qo'shish uchun '➕ O'quvchi qo'shish' tugmasini bosing.\n\n" +
        "Har qanday vaziyat uchun: /start\n\n" +
        "Shikoyat va takliflar uchun: @mv_nuriddin";
    } else if (role === "mentor_ta") {
      text =
        "📣 O'quvchi chaqirish:\n" +
        "Darsga kelmagan o'quvchini chaqirish uchun '📣 O'quvchi chaqirish' tugmasini bosing va ko'rsatmalarga amal qiling.\n\n" +
        "💬 Murojat:\n" +
        "Kuratorga o'quvchi bo'yicha murojat yuborish uchun '💬 Murojat' tugmasini bosing.\n\n" +
        "➕ O'quvchi qo'shish:\n" +
        "Kelgan o'quvchini davomatga qo'shish uchun '➕ O'quvchi qo'shish' tugmasini bosing.\n\n" +
        "Har qanday vaziyat uchun: /start\n\n" +
        "Shikoyat va takliflar uchun: @mv_nuriddin";
    } else {
      text =
        "ℹ️ Yordam:\n" +
        "Menyudagi tugmalar orqali ishlang.\n\n" +
        "Har qanday vaziyat uchun: /start\n\n" +
        "Shikoyat va takliflar uchun: @mv_nuriddin";
    }

    return ctx.reply(text, Markup.inlineKeyboard([
      Markup.button.callback("📨 Kuratorga xabar yuborish", "msg_kur")
    ]));
  });

  coddyBot.action("msg_kur", (ctx) => {
    ctx.answerCbQuery();
    return ctx.scene.enter("coddy_message_scene");
  });

  coddyBot.hears("📊 Hisobot", (ctx) => {
    if (!isAdmin(ctx)) return;
    return adminController.startReportFlow(ctx);
  });

  coddyBot.hears("🔍 Qidiruv", (ctx) => {
    if (!isAdmin(ctx)) return;
    return ctx.scene.enter("coddy_search_scene");
  });

  coddyBot.hears("🔙 Orqaga", (ctx) =>
    ctx.reply("Asosiy menyu", {
      reply_markup: {
        keyboard: getMainKeyboard(ctx),
        resize_keyboard: true
      }
    })
  );

  // Kurator "Javob yozish" tugmasini bosganida
  coddyBot.action(/^kr:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Javob yozish...");
    const replyTo = ctx.match[1];
    return ctx.scene.enter("kurator_reply_scene", { replyTo });
  });

  coddyBot.action(/^coddy_delete_mark_(.+)$/, teacherController.deleteMark);
  coddyBot.action(/^coddy_edit_mark_(.+)$/, teacherController.editMark);
  coddyBot.action(/^coddy_delete_call_(.+)$/, teacherController.deleteCallRecord);
  coddyBot.action(/^coddy_confirm_del_call_(.+)$/, teacherController.confirmDeleteCallRecord);
  coddyBot.action(/^coddy_cancel_del_call_(.+)$/, teacherController.cancelDeleteCallRecord);

  // ── Support: mentorlar ro'yxati ────────────────────────────────────────────
  coddyBot.hears("👥 Mentorlar", async (ctx) => {
    if (!isSupport(ctx)) return;

    try {
      const Group = require("../models/Group");
      const Student = require("../models/Student");

      const mentors = await User.find({
        role: { $in: ["mentor", "mentor_ta"] },
        isActive: true
      }).sort({ kuratorId: 1, fullName: 1 }).lean();

      if (!mentors.length) {
        return ctx.reply("Hozircha faol mentor yo'q.");
      }

      // Group by kuratorId
      const kuratorIds = [...new Set(mentors.map((m) => String(m.kuratorId)).filter(Boolean))];
      const kurators = await User.find({ _id: { $in: kuratorIds }, role: "kurator" })
        .select("fullName filials")
        .lean();
      const kuratorMap = Object.fromEntries(kurators.map((k) => [String(k._id), k]));

      // Group mentors by kurator
      const groups = new Map();
      const ungrouped = [];
      mentors.forEach((m) => {
        const kid = String(m.kuratorId || "");
        if (kid && kuratorMap[kid]) {
          if (!groups.has(kid)) groups.set(kid, { kurator: kuratorMap[kid], mentors: [] });
          groups.get(kid).mentors.push(m);
        } else {
          ungrouped.push(m);
        }
      });

      const { Markup } = require("telegraf");
      const sendGroup = async (kurator, mList) => {
        const filialText = kurator?.filials?.length ? ` • ${kurator.filials.join(", ")}` : "";
        const header = kurator
          ? `👤 *${kurator.fullName}*${filialText}\n`
          : `👤 *Kuratori yo'q*\n`;

        const lines = mList.map((m, i) => {
          const roleLabel = m.role === "mentor_ta" ? "Mentor+TA" : "Mentor";
          const phone = m.phone || "—";
          return `${i + 1}. ${m.fullName} _(${roleLabel})_ — ${phone}`;
        });

        const inlineRows = mList.map((m) =>
          [Markup.button.callback(`🔑 ${m.fullName}`, `sup_reset_pw_${m._id}`)]
        );

        await ctx.reply(header + lines.join("\n"), {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard(inlineRows).reply_markup
        });
      };

      for (const { kurator, mentors: mList } of groups.values()) {
        await sendGroup(kurator, mList);
      }
      if (ungrouped.length) {
        await sendGroup(null, ungrouped);
      }
    } catch (err) {
      console.error("[bot] 👥 Mentorlar error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: kurator statistikasi ─────────────────────────────────────────
  coddyBot.hears("📊 Statistika", async (ctx) => {
    if (!isSupport(ctx)) return;

    try {
      const Group = require("../models/Group");
      const Student = require("../models/Student");

      const kurators = await User.find({ role: "kurator", isActive: true })
        .select("fullName filials")
        .lean();

      if (!kurators.length) {
        return ctx.reply("Hozircha faol kurator yo'q.");
      }

      const lines = ["📊 *Kurator statistikasi*\n"];
      for (const k of kurators) {
        const kuratorId = k._id;
        const [groupCount, studentCount, mentorCount] = await Promise.all([
          Group.countDocuments({ kuratorId }),
          Student.countDocuments({ kuratorId, isActive: true }),
          User.countDocuments({ kuratorId, role: { $in: ["mentor", "mentor_ta", "ta"] }, isActive: true })
        ]);
        const filialText = k.filials?.length ? ` _(${k.filials.join(", ")})_` : "";
        lines.push(
          `👤 *${k.fullName}*${filialText}\n` +
          `  • Guruhlar: ${groupCount}\n` +
          `  • O'quvchilar: ${studentCount}\n` +
          `  • Xodimlar: ${mentorCount}`
        );
      }

      await ctx.reply(lines.join("\n\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[bot] 📊 Statistika error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: mentor parolini tiklash callback ──────────────────────────────
  coddyBot.action(/^sup_reset_pw_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    if (!isSupport(ctx)) {
      return ctx.answerCbQuery("Sizda bu amalni bajarish huquqi yo'q", { show_alert: true });
    }

    const mentorId = ctx.match[1];
    try {
      const mentor = await User.findOne({ _id: mentorId, role: { $in: ["mentor", "mentor_ta"] } });
      if (!mentor) {
        return ctx.reply("❌ Mentor topilmadi.");
      }

      mentor.password = "1234";
      await mentor.save();

      await ctx.reply(
        `✅ *${mentor.fullName}* paroli *1234* ga tiklandi.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("[bot] sup_reset_pw error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: approve / reject kurator registration ─────────────────────────
  coddyBot.action(/^sup_approve_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const kuratorId = ctx.match[1];

    // Only support can use this button
    const support = await findSupportByTelegramId(String(ctx.from.id));
    if (!support) {
      return ctx.answerCbQuery("Sizda bu amalni bajarish huquqi yo'q", { show_alert: true });
    }

    try {
      const kurator = await User.findOne({ _id: kuratorId, role: "kurator", registrationStatus: "pending" });
      if (!kurator) {
        return ctx.editMessageText("⚠️ Bu so'rov allaqachon ko'rib chiqilgan yoki topilmadi.", { parse_mode: "Markdown" });
      }

      kurator.registrationStatus = "approved";
      kurator.isActive = true;
      await kurator.save();

      // Notify kurator
      if (kurator.telegramId) {
        try {
          await coddyBot.telegram.sendMessage(
            Number(kurator.telegramId),
            [`✅ *Tabriklaymiz, ${kurator.fullName}!*`, ``, `Kurator so'rovingiz *qabul qilindi*.`, `Endi CoddyCheck tizimiga kirishingiz mumkin.`].join("\n"),
            { parse_mode: "Markdown" }
          );
        } catch (_) {}
      }

      await ctx.editMessageText(
        [`✅ *Qabul qilindi*`, ``, `👤 ${kurator.fullName}`, `📱 ${kurator.phone}`, ``, `Kuratorga xabar yuborildi.`].join("\n"),
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("[bot] sup_approve error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  coddyBot.action(/^sup_reject_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const kuratorId = ctx.match[1];

    // Only support can use this button
    const support = await findSupportByTelegramId(String(ctx.from.id));
    if (!support) {
      return ctx.answerCbQuery("Sizda bu amalni bajarish huquqi yo'q", { show_alert: true });
    }

    try {
      const kurator = await User.findOne({ _id: kuratorId, role: "kurator", registrationStatus: "pending" });
      if (!kurator) {
        return ctx.editMessageText("⚠️ Bu so'rov allaqachon ko'rib chiqilgan yoki topilmadi.", { parse_mode: "Markdown" });
      }

      const { telegramId, fullName, phone } = kurator;
      await User.findByIdAndDelete(kuratorId);

      // Notify kurator
      if (telegramId) {
        try {
          await coddyBot.telegram.sendMessage(
            Number(telegramId),
            [`❌ *${fullName}, so'rovingiz rad etildi.*`, ``, `Kurator ro'yxatdan o'tish so'rovingiz qabul qilinmadi.`, `Qo'shimcha ma'lumot uchun support bilan bog'laning.`].join("\n"),
            { parse_mode: "Markdown" }
          );
        } catch (_) {}
      }

      await ctx.editMessageText(
        [`❌ *Rad etildi*`, ``, `👤 ${fullName}`, `📱 ${phone}`, ``, `Kurator o'chirildi, xabar yuborildi.`].join("\n"),
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("[bot] sup_reject error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  startCoddyDailyReport(coddyBot);

  try {
    if (env.nodeEnv === "production" && env.coddyPublicUrl) {
      const webhookUrl = `${env.coddyPublicUrl}/api/telegram/coddy`;
      await coddyBot.telegram.deleteWebhook({ drop_pending_updates: true });
      await coddyBot.telegram.setWebhook(webhookUrl);
      coddyMode = "webhook";
      console.log(`Coddy bot started in webhook mode: ${webhookUrl}`);
    } else {
      await coddyBot.telegram.deleteWebhook({ drop_pending_updates: true });
      await coddyBot.launch();
      coddyMode = "polling";
      console.log("Coddy bot started in polling mode");
    }
  } catch (error) {
    coddyBot = null;
    coddyMode = "failed";
    console.error("Failed to start Coddy bot:", error.message);
    return null;
  }

  return coddyBot;
}

async function handleCoddyWebhook(req, res) {
  if (!coddyBot) {
    return res.status(503).json({ success: false, message: "Coddy bot is not running" });
  }

  try {
    await coddyBot.handleUpdate(req.body, res);
  } catch (error) {
    console.error("Coddy webhook error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Coddy webhook failed" });
    }
  }

  return undefined;
}

function stopCoddyCheckBot(signal = "stop") {
  if (!coddyBot) return;
  coddyBot.stop(signal);
}

function getCoddyBotStatus() {
  return {
    enabled: Boolean(coddyBot),
    mode: coddyMode
  };
}

function getBotInstance() {
  return coddyBot;
}

module.exports = {
  startCoddyCheckBot,
  stopCoddyCheckBot,
  handleCoddyWebhook,
  getCoddyBotStatus,
  getBotInstance
};
