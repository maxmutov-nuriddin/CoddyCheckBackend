const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const CoddyAttendance = require("../models/CoddyAttendance");
const { getWorkerMainKeyboard } = require("../keyboards");

const { WizardScene } = Scenes;

const SETTINGS_KEYBOARD = Markup.keyboard([
  ["Mening yozuvlarim", "TA statistikasi"],
  ["Orqaga"]
]).resize();

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
    const isMe = myName && s._id?.toLowerCase() === myName;
    const marker = isMe ? " <b><- Siz</b>" : "";
    lines.push(`${prefix} ${s._id || "Noma'lum"} - <b>${s.count}</b> ta${marker}`);
  });

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: SETTINGS_KEYBOARD.reply_markup });
}

const settingsScene = new WizardScene(
  "coddy_settings_scene",
  async (ctx) => {
    const role = String(ctx.state?.worker?.role || "").toLowerCase();

    if (role === "mentor") {
      await ctx.reply("Tez kunda", Markup.keyboard(getWorkerMainKeyboard(role)).resize());
      return ctx.scene.leave();
    }

    await ctx.reply("Sozlamalar", SETTINGS_KEYBOARD);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const text = ctx.message?.text;

    if (text === "Orqaga") {
      const role = ctx.state?.worker?.role;
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
      const role = ctx.state?.worker?.role;
      await ctx.reply("Asosiy menyu", Markup.keyboard(getWorkerMainKeyboard(role)).resize());
      return ctx.scene.leave();
    }

    if (text === "TA statistikasi") {
      try {
        await showTaStats(ctx);
      } catch (err) {
        console.error("showTaStats error:", err);
        await ctx.reply("Statistikani olishda xatolik.", SETTINGS_KEYBOARD);
      }
      return;
    }

    return ctx.reply("Menyudan tanlang.", SETTINGS_KEYBOARD);
  }
);

module.exports = settingsScene;
