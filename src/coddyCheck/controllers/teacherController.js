const { Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");

async function listMyMarks(ctx) {
  try {
    const teacherId = ctx.from.id;
    const records = await CoddyAttendance.find({ teacherId }).sort({ createdAt: -1 }).limit(10);

    if (!records.length) {
      return ctx.reply("Sizda hali yozuv yo'q.");
    }

    const today = DateTime.now().setZone("Asia/Tashkent").toFormat("yyyy-MM-dd");

    let message = "📓 So'nggi 10 ta yozuvingiz:\n\n";
    const buttons = [];

    records.forEach((row, index) => {
      message += `${index + 1}. ${row.date} ${row.time}\n`;
      message += `👤 ${row.studentName} (${row.studentGroup})\n`;
      message += `📚 ${row.topic}\n\n`;

      if (row.date === today) {
        buttons.push([
          Markup.button.callback("✏️ Tahrirlash", `coddy_edit_mark_${row._id}`),
          Markup.button.callback("❌ O'chirish", `coddy_delete_mark_${row._id}`)
        ]);
      }
    });

    message += "Faqat bugungi yozuvlarni tahrirlash/o'chirish mumkin.";
    return ctx.reply(message, Markup.inlineKeyboard(buttons));
  } catch (error) {
    console.error("listMyMarks error:", error);
    return ctx.reply("Yozuvlarni olishda xatolik yuz berdi.");
  }
}

async function deleteMark(ctx) {
  try {
    const markId = ctx.match[1];
    const record = await CoddyAttendance.findById(markId);

    if (!record) {
      return ctx.answerCbQuery("Yozuv topilmadi");
    }

    const today = DateTime.now().setZone("Asia/Tashkent").toFormat("yyyy-MM-dd");
    if (record.date !== today) {
      return ctx.answerCbQuery("Faqat bugungi yozuv o'chiriladi", { show_alert: true });
    }

    await CoddyAttendance.findByIdAndDelete(markId);

    const adminMessage = [
      "🗑 Yozuv o'chirildi",
      `Support: ${record.teacherName}`,
      `O'quvchi: ${record.studentName}`,
      `Guruh: ${record.studentGroup}`,
      `Sana: ${record.date}`
    ].join("\n");

    for (const adminId of env.coddyAdminIds) {
      try {
        await ctx.telegram.sendMessage(adminId, adminMessage);
      } catch (error) {
        console.error(`Failed to notify admin ${adminId}:`, error.message);
      }
    }

    await ctx.answerCbQuery("Yozuv o'chirildi");
    return ctx.editMessageText("✅ Yozuv muvaffaqiyatli o'chirildi.");
  } catch (error) {
    console.error("deleteMark error:", error);
    return ctx.answerCbQuery("O'chirishda xatolik");
  }
}

async function editMark(ctx) {
  try {
    const markId = ctx.match[1];
    const record = await CoddyAttendance.findById(markId);

    if (!record) {
      return ctx.answerCbQuery("Yozuv topilmadi");
    }

    const today = DateTime.now().setZone("Asia/Tashkent").toFormat("yyyy-MM-dd");
    if (record.date !== today) {
      return ctx.answerCbQuery("Faqat bugungi yozuv tahrirlanadi", { show_alert: true });
    }

    await ctx.answerCbQuery();
    return ctx.scene.enter("coddy_edit_scene", { markId });
  } catch (error) {
    console.error("editMark error:", error);
    return ctx.answerCbQuery("Xatolik");
  }
}

module.exports = {
  listMyMarks,
  deleteMark,
  editMark
};
