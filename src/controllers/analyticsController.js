const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/response");
const User = require("../models/User");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const CalledStudent = require("../models/CalledStudent");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const { formatYMD } = require("../utils/date");

const STAFF_ROLES = ["mentor", "ta", "mentor_ta"];
const FREEZE_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];
const MONTH_UZ = ["Yan", "Fev", "Mar", "Apr", "May", "Iyn", "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"];

async function buildKuratorExclusion() {
  const kurators = await User.find({ role: "kurator", isActive: true })
    .select("_id telegramId")
    .lean();

  const kuratorUserIds = kurators.map((u) => u._id);
  const kuratorTelegramIds = Array.from(new Set(
    kurators.flatMap((u) => {
      const raw = String(u?.telegramId || "").trim();
      if (!raw) return [];
      const asNumber = Number(raw);
      return Number.isFinite(asNumber) ? [asNumber, raw] : [raw];
    })
  ));

  return {
    attNonKuratorMatch: kuratorUserIds.length
      ? { mentorId: { $nin: kuratorUserIds }, taId: { $nin: kuratorUserIds } }
      : {},
    botNonKuratorMatch: {
      requesterRole: { $ne: "kurator" },
      ...(kuratorTelegramIds.length ? { teacherId: { $nin: kuratorTelegramIds } } : {})
    }
  };
}

function normalizeNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeName(value) {
  return normalizeNameKey(value)
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreNameMatch(workerName, sourceKey) {
  const a = normalizeNameKey(workerName);
  const b = normalizeNameKey(sourceKey);
  if (!a || !b || b === "noma'lum") return -1;
  if (a === b) return 1000;
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return 900;
  if (a.includes(` ${b} `) || b.includes(` ${a} `)) return 800;

  const aTokens = tokenizeName(a);
  const bTokens = tokenizeName(b);
  if (!aTokens.length || !bTokens.length) return -1;

  let matched = 0;
  for (const token of aTokens) {
    if (bTokens.some((k) => k === token || k.startsWith(token) || token.startsWith(k))) {
      matched += 1;
    }
  }

  if (!matched) return -1;
  return matched * 100 - Math.abs(aTokens.length - bTokens.length) * 5;
}

function findBestUnusedKey(workerName, keys, usedKeys) {
  let bestKey = null;
  let bestScore = -1;

  for (const key of keys) {
    if (usedKeys.has(key)) continue;
    const score = scoreNameMatch(workerName, key);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  return bestScore >= 100 ? bestKey : null;
}

const getAnalytics = asyncHandler(async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const attMatch = {};
    const botMatch = {};

    if (dateFrom || dateTo) {
      const start = dateFrom ? new Date(dateFrom) : null;
      const end = dateTo ? new Date(dateTo) : null;

      if (start || end) {
        attMatch.date = {};
        if (start) attMatch.date.$gte = start;
        if (end) attMatch.date.$lte = end;

        if (start) botMatch.date = { ...botMatch.date, $gte: formatYMD(start) };
        if (end) botMatch.date = { ...botMatch.date, $lte: formatYMD(end) };
      }
    }

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);
    const { attNonKuratorMatch, botNonKuratorMatch } = await buildKuratorExclusion();

    const [
      workers,
      totalStudents,
      statusAggResult,
      globalAttAgg,
      globalBotAgg,
      globalPlatformCallAgg,
      perMentorAttAgg,
      perMentorBotAgg,
      perMentorPlatformCallAgg,
      studentsByMentorAgg,
      taEntriesAgg,
      trendAgg,
      trendBotAgg,
      trendPlatformCallAgg
    ] = await Promise.all([
      User.find({ role: { $in: STAFF_ROLES }, isActive: true })
        .select("_id fullName role")
        .lean(),

      Student.countDocuments({ isActive: true }),

      Student.aggregate([
        { $match: { isActive: true } },
        {
          $group: {
            _id: null,
            good: { $sum: { $cond: [{ $eq: ["$frozenStatus", "good"] }, 1, 0] } },
            average: { $sum: { $cond: [{ $eq: ["$frozenStatus", "average"] }, 1, 0] } },
            lead: { $sum: { $cond: [{ $eq: ["$frozenStatus", "lead"] }, 1, 0] } },
            poor: { $sum: { $cond: [{ $eq: ["$frozenStatus", "poor"] }, 1, 0] } },
            freeze: { $sum: { $cond: [{ $in: ["$frozenStatus", FREEZE_STATUSES] }, 1, 0] } },
          }
        }
      ]),

      Attendance.aggregate([
        { $match: { ...attMatch, ...attNonKuratorMatch } },
        {
          $group: {
            _id: null,
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callStatus", "chaqirilgan"] }, { $eq: ["$attendanceStatus", "keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
          }
        }
      ]),

      CoddyAttendance.aggregate([
        { $match: { ...botMatch, ...botNonKuratorMatch } },
        {
          $group: {
            _id: null,
            invited: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$status", "Keldi"] }, 1, 0] } },
          }
        }
      ]),

      CalledStudent.aggregate([
        { $match: attMatch },
        {
          $group: {
            _id: null,
            invited: { $sum: "$callCount" },
            invitedAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } }
          }
        }
      ]),

      Attendance.aggregate([
        { $match: { ...attMatch, ...attNonKuratorMatch } },
        { $lookup: { from: "groups", localField: "groupId", foreignField: "_id", as: "grp" } },
        { $unwind: { path: "$grp", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$grp.mentor", "noma'lum"] } },
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callStatus", "chaqirilgan"] }, { $eq: ["$attendanceStatus", "keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
          }
        }
      ]),

      CoddyAttendance.aggregate([
        { $match: { ...botMatch, ...botNonKuratorMatch } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$mainTeacher", "noma'lum"] } },
            invited: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$status", "Keldi"] }, 1, 0] } },
          }
        }
      ]),

      CalledStudent.aggregate([
        { $match: attMatch },
        { $lookup: { from: "groups", localField: "groupId", foreignField: "_id", as: "grp" } },
        { $unwind: { path: "$grp", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$grp.mentor", "noma'lum"] } },
            invited: { $sum: "$callCount" },
            invitedAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } }
          }
        }
      ]),

      Student.aggregate([
        { $match: { isActive: true } },
        { $lookup: { from: "groups", localField: "groupId", foreignField: "_id", as: "grp" } },
        { $unwind: { path: "$grp", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$grp.mentor", "noma'lum"] } },
            groupList: { $addToSet: "$grp.name" },
            totalStudents: { $sum: 1 },
            good: { $sum: { $cond: [{ $eq: ["$frozenStatus", "good"] }, 1, 0] } },
            average: { $sum: { $cond: [{ $eq: ["$frozenStatus", "average"] }, 1, 0] } },
            lead: { $sum: { $cond: [{ $eq: ["$frozenStatus", "lead"] }, 1, 0] } },
            poor: { $sum: { $cond: [{ $eq: ["$frozenStatus", "poor"] }, 1, 0] } },
            freeze: { $sum: { $cond: [{ $in: ["$frozenStatus", FREEZE_STATUSES] }, 1, 0] } },
          }
        }
      ]),

      CoddyAttendance.aggregate([
        { $match: { ...botMatch, ...botNonKuratorMatch, requestType: "mark" } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$teacherName", "noma'lum"] } },
            count: { $sum: 1 }
          }
        }
      ]),

      Attendance.aggregate([
        { $match: { date: { $gte: sixMonthsAgo }, ...attNonKuratorMatch } },
        {
          $group: {
            _id: { month: { $month: "$date" }, year: { $year: "$date" } },
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callStatus", "chaqirilgan"] }, { $eq: ["$attendanceStatus", "keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $and: [{ $eq: ["$callStatus", "chaqirilgan"] }, { $eq: ["$attendanceStatus", "kelmadi"] }] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch((err) => {
        console.error("trendAgg error:", err);
        return [];
      }),

      CoddyAttendance.aggregate([
        { $match: { date: { $gte: formatYMD(sixMonthsAgo) }, ...botNonKuratorMatch } },
        { $addFields: { dateObj: { $dateFromString: { dateString: "$date", onError: new Date(0) } } } },
        {
          $group: {
            _id: { month: { $month: "$dateObj" }, year: { $year: "$dateObj" } },
            invited: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$status", "Keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Kelmadi"] }] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch((err) => {
        console.error("trendBotAgg error:", err);
        return [];
      }),

      CalledStudent.aggregate([
        { $match: { date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { month: { $month: "$date" }, year: { $year: "$date" } },
            invited: { $sum: "$callCount" },
            invitedAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ["$lastStatus", "kelmadi"] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch((err) => {
        console.error("trendPlatformCallAgg error:", err);
        return [];
      })
    ]);

    const statusCounts = statusAggResult.length > 0
      ? {
        good: statusAggResult[0].good,
        average: statusAggResult[0].average,
        lead: statusAggResult[0].lead,
        poor: statusAggResult[0].poor,
        freeze: statusAggResult[0].freeze
      }
      : { good: 0, average: 0, lead: 0, poor: 0, freeze: 0 };

    const gAtt = globalAttAgg[0] || { invited: 0, invitedAttended: 0, totalAttended: 0 };
    const gBot = globalBotAgg[0] || { invited: 0, invitedAttended: 0, totalAttended: 0 };
    const gPlatform = globalPlatformCallAgg[0] || { invited: 0, invitedAttended: 0, totalAttended: 0 };

    const totalInvited = (gAtt.invited || 0) + (gBot.invited || 0) + (gPlatform.invited || 0);
    const totalInvitedAttended = (gAtt.invitedAttended || 0) + (gBot.invitedAttended || 0) + (gPlatform.invitedAttended || 0);
    const totalAttended = (gAtt.totalAttended || 0) + (gBot.totalAttended || 0) + (gPlatform.totalAttended || 0);
    const mentorCount = workers.filter((w) => ["mentor", "mentor_ta"].includes(w.role)).length;

    const global = {
      totalMentors: mentorCount,
      totalStudents,
      totalInvited,
      totalAttended,
      attendancePct: totalInvited > 0 ? Math.min(Math.round((totalInvitedAttended / totalInvited) * 100), 100) : 0
    };

    const perMentorAttMap = new Map();
    perMentorAttAgg.forEach((r) => perMentorAttMap.set(r._id, r));
    perMentorBotAgg.forEach((r) => {
      const existing = perMentorAttMap.get(r._id) || { invited: 0, invitedAttended: 0, totalAttended: 0 };
      perMentorAttMap.set(r._id, {
        invited: (existing.invited || 0) + (r.invited || 0),
        invitedAttended: (existing.invitedAttended || 0) + (r.invitedAttended || 0),
        totalAttended: (existing.totalAttended || 0) + (r.totalAttended || 0)
      });
    });
    perMentorPlatformCallAgg.forEach((r) => {
      const existing = perMentorAttMap.get(r._id) || { invited: 0, invitedAttended: 0, totalAttended: 0 };
      perMentorAttMap.set(r._id, {
        invited: (existing.invited || 0) + (r.invited || 0),
        invitedAttended: (existing.invitedAttended || 0) + (r.invitedAttended || 0),
        totalAttended: (existing.totalAttended || 0) + (r.totalAttended || 0)
      });
    });

    const studentsByMentorMap = new Map(studentsByMentorAgg.map((r) => [r._id, r]));
    const mentorOnly = workers.filter((w) => ["mentor", "mentor_ta"].includes(w.role));
    const studentKeys = Array.from(studentsByMentorMap.keys()).filter((k) => k && k !== "noma'lum");
    const attendanceKeys = Array.from(perMentorAttMap.keys()).filter((k) => k && k !== "noma'lum");
    const usedStudentKeys = new Set();
    const usedAttendanceKeys = new Set();

    const mentorRows = mentorOnly.map((worker) => {
      const matchedSdKey = findBestUnusedKey(worker.fullName, studentKeys, usedStudentKeys);
      if (matchedSdKey) usedStudentKeys.add(matchedSdKey);
      const sd = matchedSdKey
        ? studentsByMentorMap.get(matchedSdKey)
        : { totalStudents: 0, groupList: [], good: 0, average: 0, lead: 0, poor: 0, freeze: 0 };

      const matchedAdKey = findBestUnusedKey(worker.fullName, attendanceKeys, usedAttendanceKeys);
      if (matchedAdKey) usedAttendanceKeys.add(matchedAdKey);
      const ad = matchedAdKey ? perMentorAttMap.get(matchedAdKey) : { invited: 0, invitedAttended: 0, totalAttended: 0 };

      const total = sd.totalStudents;
      const qualityScore = total > 0
        ? Number(((5 * sd.good + 4 * sd.average + 3 * sd.lead + 2 * sd.poor + 1 * sd.freeze) / total).toFixed(2))
        : 0;

      return {
        id: worker._id,
        name: worker.fullName,
        role: worker.role,
        groupList: sd.groupList.slice().sort(),
        totalStudents: total,
        invited: ad.invited,
        attended: ad.totalAttended,
        attendancePct: ad.invited > 0 ? Math.min(Math.round((ad.invitedAttended / ad.invited) * 100), 100) : 0,
        good: sd.good,
        average: sd.average,
        lead: sd.lead,
        poor: sd.poor,
        freeze: sd.freeze,
        qualityScore,
      };
    });

    const taEntriesMap = new Map(taEntriesAgg.map((r) => [r._id, r.count]));
    const taRoles = ["ta", "mentor_ta"];
    const taRows = workers
      .filter((w) => taRoles.includes(w.role))
      .map((worker) => {
        const nameKey = worker.fullName.toLowerCase();
        const matchedKey = Array.from(taEntriesMap.keys()).find(
          (k) => k.includes(nameKey) || nameKey.includes(k)
        );
        const count = matchedKey ? taEntriesMap.get(matchedKey) : 0;
        return { id: worker._id, name: worker.fullName, role: worker.role, entryCount: count };
      })
      .sort((a, b) => b.entryCount - a.entryCount);

    const trendMap = new Map();
    for (let i = 0; i < 6; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() - (5 - i));
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const key = `${y}-${m}`;
      trendMap.set(key, { name: MONTH_UZ[m - 1], invited: 0, invitedAttended: 0, totalAttended: 0, missed: 0 });
    }

    trendAgg.forEach((r) => {
      const key = `${r._id.year}-${r._id.month}`;
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += (r.invited || 0);
        existing.invitedAttended += (r.invitedAttended || 0);
        existing.totalAttended += (r.totalAttended || 0);
        existing.missed += (r.missed || 0);
      }
    });

    trendBotAgg.forEach((r) => {
      const key = `${r._id.year}-${r._id.month}`;
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += (r.invited || 0);
        existing.invitedAttended += (r.invitedAttended || 0);
        existing.totalAttended += (r.totalAttended || 0);
        existing.missed += (r.missed || 0);
      }
    });

    trendPlatformCallAgg.forEach((r) => {
      const key = `${r._id.year}-${r._id.month}`;
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += (r.invited || 0);
        existing.invitedAttended += (r.invitedAttended || 0);
        existing.totalAttended += (r.totalAttended || 0);
        existing.missed += (r.missed || 0);
      }
    });

    const trend = Array.from(trendMap.values()).map((t) => ({
      month: t.name,
      attended: t.totalAttended,
      missed: t.missed,
      pct: t.invited > 0 ? Math.min(Math.round((t.invitedAttended / t.invited) * 100), 100) : 0
    }));

    return ok(res, {
      global,
      statusCounts,
      mentorRows,
      taRows,
      trend,
    }, "Analytics data");
  } catch (error) {
    console.error("CRITICAL ERROR IN getAnalytics:", error);
    return res.status(500).json({ success: false, message: error.message, stack: error.stack });
  }
});

module.exports = { getAnalytics };
