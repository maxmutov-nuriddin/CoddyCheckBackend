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

  // ── Support: blok va parol kutish holati ──────────────────────────────────
  coddyBot.use(async (ctx, next) => {
    if (ctx.state.worker?.role !== "support") return next();

    const isLocked = ctx.session?.supportLocked;
    const awaitingReset = ctx.session?.awaitingResetFor;

    if (!isLocked && !awaitingReset) return next();

    const text = ctx.message?.text?.trim();

    // Matn emas (callback, sticker, va h.k.) — blok xabarini ko'rsat
    if (!text) {
      if (ctx.updateType === "callback_query") {
        await ctx.answerCbQuery("🔒 Bot bloklangan. Avval parolni kiriting.", { show_alert: true });
      }
      return ctx.reply("🔒 Bot bloklangan. Support parolini kiriting:");
    }

    // Parol xabarini chatdan o'chirish (xavfsizlik)
    try { await ctx.deleteMessage(); } catch (_) {}

    // Parolni tekshirish
    const support = await User.findById(ctx.state.worker._id).select("+password");
    if (!support) return ctx.reply("Foydalanuvchi topilmadi.");
    const valid = await support.comparePassword(text);

    if (isLocked) {
      if (valid) {
        ctx.session.supportLocked = false;
        return ctx.reply("✅ Bot qulfdan chiqdi. Davom eting.", {
          reply_markup: { keyboard: supportMainKeyboard, resize_keyboard: true }
        });
      }
      return ctx.reply("❌ Parol noto'g'ri. Qayta kiriting:");
    }

    if (awaitingReset) {
      if (valid) {
        const { mentorId, mentorName } = awaitingReset;
        ctx.session.awaitingResetFor = null;
        const mentor = await User.findOne({ _id: mentorId, role: { $in: ["mentor", "mentor_ta"] } });
        if (!mentor) return ctx.reply("❌ Mentor topilmadi.");
        mentor.password = "1234";
        await mentor.save();
        return ctx.reply(`✅ *${mentorName}* paroli *1234* ga tiklandi.`, { parse_mode: "Markdown" });
      }
      ctx.session.awaitingResetFor = null;
      ctx.session.supportLocked = true;
      return ctx.reply("❌ Parol noto'g'ri.\n\n🔒 Bot bloklandi. Qulfdan chiqarish uchun to'g'ri parolni kiriting:");
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
    const siteUrl = env.siteUrl;
    const siteLine = siteUrl ? `\n🌐 Sayt: ${siteUrl}` : "";

    if (role === "support") {
      return ctx.reply(
        "ℹ️ *Support yordam*\n\n" +
        "👥 *Mentorlar* — ro'yxat, kurator/filial ma'lumotlari, parol tiklash.\n\n" +
        "📊 *Statistika* — har bir kurator bo'yicha guruhlar, o'quvchilar va xodimlar soni.\n\n" +
        "Har qanday vaziyat uchun: /start" +
        siteLine + "\n" +
        "Muammo bo'lsa: @mv\\_nuriddin",
        { parse_mode: "Markdown", disable_web_page_preview: true }
      );
    }

    let text;
    if (role === "mentor") {
      text =
        "ℹ️ *Yordam*\n\n" +
        "📣 *O'quvchi chaqirish* — darsga kelmagan o'quvchini chaqirish.\n\n" +
        "💬 *Murojat* — kuratorga o'quvchi bo'yicha xabar yuborish.\n\n" +
        "Har qanday vaziyat uchun: /start" +
        siteLine + "\n" +
        "Shikoyat va takliflar: @mv\\_nuriddin";
    } else if (role === "ta") {
      text =
        "ℹ️ *Yordam*\n\n" +
        "➕ *O'quvchi qo'shish* — kelgan o'quvchini davomatga qo'shish.\n\n" +
        "Har qanday vaziyat uchun: /start\n" +
        "Shikoyat va takliflar: @mv\\_nuriddin";
    } else if (role === "mentor_ta") {
      text =
        "ℹ️ *Yordam*\n\n" +
        "📣 *O'quvchi chaqirish* — darsga kelmagan o'quvchini chaqirish.\n\n" +
        "💬 *Murojat* — kuratorga xabar yuborish.\n\n" +
        "➕ *O'quvchi qo'shish* — kelgan o'quvchini davomatga qo'shish.\n\n" +
        "Har qanday vaziyat uchun: /start" +
        siteLine + "\n" +
        "Shikoyat va takliflar: @mv\\_nuriddin";
    } else {
      text =
        "ℹ️ *Yordam*\n\n" +
        "Menyudagi tugmalar orqali ishlang.\n\n" +
        "Har qanday vaziyat uchun: /start" +
        siteLine + "\n" +
        "Shikoyat va takliflar: @mv\\_nuriddin";
    }

    return ctx.reply(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...( role !== "ta" ? { reply_markup: Markup.inlineKeyboard([
        Markup.button.callback("📨 Kuratorga xabar yuborish", "msg_kur")
      ]).reply_markup } : {})
    });
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

  // ── Support: kuratorlar ro'yxati ──────────────────────────────────────────
  coddyBot.hears("🧑‍💼 Kuratorlar", async (ctx) => {
    if (!isSupport(ctx)) return;
    try {
      const { Markup } = require("telegraf");
      const kurators = await User.find({ role: "kurator", isActive: true, registrationStatus: "approved" })
        .sort({ fullName: 1 })
        .lean();

      if (!kurators.length) return ctx.reply("Hozircha faol kurator yo'q.");

      const rows = kurators.map((k) => {
        const label = k.filials?.length ? `${k.fullName} (${k.filials.join(", ")})` : k.fullName;
        return [Markup.button.callback(label, `sup_kur_${k._id}`)];
      });

      await ctx.reply(`🧑‍💼 *Kuratorlar ro'yxati* (${kurators.length} ta)\n\nBirini tanlang:`, {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard(rows).reply_markup
      });
    } catch (err) {
      console.error("[bot] Kuratorlar error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: kurator batafsil ma'lumoti ────────────────────────────────────
  coddyBot.action(/^sup_kur_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isSupport(ctx)) return;
    try {
      const kuratorId = ctx.match[1];
      const kurator = await User.findById(kuratorId).lean();
      if (!kurator) return ctx.reply("Kurator topilmadi.");

      const joinDate = kurator.createdAt
        ? new Date(kurator.createdAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" })
        : "—";
      const statusText = kurator.isActive ? "✅ Faol" : "🔴 To'xtatilgan";
      const tgText = kurator.telegramId ? `✈️ ${kurator.telegramId}` : "✈️ Telegram ulanmagan";
      const filialsText = kurator.filials?.length
        ? kurator.filials.join(" · ")
        : "Filial belgilanmagan";

      const text = [
        `🧑‍💼 *${kurator.fullName}*`,
        ``,
        `📱 ${kurator.phone || "—"}`,
        tgText,
        ``,
        `📍 ${filialsText}`,
        ``,
        `📅 Ro'yxatdan: ${joinDate}`,
        `🔵 Status: ${statusText}`,
      ].join("\n");

      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[bot] sup_kur error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: mentorlar ro'yxati ────────────────────────────────────────────
  coddyBot.hears("👥 Mentorlar", async (ctx) => {
    if (!isSupport(ctx)) return;
    try {
      const { Markup } = require("telegraf");
      const mentors = await User.find({ role: { $in: ["mentor", "mentor_ta"] }, isActive: true })
        .sort({ fullName: 1 })
        .lean();

      if (!mentors.length) return ctx.reply("Hozircha faol mentor yo'q.");

      const rows = mentors.map((m) => {
        const roleTag = m.role === "mentor_ta" ? "M+TA" : "M";
        return [Markup.button.callback(`${roleTag} • ${m.fullName}`, `sup_mentor_${m._id}`)];
      });

      await ctx.reply(`👥 *Mentorlar ro'yxati* (${mentors.length} ta)\n\nBirini tanlang:`, {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard(rows).reply_markup
      });
    } catch (err) {
      console.error("[bot] Mentorlar error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: mentor batafsil ma'lumoti ────────────────────────────────────
  coddyBot.action(/^sup_mentor_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isSupport(ctx)) return;
    try {
      const { Markup } = require("telegraf");
      const mentorId = ctx.match[1];

      const mentor = await User.findOne({ _id: mentorId, role: { $in: ["mentor", "mentor_ta"] } }).lean();
      if (!mentor) return ctx.reply("Mentor topilmadi.");

      const kurator = mentor.kuratorId ? await User.findById(mentor.kuratorId).select("fullName filials").lean() : null;
      const roleLabel = mentor.role === "mentor_ta" ? "Mentor + TA" : "Mentor";

      const text = [
        `👤 *${mentor.fullName}*`,
        `🎭 Rol: ${roleLabel}`,
        `📱 Telefon: ${mentor.phone || "—"}`,
        `🧑‍💼 Kurator: ${kurator?.fullName || "—"}`,
        mentor.telegramId ? `✈️ Telegram ID: ${mentor.telegramId}` : null,
        `🔵 Status: ${mentor.isActive ? "Faol" : "Nofaol"}`,
      ].filter(Boolean).join("\n");

      await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔑 Parolni tiklash", `sup_ask_reset_${mentorId}`)]
        ]).reply_markup
      });
    } catch (err) {
      console.error("[bot] sup_mentor error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: parol tiklash — tasdiqlash so'rovi ────────────────────────────
  coddyBot.action(/^sup_ask_reset_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isSupport(ctx)) return;
    try {
      const { Markup } = require("telegraf");
      const mentorId = ctx.match[1];

      const mentor = await User.findOne({ _id: mentorId, role: { $in: ["mentor", "mentor_ta"] } }).lean();
      if (!mentor) return ctx.reply("Mentor topilmadi.");

      await ctx.reply(
        `⚠️ *${mentor.fullName}* parolini tiklashni tasdiqlaysizmi?\n\nParol *1234* ga o'zgartiriladi.`,
        {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback("✅ Ha", `sup_confirm_reset_${mentorId}`),
              Markup.button.callback("❌ Yo'q", "sup_cancel_reset"),
            ]
          ]).reply_markup
        }
      );
    } catch (err) {
      console.error("[bot] sup_ask_reset error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: parol tiklash — support parolini so'rash ────────────────────
  coddyBot.action(/^sup_confirm_reset_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isSupport(ctx)) return;
    try {
      const mentorId = ctx.match[1];
      const mentor = await User.findOne({ _id: mentorId, role: { $in: ["mentor", "mentor_ta"] } }).lean();
      if (!mentor) return ctx.reply("Mentor topilmadi.");

      ctx.session.awaitingResetFor = { mentorId, mentorName: mentor.fullName };

      await ctx.reply(
        `🔐 *${mentor.fullName}* parolini tiklash uchun\nsupport parolini kiriting:`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("[bot] sup_confirm_reset error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: parol tiklash — bekor qilish ─────────────────────────────────
  coddyBot.action("sup_cancel_reset", async (ctx) => {
    await ctx.answerCbQuery("Bekor qilindi");
    ctx.session.awaitingResetFor = null;
    await ctx.reply("❌ Tiklash bekor qilindi.");
  });

  // ── Support: TA lar ro'yxati ───────────────────────────────────────────────
  coddyBot.hears("🧑‍🏫 TA lar", async (ctx) => {
    if (!isSupport(ctx)) return;
    try {
      const { Markup } = require("telegraf");
      const tas = await User.find({ role: "ta", isActive: true })
        .sort({ fullName: 1 })
        .lean();

      if (!tas.length) return ctx.reply("Hozircha faol TA yo'q.");

      const rows = tas.map((t) => [
        Markup.button.callback(`TA • ${t.fullName}`, `sup_ta_${t._id}`)
      ]);

      await ctx.reply(`🧑‍🏫 *TA lar ro'yxati* (${tas.length} ta)\n\nBirini tanlang:`, {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard(rows).reply_markup
      });
    } catch (err) {
      console.error("[bot] TA lar error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: TA batafsil ma'lumoti ────────────────────────────────────────
  coddyBot.action(/^sup_ta_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isSupport(ctx)) return;
    try {
      const taId = ctx.match[1];
      const ta = await User.findOne({ _id: taId, role: "ta" }).lean();
      if (!ta) return ctx.reply("TA topilmadi.");

      const kurator = ta.kuratorId
        ? await User.findById(ta.kuratorId).select("fullName filials").lean()
        : null;

      const text = [
        `🧑‍🏫 *${ta.fullName}*`,
        `🎭 Rol: TA`,
        `📱 Telefon: ${ta.phone || "—"}`,
        `🧑‍💼 Kurator: ${kurator?.fullName || "—"}`,
        ta.telegramId ? `✈️ Telegram ID: ${ta.telegramId}` : null,
        `🔵 Status: ${ta.isActive ? "Faol" : "Nofaol"}`,
      ].filter(Boolean).join("\n");

      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[bot] sup_ta error:", err.message);
      await ctx.reply("Xatolik yuz berdi: " + err.message);
    }
  });

  // ── Support: kurator statistikasi ─────────────────────────────────────────
  coddyBot.hears("📊 Statistika", async (ctx) => {
    if (!isSupport(ctx)) return;

    try {
      const Group = require("../models/Group");
      const Student = require("../models/Student");
      const CalledStudent = require("../models/CalledStudent");
      const CoddyAttendance = require("./models/CoddyAttendance");

      const kurators = await User.find({ role: "kurator", isActive: true })
        .select("fullName filials _id")
        .lean();

      if (!kurators.length) {
        return ctx.reply("Hozircha faol kurator yo'q.");
      }

      const FROZEN_ST = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];
      const pad = (n) => String(n).padStart(2, "0");
      const now = new Date();
      const monthStartStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const monthEndStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      const normalize  = (n) => n.toLowerCase().replace(/[-\s]/g, "");

      // Load all groups and CoddyAttendance + CalledStudent in parallel
      const [allGroups, coddyRows, csRows] = await Promise.all([
        Group.find({}).select("name kuratorId").lean(),
        CoddyAttendance.aggregate([
          { $match: { date: { $gte: monthStartStr, $lte: monthEndStr }, studentGroup: { $nin: ["-", "–", "—", "", " "] } } },
          { $group: {
            _id: { $replaceAll: { input: { $replaceAll: { input: { $toLower: "$studentGroup" }, find: "-", replacement: "" } }, find: " ", replacement: "" } },
            total:   { $sum: { $cond: [{ $eq: ["$requestType", "mark"] }, 1, 0] } },
            called:  { $sum: { $cond: { if: { $and: [{ $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Kutilmoqda"] }] }, then: 1, else: 0 } } },
            came:    { $sum: { $cond: { if: { $and: [{ $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Keldi"] }] }, then: 1, else: 0 } } },
            notCame: { $sum: { $cond: { if: { $and: [{ $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Kelmadi"] }] }, then: 1, else: 0 } } },
          }}
        ]),
        CalledStudent.aggregate([
          { $match: { date: { $gte: monthStart, $lte: monthEnd }, kuratorId: { $ne: null }, lastStatus: { $in: ["keldi", "kelmadi"] } } },
          { $group: { _id: "$kuratorId",
            came:    { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] },   1, 0] } },
            notCame: { $sum: { $cond: [{ $eq: ["$lastStatus", "kelmadi"] }, 1, 0] } },
            called:  { $sum: 1 }
          }}
        ]),
      ]);

      // Build group→kuratorId map
      const groupToKurator = new Map();
      for (const g of allGroups) {
        if (g.kuratorId) groupToKurator.set(normalize(g.name), g.kuratorId.toString());
      }

      // Build attMap per kuratorId
      const attMap = new Map();
      for (const row of coddyRows) {
        const kid = groupToKurator.get(row._id);
        if (!kid) continue;
        const prev = attMap.get(kid) || { total: 0, called: 0, came: 0, notCame: 0 };
        prev.total += row.total; prev.called += row.called;
        prev.came += row.came;  prev.notCame += row.notCame;
        attMap.set(kid, prev);
      }
      for (const row of csRows) {
        const kid = String(row._id);
        const prev = attMap.get(kid) || { total: 0, called: 0, came: 0, notCame: 0 };
        prev.came += row.came; prev.notCame += row.notCame; prev.called += row.called;
        attMap.set(kid, prev);
      }

      const SEP = "━━━━━━━━━━━━━━━━━━━━━━";
      const lines = [`📊 *Kurator statistikasi*\n${SEP}`];
      for (const k of kurators) {
        const kuratorId = k._id;
        const [activeStudents, leadStudents, allStudents, totalGroups, totalWorkers, goodStudents, averageStudents, poorStudents] = await Promise.all([
          Student.countDocuments({ kuratorId, isActive: true, frozenStatus: { $nin: [...FROZEN_ST, "lead"] } }),
          Student.countDocuments({ kuratorId, isActive: true, frozenStatus: "lead" }),
          Student.countDocuments({ kuratorId, isActive: true }),
          Group.countDocuments({ kuratorId }),
          User.countDocuments({ kuratorId, role: { $in: ["mentor", "mentor_ta", "ta"] }, isActive: true }),
          Student.countDocuments({ kuratorId, isActive: true, frozenStatus: "good" }),
          Student.countDocuments({ kuratorId, isActive: true, frozenStatus: "average" }),
          Student.countDocuments({ kuratorId, isActive: true, frozenStatus: "poor" }),
        ]);

        const inactiveStudents = allStudents - activeStudents - leadStudents;
        const att = attMap.get(String(kuratorId)) || { total: 0, called: 0, came: 0, notCame: 0 };
        const resolved = att.came + att.notCame;
        const rate = resolved > 0 ? Math.round((att.came / resolved) * 100) : null;

        const filialText = k.filials?.length ? `\n📍 ${k.filials.join(" · ")}` : "";
        const attLine = rate !== null
          ? `📅 ${att.total} belgi | ✅${att.came} ❌${att.notCame} | 📈${rate}%`
          : `📅 Ma'lumot yo'q`;

        lines.push(
          `👤 *${k.fullName}*${filialText}\n` +
          `🏫 ${totalGroups} guruh  👥 ${totalWorkers} xodim\n` +
          `✅${activeStudents} 🏆${leadStudents} 🚫${inactiveStudents} 📋${allStudents} ta o'q.\n` +
          `🟢${goodStudents} Yaxshi  🟡${averageStudents} O'rtacha  🔴${poorStudents} Yomon\n` +
          attLine +
          `\n${SEP}`
        );
      }

      const chunks = lines.join("\n\n").match(/[\s\S]{1,4000}/g) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      }
    } catch (err) {
      console.error("[bot] 📊 Statistika error:", err.message);
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
