const CoddyAttendance = require("../models/CoddyAttendance");

function startReportFlow(ctx) {
  return ctx.scene.enter("coddy_report_scene");
}

async function showDays(ctx) {
  try {
    const days = await CoddyAttendance.distinct("date");
    days.sort((a, b) => b.localeCompare(a));
    const text = days.length ? days.slice(0, 20).join("\n") : "Yozuvlar yo'q";
    return ctx.reply(`📅 So'nggi kunlar:\n${text}`);
  } catch (error) {
    console.error("showDays error:", error);
    return ctx.reply("Kunlarni olishda xatolik.");
  }
}

async function showTeachers(ctx) {
  try {
    const teachers = await CoddyAttendance.aggregate([{ $group: { _id: "$teacherId", name: { $first: "$teacherName" } } }]);

    if (!teachers.length) {
      return ctx.reply("Aktiv supportlar topilmadi.");
    }

    const text = teachers.map((row) => `👤 ${row.name} (ID: ${row._id})`).join("\n");
    return ctx.reply(`📋 Supportlar:\n${text}`);
  } catch (error) {
    console.error("showTeachers error:", error);
    return ctx.reply("Supportlarni olishda xatolik.");
  }
}

module.exports = {
  startReportFlow,
  showDays,
  showTeachers
};
