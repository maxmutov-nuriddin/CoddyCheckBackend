const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const CoddyAttendance = require("../models/CoddyAttendance");
const { getWorkerMainKeyboard } = require("../keyboards");
const teacherController = require("../controllers/teacherController");

const { WizardScene } = Scenes;
const MENU_MY_MARKS = "Mening yozuvlarim";
const MENU_TA_STATS = "TA statistikasi";
const MENU_DELETE_CALLS = "Chaqiruvni o'chirish";
const MENU_CALL_HISTORY = "Chaqiruvlar tarixi";
const MENU_BACK = "Orqaga";
const LEGACY_DELETE_CALLS = "O'chirish";
const LEGACY_CALL_HISTORY = "Tarix";

// Mentor+TA: barcha opsiyalar
const MENTOR_TA_SETTINGS_KEYBOARD = Markup.keyboard([
  [MENU_MY_MARKS, MENU_TA_STATS],
  [MENU_DELETE_CALLS, MENU_CALL_HISTORY],
  [MENU_BACK]
]).resize();

// TA: faqat TA bo'limlari
const TA_SETTINGS_KEYBOARD = Markup.keyboard([
  [MENU_MY_MARKS, MENU_TA_STATS],
  [MENU_BACK]
]).resize();

// Mentor: faqat chaqirish bo'limlari
const MENTOR_SETTINGS_KEYBOARD = Markup.keyboard([
  [MENU_DELETE_CALLS, MENU_CALL_HISTORY],
  [MENU_BACK]
]).resize();

const FALLBACK_SETTINGS_KEYBOARD = Markup.keyboard([[MENU_BACK]]).resize();

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TA_STATS_PERIOD_KEYBOARD = Markup.inlineKeyboard([
  [
    Markup.button.callback("📅 Bugunlik", "coddy_ta_stats_daily"),
    Markup.button.callback("📆 Haftalik", "coddy_ta_stats_weekly"),
  ],
  [
    Markup.button.callback("🗓 Oylik", "coddy_ta_stats_monthly"),
    Markup.button.callback("📊 Jami", "coddy_ta_stats_all"),
  ]
]);

async function buildTaStatsText(teacherId, period) {
  const now = DateTime.now().setZone("Asia/Tashkent");

  let matchQuery = { requestType: "mark" };
  let periodLabel;

  if (period === "daily") {
    const today = now.toFormat("yyyy-MM-dd");
    matchQuery.date = today;
    periodLabel = `Bugunlik — ${now.toFormat("dd.MM.yyyy")}`;
  } else if (period === "weekly") {
    const weekStart = now.startOf("week");
    const weekEnd = now.endOf("week");
    matchQuery.date = { $gte: weekStart.toFormat("yyyy-MM-dd"), $lte: weekEnd.toFormat("yyyy-MM-dd") };
    periodLabel = `Haftalik — ${weekStart.toFormat("dd.MM")}–${weekEnd.toFormat("dd.MM.yyyy")}`;
  } else if (period === "monthly") {
    const monthStart = now.startOf("month");
    const monthEnd = now.endOf("month");
    matchQuery.date = { $gte: monthStart.toFormat("yyyy-MM-dd"), $lte: monthEnd.toFormat("yyyy-MM-dd") };
    periodLabel = `Oylik — ${monthStart.toFormat("dd.MM")}–${monthEnd.toFormat("dd.MM.yyyy")}`;
  } else {
    periodLabel = "Jami — barcha vaqt";
  }

  const [stats, myRecord] = await Promise.all([
    CoddyAttendance.aggregate([
      { $match: matchQuery },
      { $group: { _id: "$teacherName", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    CoddyAttendance.findOne({ teacherId }).lean()
  ]);

  const myName = myRecord?.teacherName?.toLowerCase();

  if (!stats.length) {
    return `<b>TA statistikasi — ${periodLabel}:</b>\n\nHali statistika yo'q.`;
  }

  const lines = [`<b>TA statistikasi — ${periodLabel}:</b>\n`];
  stats.forEach((s, i) => {
    const rawName = s?._id || "Noma'lum";
    const safeName = escapeHtml(rawName);
    const isMe = myName && String(rawName).toLowerCase() === myName;
    const marker = isMe ? " <b>← Siz</b>" : "";
    lines.push(`${i + 1}. ${safeName} — <b>${s.count}</b> ta${marker}`);
  });

  return lines.join("\n");
}

function getSettingsKeyboard(role) {
  if (role === "mentor_ta") return MENTOR_TA_SETTINGS_KEYBOARD;
  if (role === "ta") return TA_SETTINGS_KEYBOARD;
  if (role === "mentor") return MENTOR_SETTINGS_KEYBOARD;
  return FALLBACK_SETTINGS_KEYBOARD;
}

function canUseMyMarks(role) {
  return role === "ta" || role === "mentor_ta";
}

function canUseTaStats(role) {
  return role === "ta" || role === "mentor_ta";
}

function canUseCallSections(role) {
  return role === "mentor" || role === "mentor_ta";
}

async function showMyMarks(ctx) {
  const teacherId = ctx.from.id;
  const records = await CoddyAttendance.find({ teacherId }).sort({ createdAt: -1 }).limit(10);

  if (!records.length) {
    await ctx.reply("Sizda hali yozuv yo'q.");
    return;
  }

  const today = DateTime.now().setZone("Asia/Tashkent").toFormat("yyyy-MM-dd");
  let message = "So'nggi 10 ta yozuvingiz:\n\n";
  const buttons = [];

  records.forEach((row, index) => {
    message += `${index + 1}. ${row.date} ${row.time}\n`;
    message += `O'quvchi: ${row.studentName} (${row.studentGroup})\n`;
    message += `Mavzu: ${row.topic}\n\n`;

    if (row.date === today) {
      buttons.push([
        Markup.button.callback("Tahrirlash", `coddy_edit_mark_${row._id}`),
        Markup.button.callback("O'chirish", `coddy_delete_mark_${row._id}`)
      ]);
    }
  });

  message += "Faqat bugungi yozuvlarni tahrirlash yoki o'chirish mumkin.";
  await ctx.reply(message, Markup.inlineKeyboard(buttons));
}

async function showTaStats(ctx) {
  const text = await buildTaStatsText(ctx.from.id, "daily");
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: TA_STATS_PERIOD_KEYBOARD.reply_markup
  });
}

async function showDeleteSection(ctx) {
  const teacherId = ctx.from.id;
  const records = await CoddyAttendance.find({
    teacherId,
    requestType: { $in: ["call_extra", "keep"] }
  }).sort({ createdAt: -1 }).limit(25).lean();

  if (!records.length) {
    await ctx.reply("Siz hali hech kimni chaqirmagansiz.");
    return;
  }

  const getDate = (r) =>
    r.date || (r.createdAt ? DateTime.fromJSDate(r.createdAt).setZone("Asia/Tashkent").toFormat("yyyy-MM-dd") : "-");

  const lines = ["🗑 <b>Chaqirilgan o'quvchilar:</b>\n"];
  records.forEach((r, i) => {
    const status = r.callConfirmed ? "✅" : "⏳";
    lines.push(`${i + 1}. ${status} ${escapeHtml(r.studentName)} — ${r.studentGroup || "-"} (${getDate(r)})`);
  });

  const buttons = records.map((r) => [
    Markup.button.callback(
      `❌ ${r.studentName} (${getDate(r)})`,
      `coddy_delete_call_${r._id}`
    )
  ]);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
  });
}

async function showTarix(ctx) {
  const teacherId = ctx.from.id;
  const records = await CoddyAttendance.find({
    teacherId,
    requestType: { $in: ["call_extra", "keep"] }
  }).sort({ date: -1, createdAt: -1 }).lean();

  if (!records.length) {
    await ctx.reply("Chaqiruvlar tarixi bo'sh.");
    return;
  }

  // Sanalar bo'yicha guruhlash (date yo'q bo'lsa createdAt dan olinadi)
  const getDay = (r) =>
    r.date || (r.createdAt ? DateTime.fromJSDate(r.createdAt).setZone("Asia/Tashkent").toFormat("yyyy-MM-dd") : "Noma'lum");

  const byDate = {};
  for (const r of records) {
    const day = getDay(r);
    if (!byDate[day]) byDate[day] = [];
    byDate[day].push(r);
  }

  const days = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).slice(0, 14);

  await ctx.reply(`📅 <b>Chaqiruvlar tarixi — so'nggi ${days.length} kun:</b>`, { parse_mode: "HTML" });

  for (const day of days) {
    const dayRecords = byDate[day];
    const pending = dayRecords.filter((r) => !r.callConfirmed);
    const confirmed = dayRecords.filter(
      (r) => r.callConfirmed && r.status !== "Keldi" && r.status !== "Kelmadi"
    );
    const keldi = dayRecords.filter((r) => r.status === "Keldi");

    const lines = [`📅 <b>${day}</b>`];

    if (pending.length) {
      lines.push(`\n⏳ Tasdiqlanmaganlar (${pending.length} ta):`);
      pending.forEach((r) => {
        lines.push(`  • ${escapeHtml(r.studentName)} (${r.studentGroup || "-"})`);
      });
    }

    if (confirmed.length) {
      lines.push(`\n✅ Tasdiqlangan (${confirmed.length} ta):`);
      confirmed.forEach((r) => {
        lines.push(`  • ${escapeHtml(r.studentName)} (${r.studentGroup || "-"})`);
      });
    }

    if (keldi.length) {
      lines.push(`\n🟢 Keldi (${keldi.length} ta):`);
      keldi.forEach((r) => {
        lines.push(`  • ${escapeHtml(r.studentName)} (${r.studentGroup || "-"})`);
      });
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }
}

const settingsScene = new WizardScene(
  "coddy_settings_scene",
  async (ctx) => {
    const role = String(ctx.state?.worker?.role || "").toLowerCase();
    await ctx.reply("Sozlamalar", getSettingsKeyboard(role));
    return ctx.wizard.next();
  },
  async (ctx, next) => {
    // Inline button callback queries — let scene-level action handlers deal with them
    if (ctx.callbackQuery) return next();

    const text = ctx.message?.text;
    const role = String(ctx.state?.worker?.role || "").toLowerCase();

    if (text === MENU_BACK) {
      await ctx.reply("Asosiy menyu", Markup.keyboard(getWorkerMainKeyboard(role)).resize());
      return ctx.scene.leave();
    }

    if (text === MENU_MY_MARKS) {
      if (!canUseMyMarks(role)) {
        await ctx.reply("Bu bo'lim sizning rolingiz uchun mavjud emas.", getSettingsKeyboard(role));
        return;
      }
      try {
        await showMyMarks(ctx);
      } catch (err) {
        console.error("showMyMarks error:", err);
        await ctx.reply("Yozuvlarni olishda xatolik.");
      }
      await ctx.reply("Asosiy menyu", Markup.keyboard(getWorkerMainKeyboard(role)).resize());
      return ctx.scene.leave();
    }

    if (text === MENU_TA_STATS) {
      if (!canUseTaStats(role)) {
        await ctx.reply("Bu bo'lim sizning rolingiz uchun mavjud emas.", getSettingsKeyboard(role));
        return;
      }
      try {
        await showTaStats(ctx);
      } catch (err) {
        console.error("showTaStats error:", err);
        await ctx.reply("Statistikani olishda xatolik.", getSettingsKeyboard(role));
      }
      return;
    }

    if (text === MENU_DELETE_CALLS || text === LEGACY_DELETE_CALLS) {
      if (!canUseCallSections(role)) {
        await ctx.reply("Bu bo'lim sizning rolingiz uchun mavjud emas.", getSettingsKeyboard(role));
        return;
      }
      try {
        await showDeleteSection(ctx);
      } catch (err) {
        console.error("showDeleteSection error:", err);
        await ctx.reply("Chaqiruvni o'chirish bo'limida xatolik.", getSettingsKeyboard(role));
      }
      return;
    }

    if (text === MENU_CALL_HISTORY || text === LEGACY_CALL_HISTORY) {
      if (!canUseCallSections(role)) {
        await ctx.reply("Bu bo'lim sizning rolingiz uchun mavjud emas.", getSettingsKeyboard(role));
        return;
      }
      try {
        await showTarix(ctx);
      } catch (err) {
        console.error("showTarix error:", err);
        await ctx.reply("Chaqiruvlar tarixini olishda xatolik.", getSettingsKeyboard(role));
      }
      return;
    }

    return ctx.reply("Menyudan tanlang.", getSettingsKeyboard(role));
  }
);

// Scene darajasida action handlerlar — scene ichida inline tugmalar ishlashi uchun
settingsScene.action(/^coddy_delete_call_(.+)$/, teacherController.deleteCallRecord);
settingsScene.action(/^coddy_confirm_del_call_(.+)$/, teacherController.confirmDeleteCallRecord);
settingsScene.action(/^coddy_cancel_del_call_(.+)$/, teacherController.cancelDeleteCallRecord);

// TA statistikasi davr tugmalari
settingsScene.action(/^coddy_ta_stats_(daily|weekly|monthly|all)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const periodKey = ctx.match[1];
  const period = periodKey === "all" ? null : periodKey;
  try {
    const text = await buildTaStatsText(ctx.from.id, period);
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: TA_STATS_PERIOD_KEYBOARD.reply_markup
    });
  } catch (err) {
    // message_not_modified yoki boshqa Telegram xatosi — yangi xabar yuborish
    if (!err.message?.includes("message is not modified")) {
      console.error("ta_stats edit error:", err);
    }
  }
});

module.exports = settingsScene;
