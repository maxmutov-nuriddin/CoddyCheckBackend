const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const CoddyAttendance = require("../models/CoddyAttendance");
const { getWorkerMainKeyboard } = require("../keyboards");
const teacherController = require("../controllers/teacherController");

const { WizardScene } = Scenes;

// TA / mentor_ta: barcha opsiyalar
const SETTINGS_KEYBOARD = Markup.keyboard([
  ["Mening yozuvlarim", "TA statistikasi"],
  ["O'chirish", "Tarix"],
  ["Orqaga"]
]).resize();

// Mentor: faqat chaqirish bo'limlari
const MENTOR_SETTINGS_KEYBOARD = Markup.keyboard([
  ["O'chirish", "Tarix"],
  ["Orqaga"]
]).resize();

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSettingsKeyboard(role) {
  return role === "mentor" ? MENTOR_SETTINGS_KEYBOARD : SETTINGS_KEYBOARD;
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
  const stats = await CoddyAttendance.aggregate([
    { $match: { requestType: "mark" } },
    { $group: { _id: "$teacherName", count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);

  if (!stats.length) {
    await ctx.reply("Hali statistika yo'q.", SETTINGS_KEYBOARD);
    return;
  }

  const myRecord = await CoddyAttendance.findOne({ teacherId: ctx.from.id }).lean();
  const myName = myRecord?.teacherName?.toLowerCase();
  const lines = ["<b>TA statistikasi - jami qo'shilgan o'quvchilar:</b>\n"];

  stats.forEach((s, i) => {
    const prefix = `${i + 1}.`;
    const rawName = s?._id || "Noma'lum";
    const safeName = escapeHtml(rawName);
    const isMe = myName && String(rawName).toLowerCase() === myName;
    const marker = isMe ? " <b>← Siz</b>" : "";
    lines.push(`${prefix} ${safeName} - <b>${s.count}</b> ta${marker}`);
  });

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: SETTINGS_KEYBOARD.reply_markup });
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
    await ctx.reply("Tarix bo'sh.");
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

  await ctx.reply(`📅 <b>Tarix — so'nggi ${days.length} kun:</b>`, { parse_mode: "HTML" });

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

    if (text === "Orqaga") {
      await ctx.reply("Asosiy menyu", Markup.keyboard(getWorkerMainKeyboard(role)).resize());
      return ctx.scene.leave();
    }

    if (text === "Mening yozuvlarim") {
      try {
        await showMyMarks(ctx);
      } catch (err) {
        console.error("showMyMarks error:", err);
        await ctx.reply("Yozuvlarni olishda xatolik.");
      }
      await ctx.reply("Asosiy menyu", Markup.keyboard(getWorkerMainKeyboard(role)).resize());
      return ctx.scene.leave();
    }

    if (text === "TA statistikasi") {
      try {
        await showTaStats(ctx);
      } catch (err) {
        console.error("showTaStats error:", err);
        await ctx.reply("Statistikani olishda xatolik.", getSettingsKeyboard(role));
      }
      return;
    }

    if (text === "O'chirish") {
      try {
        await showDeleteSection(ctx);
      } catch (err) {
        console.error("showDeleteSection error:", err);
        await ctx.reply("O'chirish bo'limida xatolik.", getSettingsKeyboard(role));
      }
      return;
    }

    if (text === "Tarix") {
      try {
        await showTarix(ctx);
      } catch (err) {
        console.error("showTarix error:", err);
        await ctx.reply("Tarixni olishda xatolik.", getSettingsKeyboard(role));
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

module.exports = settingsScene;
