const cron = require("node-cron");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const { sendTelegramMessage } = require("../services/telegramService");
const { addDays, formatYMD, getDayBounds } = require("../utils/date");
const env = require("../config/env");
const { autoCloseUnmarkedAttendances } = require("../services/attendanceService");
const { loadActiveStaffForMatching, resolveMentorNameFromWorkers } = require("../coddyCheck/utils/mentorNameResolver");

function isSunday() {
  const now = new Date();
  const dayStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: env.appTimezone,
    weekday: "long"
  }).format(now);
  return dayStr === "Sunday";
}

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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dedupePlannedEntries(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = [
      String(entry.student || "").toLowerCase().trim(),
      String(entry.group || "").toLowerCase().trim()
    ].join("|");
    if (!map.has(key)) {
      map.set(key, entry);
      continue;
    }

    const existing = map.get(key);
    const existingTime = String(existing.time || "");
    const incomingTime = String(entry.time || "");
    if (incomingTime && (!existingTime || incomingTime < existingTime)) {
      map.set(key, entry);
    }
  }
  return Array.from(map.values());
}

function buildPlannedLines(entries) {
  return entries
    .map((entry, idx) => {
      const student = escapeHtml(entry.student || "Noma'lum");
      const group = escapeHtml(entry.group || "-");
      const time = escapeHtml(entry.time || "--:--");
      return `${idx + 1}. ${student} (${group}) - ${time}`;
    })
    .join("\n");
}

async function collectTodayPlannedEntries(dateInput) {
  const { start, end } = getDayBounds(dateInput);
  const dateStr = formatYMD(dateInput);

  const [webRows, botRows, staff] = await Promise.all([
    Attendance.find({
      date: { $gte: start, $lte: end },
      callStatus: "chaqirilgan"
    })
      .populate("studentId", "fullName")
      .populate("groupId", "name")
      .populate("mentorId", "fullName telegramId role")
      .lean(),
    CoddyAttendance.find({
      date: dateStr,
      requestType: { $in: ["call_extra", "keep"] },
      callConfirmed: true,
      status: "Kutilmoqda"
    }).lean(),
    loadActiveStaffForMatching()
  ]);

  const mentorByName = new Map(
    (staff || [])
      .filter((item) => item && item.telegramId && ["mentor", "mentor_ta"].includes(String(item.role || "").toLowerCase()))
      .map((item) => [String(item.fullName || "").trim().toLowerCase(), item])
  );

  const entries = [];

  for (const row of webRows) {
    entries.push({
      student: row.studentId?.fullName || "Noma'lum",
      group: row.groupId?.name || "-",
      time: row.time ? new Date(row.time).toTimeString().slice(0, 5) : "--:--",
      mentorName: row.mentorId?.fullName || "",
      mentorTelegramId: row.mentorId?.telegramId ? String(row.mentorId.telegramId) : ""
    });
  }

  for (const row of botRows) {
    const resolvedMentorName = resolveMentorNameFromWorkers(row.mainTeacher, staff);
    const mentorRecord = mentorByName.get(String(resolvedMentorName || "").trim().toLowerCase())
      || mentorByName.get(String(row.mainTeacher || "").trim().toLowerCase());

    entries.push({
      student: row.studentName || "Noma'lum",
      group: row.studentGroup || "-",
      time: row.time || "--:--",
      mentorName: mentorRecord?.fullName || resolvedMentorName || row.mainTeacher || "",
      mentorTelegramId: mentorRecord?.telegramId ? String(mentorRecord.telegramId) : ""
    });
  }

  return dedupePlannedEntries(entries);
}

async function sendMorningTodayExpectedDigest() {
  if (isSunday()) return { totalEntries: 0, taNotified: 0, mentorNotified: 0 };
  const today = new Date();
  const dateStr = formatYMD(today);
  const plannedEntries = await collectTodayPlannedEntries(today);

  if (plannedEntries.length === 0) {
    return { totalEntries: 0, taNotified: 0, mentorNotified: 0 };
  }

  const taUsers = await User.find({
    role: { $in: ["ta", "mentor_ta"] },
    isActive: true,
    telegramId: { $nin: [null, ""] }
  })
    .select("telegramId")
    .lean();

  const taText = [
    `📌 <b>Bugungi ro'yxat (${escapeHtml(dateStr)})</b>`,
    "Quyidagi o'quvchilar bugun kelishi kerak:",
    "",
    buildPlannedLines(plannedEntries)
  ].join("\n");

  let taNotified = 0;
  for (const user of taUsers) {
    try {
      await sendTelegramMessage({ telegramId: user.telegramId, text: taText });
      taNotified += 1;
    } catch (error) {
      console.error(`Failed to send 09:00 TA digest to ${user.telegramId}:`, error.message);
    }
  }

  const mentorMap = new Map();
  for (const entry of plannedEntries) {
    const chatId = String(entry.mentorTelegramId || "").trim();
    if (!chatId) continue;
    if (!mentorMap.has(chatId)) {
      mentorMap.set(chatId, []);
    }
    mentorMap.get(chatId).push(entry);
  }

  let mentorNotified = 0;
  for (const [chatId, entries] of mentorMap.entries()) {
    const text = [
      `📌 <b>Bugungi kutilgan o'quvchilar (${escapeHtml(dateStr)})</b>`,
      "Quyidagi o'quvchilaringiz bugun kelishi kerak:",
      "",
      buildPlannedLines(entries)
    ].join("\n");

    try {
      await sendTelegramMessage({ telegramId: chatId, text });
      mentorNotified += 1;
    } catch (error) {
      console.error(`Failed to send 09:00 mentor digest to ${chatId}:`, error.message);
    }
  }

  return {
    totalEntries: plannedEntries.length,
    taNotified,
    mentorNotified
  };
}

async function autoClosePendingBotCallsAndNotifyTeachers(dateInput) {
  const dateStr = formatYMD(dateInput);
  const pendingCalls = await CoddyAttendance.find({
    date: dateStr,
    requestType: { $in: ["call_extra", "keep"] },
    callConfirmed: true,
    status: "Kutilmoqda"
  })
    .sort({ teacherId: 1, createdAt: 1 })
    .lean();

  if (pendingCalls.length === 0) {
    return { updated: 0, notifiedTeachers: 0 };
  }

  const ids = pendingCalls.map((row) => row._id);
  await CoddyAttendance.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "Kelmadi" } }
  );

  const byTeacher = new Map();
  for (const row of pendingCalls) {
    const key = String(row.teacherId || "");
    if (!key) continue;
    if (!byTeacher.has(key)) {
      byTeacher.set(key, []);
    }
    byTeacher.get(key).push(row);
  }

  let notifiedTeachers = 0;
  for (const [teacherId, rows] of byTeacher.entries()) {
    const list = rows
      .map((row, idx) => {
        const student = escapeHtml(row.studentName || "Noma'lum");
        const group = escapeHtml(row.studentGroup || "-");
        const time = escapeHtml(row.time || "--:--");
        return `${idx + 1}. ${student} (${group}) - ${time}`;
      })
      .join("\n");

    const text = [
      "⚠️ <b>Bugungi chaqiruv yakunlandi</b>",
      "",
      `Sana: <b>${escapeHtml(dateStr)}</b>`,
      "Quyidagi chaqirilgan o'quvchilar kun davomida belgilanmadi, status avtomatik <b>Kelmadi</b> qilindi:",
      "",
      list
    ].join("\n");

    try {
      await sendTelegramMessage({
        telegramId: teacherId,
        text
      });
      notifiedTeachers += 1;
    } catch (error) {
      console.error(`Failed to notify teacher ${teacherId} about auto Kelmadi:`, error.message);
    }
  }

  return {
    updated: ids.length,
    notifiedTeachers
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
    .sort({ time: 1, createdAt: 1 })
    .lean();
}

async function sendReminderToTAs({ dateInput, hourTag, includeButtons }) {
  if (isSunday()) return;
  const attendances = await getCalledAttendancesByDate(dateInput);
  const tas = await User.find({ role: { $in: ["ta", "mentor_ta"] }, isActive: true, telegramId: { $ne: null } }).lean();

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

function formatTimeInAppTimezone(dateInput) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: env.appTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(dateInput));
}

async function sendPendingRequestReminderToKurators() {
  if (isSunday()) return;
  const pendingRequests = await CoddyAttendance.find({
    requestType: { $in: ["call_extra", "keep"] },
    callConfirmed: false,
    status: "Kutilmoqda"
  })
    .sort({ createdAt: 1 })
    .lean();

  if (pendingRequests.length === 0) return;

  const kurators = await User.find({
    role: "kurator",
    isActive: true,
    telegramId: { $nin: [null, ""] }
  }).lean();

  const recipientIds = new Set();
  for (const kurator of kurators) {
    const chatId = String(kurator.telegramId || "").trim();
    if (chatId) recipientIds.add(chatId);
  }
  for (const adminId of env.coddyAdminIds || []) {
    const chatId = String(adminId || "").trim();
    if (chatId) recipientIds.add(chatId);
  }

  if (recipientIds.size === 0) return;

  const previewRows = pendingRequests.slice(0, 30).map((row, idx) => {
    const student = escapeHtml(row.studentName || "Noma'lum");
    const group = escapeHtml(row.studentGroup || "-");
    const requester = escapeHtml(row.teacherName || "Noma'lum");
    const createdTime = escapeHtml(formatTimeInAppTimezone(row.createdAt));
    return `${idx + 1}. ${student} (${group}) - ${requester} [${createdTime}]`;
  });

  const hiddenCount = Math.max(pendingRequests.length - previewRows.length, 0);
  const text = [
    "<b>09:00 eslatma</b>",
    `So'rovda quyidagi o'quvchilar bor (${pendingRequests.length} ta):`,
    "",
    ...previewRows,
    hiddenCount > 0 ? `... va yana ${hiddenCount} ta so'rov` : "",
    "",
    "Iltimos, so'rovlarni tekshirib tasdiqlang yoki rad eting."
  ].filter(Boolean).join("\n");

  for (const chatId of recipientIds) {
    try {
      await sendTelegramMessage({ telegramId: chatId, text });
    } catch (error) {
      console.error(`Failed to send 09:00 request reminder to kurator ${chatId}:`, error.message);
    }
  }
}

async function notifyAbsentCalledStudents() {
  if (isSunday()) return;
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
  if (isSunday()) return;
  const users = await User.find({
    isActive: true,
    telegramId: { $nin: [null, ""] },
    role: { $in: ["mentor", "ta", "mentor_ta"] }
  }).lean();

  const timeTag = new Intl.DateTimeFormat("en-GB", {
    timeZone: env.appTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());

  for (const user of users) {
    const role = String(user.role || "").toLowerCase();
    const messages = [];

    if (role === "ta" || role === "mentor_ta") {
      messages.push(`⏰ ${timeTag}\nO'quvchilarni yozishni unutmang.`);
    }

    if (role === "mentor" || role === "mentor_ta") {
      messages.push(`⏰ ${timeTag}\nAgar chaqiradigan o'quvchilaringiz bo'lsa, ayting.`);
    }

    for (const text of messages) {
      try {
        await sendTelegramMessage({ telegramId: user.telegramId, text });
      } catch (err) {
        console.error(`Role reminder failed for ${user.fullName}:`, err.message);
      }
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
      const autoBotCloseResult = await autoClosePendingBotCallsAndNotifyTeachers(today);
      console.log("20:00 auto bot close result:", autoBotCloseResult);

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
      await sendPendingRequestReminderToKurators();
      const digestResult = await sendMorningTodayExpectedDigest();
      console.log("09:00 expected today digest:", digestResult);
    },
    { timezone: env.appTimezone }
  );

  // 09:00, 12:00, 15:00, 20:00 — role bo'yicha eslatmalar
  cron.schedule(
    "0 9,12,15,20 * * *",
    async () => {
      await sendMorningGreetings();
    },
    { timezone: env.appTimezone }
  );

  console.log("Attendance cron jobs started");
}

module.exports = startAttendanceJobs;
