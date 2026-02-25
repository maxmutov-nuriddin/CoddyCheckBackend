const cron = require("node-cron");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const User = require("../../models/User");

let dailyReportTask = null;
let isSendingReport = false;

function normalizeTelegramId(value) {
  return String(value || "").trim();
}

function toComparableTelegramIds(value) {
  const raw = normalizeTelegramId(value);
  if (!raw) return [];
  const set = new Set([raw]);
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    set.add(String(asNumber));
  }
  return Array.from(set);
}

async function loadKuratorComparableIdSet() {
  const kurators = await User.find({
    role: "kurator",
    isActive: true,
    telegramId: { $nin: [null, ""] }
  })
    .select("telegramId")
    .lean();

  const set = new Set();
  kurators.forEach((kurator) => {
    toComparableTelegramIds(kurator.telegramId).forEach((id) => set.add(id));
  });
  return set;
}

function statusKey(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "keldi") return "keldi";
  if (s === "kelmadi") return "kelmadi";
  return "kutilmoqda";
}

// ── Admin uchun qisqacha hisobot (avvalgidek) ─────────────────────────────────
function buildTaSummaryReport(dateStr, records) {
  const statsByTa = new Map();

  for (const row of records) {
    const taName = String(row.teacherName || "Noma'lum TA").trim() || "Noma'lum TA";

    if (!statsByTa.has(taName)) {
      statsByTa.set(taName, { total: 0, keldi: 0, kelmadi: 0, kutilmoqda: 0 });
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

// ── Kurator uchun batafsil hisobot ───────────────────────────────────────────
function buildKuratorDetailedReport(dateStr, records) {
  const markRecords = records.filter(r => r.requestType === "mark");

  const lines = [
    `📅 <b>Kunlik hisobot — ${dateStr}</b>`,
    ""
  ];

  // Qo'shilgan o'quvchilar ro'yxati
  if (markRecords.length === 0) {
    lines.push("📝 Bugun o'quvchi qo'shilmagan.");
  } else {
    lines.push(`📝 <b>Bugun qo'shilgan o'quvchilar (${markRecords.length} ta):</b>`);
    lines.push("");
    markRecords.forEach((r, idx) => {
      lines.push(
        `${idx + 1}. <b>${r.studentName}</b>`,
        `   TA: ${r.teacherName || "—"}`,
        `   Vaqt: ${r.time || "--:--"}`,
        `   Mavzu: ${r.topic || "—"}`,
        `   Ustoz: ${r.mainTeacher || "—"}`
      );
      if (idx < markRecords.length - 1) lines.push("");
    });
  }

  // Mentor bo'yicha kelganlar statistikasi
  lines.push("");
  lines.push("👨‍🏫 <b>Mentor bo'yicha (Keldi):</b>");

  const mentorCountMap = new Map();
  markRecords
    .filter((r) => statusKey(r.status) === "keldi")
    .forEach((r) => {
      const name = String(r.mainTeacher || "Noma'lum mentor").trim() || "Noma'lum mentor";
      mentorCountMap.set(name, (mentorCountMap.get(name) || 0) + 1);
    });

  if (mentorCountMap.size === 0) {
    lines.push("— Ma'lumot yo'q");
  } else {
    const sorted = [...mentorCountMap.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([name, count], idx) => {
      lines.push(`${idx + 1}. ${name} — ${count} ta kelgan o'quvchi`);
    });
  }

  return lines.join("\n");
}

async function sendKuratorDailyReport(bot, dateStr, records) {
  const kurators = await User.find({
    role: "kurator",
    isActive: true,
    telegramId: { $nin: [null, ""] }
  }).lean();

  if (!kurators.length) return;

  const message = buildKuratorDetailedReport(dateStr, records);

  for (const kurator of kurators) {
    try {
      await bot.telegram.sendMessage(kurator.telegramId, message, { parse_mode: "HTML" });
    } catch (err) {
      console.error(`Failed to send kurator daily report to ${kurator.fullName}:`, err.message);
    }
  }
}

async function sendTaDailyStats(bot, dateStr, records) {
  const tas = await User.find({
    role: { $in: ["ta", "mentor_ta"] },
    isActive: true,
    telegramId: { $nin: [null, ""] }
  })
    .select("fullName telegramId role")
    .lean();

  if (!tas.length) return;

  const markRecords = records.filter((row) => row.requestType === "mark");
  const countByTeacherId = new Map();

  for (const row of markRecords) {
    const key = normalizeTelegramId(row.teacherId);
    if (!key) continue;
    countByTeacherId.set(key, (countByTeacherId.get(key) || 0) + 1);
  }

  for (const ta of tas) {
    const comparableIds = toComparableTelegramIds(ta.telegramId);
    let addedCount = 0;
    for (const id of comparableIds) {
      addedCount += countByTeacherId.get(id) || 0;
    }

    const text = [
      `📊 <b>20:00 TA statistikasi (${dateStr})</b>`,
      `Siz bugun <b>${addedCount}</b> ta o'quvchi qo'shdingiz.`
    ].join("\n");

    try {
      await bot.telegram.sendMessage(ta.telegramId, text, { parse_mode: "HTML" });
    } catch (error) {
      console.error(`Failed to send TA daily stats to ${ta.fullName}:`, error.message);
    }
  }
}

async function sendDailyReport(bot) {
  if (isSendingReport) return;
  isSendingReport = true;

  try {
    const now = DateTime.now().setZone(env.appTimezone);
    if (now.weekday === 7) return; // Skip Sunday
    const dateStr = now.toFormat("yyyy-MM-dd");
    const records = await CoddyAttendance.find({ date: dateStr }).sort({ teacherName: 1, time: 1, createdAt: 1 });

    // Admin uchun qisqacha hisobot:
    // Kuratorlar alohida batafsil hisobot oladi, shu sabab bu qisqa TA hisobot ularga yuborilmaydi.
    const kuratorIdSet = await loadKuratorComparableIdSet();
    const adminIds = [...new Set((env.coddyAdminIds || []).map(normalizeTelegramId).filter(Boolean))]
      .filter((id) => !toComparableTelegramIds(id).some((candidate) => kuratorIdSet.has(candidate)));
    if (adminIds.length) {
      const adminMessage = records.length
        ? buildTaSummaryReport(dateStr, records)
        : `📅 Kunlik hisobot (${dateStr})\n\nMa'lumot yo'q.`;

      for (const adminId of adminIds) {
        try {
          await bot.telegram.sendMessage(adminId, adminMessage);
        } catch (error) {
          console.error(`Failed to send daily TA report to ${adminId}:`, error.message);
        }
      }
    }

    // Kurator uchun batafsil hisobot
    await sendKuratorDailyReport(bot, dateStr, records);
    await sendTaDailyStats(bot, dateStr, records);

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
