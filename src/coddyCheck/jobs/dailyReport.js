const cron = require("node-cron");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const CoddyTeacher = require("../models/CoddyTeacher");

async function sendDailyReport(bot) {
  try {
    const dateStr = DateTime.now().setZone(env.appTimezone).toFormat("yyyy-MM-dd");

    const records = await CoddyAttendance.find({ date: dateStr }).sort({ teacherName: 1, studentGroup: 1, time: 1 });
    const adminIds = env.coddyAdminIds;

    if (!adminIds.length) {
      return;
    }

    if (!records.length) {
      for (const adminId of adminIds) {
        try {
          await bot.telegram.sendMessage(adminId, `📅 Bugungi hisobot (${dateStr})\nYozuv yo'q.`);
        } catch (error) {
          console.error(`Failed to send empty report to ${adminId}:`, error.message);
        }
      }
      return;
    }

    let report = `📅 Avtomatik hisobot (${dateStr})\n\n`;
    let currentGroup = null;

    records.forEach((row) => {
      if (currentGroup !== row.studentGroup) {
        currentGroup = row.studentGroup;
        report += `━━━━━━━━━━\n🏫 GURUH: ${row.studentGroup}\n━━━━━━━━━━\n\n`;
      }

      report += `🕒 ${row.time}\n`;
      report += `👤 O'quvchi: ${row.studentName}\n`;
      report += `📚 Mavzu: ${row.topic}\n`;
      report += `✌️ Support: ${row.teacherName}\n`;
      report += `👨‍🏫 Asosiy ustoz: ${row.mainTeacher}\n\n`;
    });

    for (const adminId of adminIds) {
      try {
        if (report.length > 4000) {
          const chunks = report.match(/[\s\S]{1,4000}/g) || [];
          for (const chunk of chunks) {
            await bot.telegram.sendMessage(adminId, chunk);
          }
        } else {
          await bot.telegram.sendMessage(adminId, report);
        }
      } catch (error) {
        console.error(`Failed to send full report to ${adminId}:`, error.message);
      }
    }

    const stats = records.reduce((acc, row) => {
      const key = row.teacherName || "Noma'lum";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const teachers = await CoddyTeacher.find({});
    for (const teacher of teachers) {
      if (adminIds.includes(teacher.telegramId)) continue;

      const count = stats[teacher.name] || 0;
      const message = `📊 Bugungi hisobot (${dateStr})\n\n✅ Siz ${count} ta o'quvchi belgiladingiz.`;

      try {
        await bot.telegram.sendMessage(teacher.telegramId, message);
      } catch (error) {
        console.error(`Failed to send teacher summary to ${teacher.telegramId}:`, error.message);
      }
    }
  } catch (error) {
    console.error("sendDailyReport error:", error);
  }
}

function startCoddyDailyReport(bot) {
  cron.schedule(
    "0 20 * * *",
    async () => {
      await sendDailyReport(bot);
    },
    { timezone: env.appTimezone }
  );

  console.log("Coddy daily report cron started (20:00)");
}

module.exports = startCoddyDailyReport;
