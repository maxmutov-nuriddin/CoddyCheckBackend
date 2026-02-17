const cron = require("node-cron");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");

let dailyReportTask = null;
let isSendingReport = false;

function normalizeTelegramId(value) {
  return String(value || "").trim();
}

function statusKey(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "keldi") return "keldi";
  if (s === "kelmadi") return "kelmadi";
  return "kutilmoqda";
}

function buildTaSummaryReport(dateStr, records) {
  const statsByTa = new Map();

  for (const row of records) {
    const taName = String(row.teacherName || "Noma'lum TA").trim() || "Noma'lum TA";

    if (!statsByTa.has(taName)) {
      statsByTa.set(taName, {
        total: 0,
        keldi: 0,
        kelmadi: 0,
        kutilmoqda: 0
      });
    }

    const bucket = statsByTa.get(taName);
    bucket.total += 1;
    bucket[statusKey(row.status)] += 1;
  }

  const sorted = [...statsByTa.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [
    `📅 Kunlik hisobot (${dateStr})`,
    `Jami yozuv: ${records.length}`,
    "",
    "👥 TA bo'yicha:"
  ];

  if (sorted.length === 0) {
    lines.push("- Ma'lumot yo'q");
  } else {
    sorted.forEach(([taName, s], idx) => {
      lines.push(
        `${idx + 1}. ${taName}`,
        `   Jami: ${s.total} | Keldi: ${s.keldi} | Kelmadi: ${s.kelmadi} | Kutilmoqda: ${s.kutilmoqda}`
      );
    });
  }

  return lines.join("\n");
}

async function sendDailyReport(bot) {
  if (isSendingReport) {
    return;
  }

  isSendingReport = true;

  try {
    const dateStr = DateTime.now().setZone(env.appTimezone).toFormat("yyyy-MM-dd");
    const records = await CoddyAttendance.find({ date: dateStr }).sort({ teacherName: 1, time: 1, createdAt: 1 });

    const adminIds = [...new Set((env.coddyAdminIds || []).map(normalizeTelegramId).filter(Boolean))];
    if (!adminIds.length) {
      return;
    }

    const message = records.length
      ? buildTaSummaryReport(dateStr, records)
      : `📅 Kunlik hisobot (${dateStr})\n\nMa'lumot yo'q.`;

    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendMessage(adminId, message);
      } catch (error) {
        console.error(`Failed to send daily TA report to ${adminId}:`, error.message);
      }
    }
  } catch (error) {
    console.error("sendDailyReport error:", error);
  } finally {
    isSendingReport = false;
  }
}

function startCoddyDailyReport(bot) {
  if (dailyReportTask) {
    console.log("Coddy daily report cron already started");
    return dailyReportTask;
  }

  dailyReportTask = cron.schedule(
    "0 20 * * *",
    async () => {
      await sendDailyReport(bot);
    },
    { timezone: env.appTimezone }
  );

  console.log("Coddy daily report cron started (20:00)");
  return dailyReportTask;
}

module.exports = startCoddyDailyReport;
