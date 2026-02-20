const cron = require("node-cron");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const TaNotificationTask = require("../models/TaNotificationTask");
const { sendTelegramMessage } = require("../services/telegramService");
const { addDays, formatYMD, getDayBounds } = require("../utils/date");
const env = require("../config/env");
const { autoCloseUnmarkedAttendances } = require("../services/attendanceService");

function attendanceLine(row, idx) {
  const student = row.studentId?.fullName || "Deleted student";
  const group = row.groupId?.name || "-";
  const time = row.time ? new Date(row.time).toTimeString().slice(0, 5) : "--:--";
  return `${idx + 1}. ${student} (${group}) - ${time}`;
}

function buildInlineButtons(rows) {
  return {
    inline_keyboard: rows.slice(0, 10).map((row) => [
      { text: `Keldi: ${row.studentId?.fullName || "Student"}`, callback_data: `keldi:${row._id}` },
      { text: "Kelmadi", callback_data: `kelmadi:${row._id}` }
    ])
  };
}

async function getCalledAttendancesByDate(dateInput) {
  const { start, end } = getDayBounds(dateInput);

  return Attendance.find({
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan"
  })
    .populate("studentId", "fullName")
    .populate("groupId", "name")
    .sort({ time: 1, createdAt: 1 });
}

async function sendReminderToTAs({ dateInput, hourTag, includeButtons }) {
  const attendances = await getCalledAttendancesByDate(dateInput);
  const tas = await User.find({ role: { $in: ["ta", "mentor_ta"] }, isActive: true, telegramId: { $ne: null } });

  if (tas.length === 0 || attendances.length === 0) {
    return;
  }

  const dateLabel = formatYMD(dateInput);
  const title = `<b>${hourTag} reminder (${dateLabel})</b>`;
  const body = attendances.map(attendanceLine).join("\n");
  const text = `${title}\n\nChaqirilgan talabalar:\n${body}`;
  const replyMarkup = includeButtons ? buildInlineButtons(attendances) : null;

  for (const ta of tas) {
    try {
      await sendTelegramMessage({
        telegramId: ta.telegramId,
        text,
        replyMarkup
      });
    } catch (error) {
      console.error(`Telegram send failed for TA ${ta._id}: ${error.message}`);
    }
  }
}

async function sendScheduledTaNotifications() {
  const today = new Date();
  const { start, end } = getDayBounds(today);

  const tasks = await TaNotificationTask.find({
    status: "pending",
    date: { $gte: start, $lte: end }
  }).sort({ createdAt: 1 });

  for (const task of tasks) {
    const tas = await User.find({
      role: { $in: ["ta", "mentor_ta"] },
      isActive: true,
      telegramId: { $ne: null },
      $or: [{ specialization: { $in: [task.direction, "both"] } }, { specialization: { $exists: false } }]
    });

    const lines = [
      `<b>09:00 eslatma (${formatYMD(task.date)})</b>`,
      `Yo'nalish: ${task.direction.toUpperCase()}`,
      `O'quvchi: ${task.studentName}`,
      task.time ? `Kelish vaqti: ${task.time}` : "",
      task.comment ? `Izoh: ${task.comment}` : ""
    ].filter(Boolean);

    const text = lines.join("\n");
    let sentCount = 0;

    for (const ta of tas) {
      try {
        await sendTelegramMessage({ telegramId: ta.telegramId, text });
        sentCount += 1;
      } catch (error) {
        console.error(`Direction send failed for TA ${ta._id}: ${error.message}`);
      }
    }

    task.status = sentCount > 0 ? "sent" : "failed";
    task.sentAt = new Date();
    await task.save();
  }
}

async function notifyAbsentCalledStudents() {
  const today = new Date();
  const { start, end } = getDayBounds(today);

  // Find students called today but not marked as "keldi"
  const absentStudents = await Attendance.find({
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan",
    attendanceStatus: { $ne: "keldi" }
  })
    .populate("studentId", "fullName")
    .populate("groupId", "name")
    .populate("mentorId", "fullName telegramId");

  if (absentStudents.length === 0) {
    return;
  }

  // Group by mentor
  const byMentor = new Map();

  for (const record of absentStudents) {
    const mentorId = record.mentorId?._id?.toString();
    if (!mentorId) continue;

    if (!byMentor.has(mentorId)) {
      byMentor.set(mentorId, {
        mentor: record.mentorId,
        students: []
      });
    }

    byMentor.get(mentorId).students.push(record);
  }

  // Send notifications to mentors
  for (const [mentorId, data] of byMentor) {
    const { mentor, students } = data;

    if (!mentor.telegramId) {
      console.log(`Mentor ${mentor.fullName} has no telegramId, skipping notification`);
      continue;
    }

    const studentList = students
      .map((rec, idx) => {
        const student = rec.studentId?.fullName || "Unknown";
        const group = rec.groupId?.name || "-";
        const time = rec.time ? new Date(rec.time).toTimeString().slice(0, 5) : "--:--";
        return `${idx + 1}. ${student} (${group}) - ${time}`;
      })
      .join("\n");

    const text = [
      "⚠️ <b>Chaqirilgan talabalar kelmadi</b>",
      "",
      "Bugun siz chaqirgan ammo kelish belgilanmagan talabalar:",
      "",
      studentList,
      "",
      "Iltimos, tekshiring yoki qayta chaqiring."
    ].join("\n");

    try {
      await sendTelegramMessage({
        telegramId: mentor.telegramId,
        text
      });
    } catch (error) {
      console.error(`Failed to notify mentor ${mentor.fullName}:`, error.message);
    }
  }

  // TODO: Send notifications to curators via platform
  console.log(`Notified ${byMentor.size} mentors about ${absentStudents.length} absent students`);
}

async function sendMorningGreetings() {
  const users = await User.find({
    isActive: true,
    telegramId: { $nin: [null, ""] },
    role: { $in: ["mentor", "ta", "mentor_ta", "kurator"] }
  }).lean();

  for (const user of users) {
    let text;
    const role = user.role;

    if (role === "kurator") {
      text = "☀️ <b>Ishingizga omad!</b>";
    } else if (role === "ta") {
      text = "☀️ <b>Ishingizga omad!</b>\nO'quvchilarni yozishni unutmang!";
    } else {
      // mentor, mentor_ta
      text = "☀️ <b>Ishingizga omad!</b>\nAgar o'quvchilaringiz bo'lsa menga yozin.";
    }

    try {
      await sendTelegramMessage({ telegramId: user.telegramId, text });
    } catch (err) {
      console.error(`Morning greeting failed for ${user.fullName}:`, err.message);
    }
  }
}

function startAttendanceJobs() {
  cron.schedule(
    "0 20 * * *",
    async () => {
      const today = new Date();
      const { start, end } = getDayBounds(today);
      const autoCloseResult = await autoCloseUnmarkedAttendances(start, end);
      console.log("20:00 auto check result:", autoCloseResult);

      const tomorrow = addDays(today, 1);
      await sendReminderToTAs({
        dateInput: tomorrow,
        hourTag: "20:00",
        includeButtons: false
      });

      // Check for absent called students
      await notifyAbsentCalledStudents();
    },
    { timezone: env.appTimezone }
  );

  cron.schedule(
    "0 9 * * *",
    async () => {
      const today = new Date();
      await sendScheduledTaNotifications();
      await sendReminderToTAs({
        dateInput: today,
        hourTag: "09:00",
        includeButtons: true
      });
    },
    { timezone: env.appTimezone }
  );

  // 09:00 — Ertalabki salom xabarlari
  cron.schedule(
    "0 9 * * *",
    async () => {
      await sendMorningGreetings();
    },
    { timezone: env.appTimezone }
  );

  console.log("Attendance cron jobs started");
}

module.exports = startAttendanceJobs;

