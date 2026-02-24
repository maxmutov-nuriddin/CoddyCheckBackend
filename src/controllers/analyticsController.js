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

function startOfDay(input) {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(input) {
  const d = new Date(input);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfWeekMonday(input) {
  const d = startOfDay(input);
  const day = d.getDay(); // 0..6 (Sun..Sat)
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function startOfMonth(input) {
  const d = startOfDay(input);
  d.setDate(1);
  return d;
}

function addDays(input, n) {
  const d = new Date(input);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(input, n) {
  const d = new Date(input);
  d.setMonth(d.getMonth() + n);
  return d;
}

function getIsoWeekInfo(input) {
  const d = startOfDay(input);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const weekYear = d.getFullYear();
  const firstThursday = new Date(weekYear, 0, 4);
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
  const weekNo = 1 + Math.round((d - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return { year: weekYear, week: weekNo };
}

function buildTrendGroupId(group, dateExpr) {
  if (group === "day") {
    return {
      year: { $year: dateExpr },
      month: { $month: dateExpr },
      day: { $dayOfMonth: dateExpr }
    };
  }
  if (group === "week") {
    return {
      year: { $isoWeekYear: dateExpr },
      week: { $isoWeek: dateExpr }
    };
  }
  return {
    year: { $year: dateExpr },
    month: { $month: dateExpr }
  };
}

function buildTrendSort(group) {
  if (group === "day") return { "_id.year": 1, "_id.month": 1, "_id.day": 1 };
  if (group === "week") return { "_id.year": 1, "_id.week": 1 };
  return { "_id.year": 1, "_id.month": 1 };
}

function trendKeyFromAgg(group, bucket) {
  if (group === "day") return `${bucket.year}-${bucket.month}-${bucket.day}`;
  if (group === "week") return `${bucket.year}-W${bucket.week}`;
  return `${bucket.year}-${bucket.month}`;
}

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
    const rawTrendGroup = String(req.query.trendGroup || "month").toLowerCase();
    const trendGroup = ["day", "week", "month"].includes(rawTrendGroup) ? rawTrendGroup : "month";

    const attMatch = {};
    const botMatch = {};
    let parsedStart = null;
    let parsedEnd = null;

    if (dateFrom || dateTo) {
      const start = dateFrom ? new Date(dateFrom) : null;
      const end = dateTo ? new Date(dateTo) : null;

      if (start || end) {
        attMatch.date = {};
        if (start) attMatch.date.$gte = start;
        if (end) attMatch.date.$lte = end;

        if (start) botMatch.date = { ...botMatch.date, $gte: formatYMD(start) };
        if (end) botMatch.date = { ...botMatch.date, $lte: formatYMD(end) };

        parsedStart = start;
        parsedEnd = end;
      }
    }

    const now = new Date();
    let trendStart;
    let trendEnd;

    if (parsedStart || parsedEnd) {
      trendStart = parsedStart ? startOfDay(parsedStart) : startOfDay(parsedEnd || now);
      trendEnd = parsedEnd ? endOfDay(parsedEnd) : endOfDay(parsedStart || now);
    } else if (trendGroup === "day") {
      trendStart = startOfDay(addDays(now, -6));
      trendEnd = endOfDay(now);
    } else if (trendGroup === "week") {
      trendStart = startOfWeekMonday(addDays(now, -49)); // 8 weeks
      trendEnd = endOfDay(now);
    } else {
      trendStart = startOfMonth(addMonths(now, -5)); // 6 months
      trendEnd = endOfDay(now);
    }

    const { attNonKuratorMatch, botNonKuratorMatch } = await buildKuratorExclusion();
    const trendBotMatch = {
      ...botNonKuratorMatch,
      date: { $gte: formatYMD(trendStart), $lte: formatYMD(trendEnd) }
    };
    const trendAttMatch = {
      ...attNonKuratorMatch,
      date: { $gte: trendStart, $lte: trendEnd }
    };
    const trendPlatformMatch = { date: { $gte: trendStart, $lte: trendEnd } };
    const trendGroupId = buildTrendGroupId(trendGroup, "$date");
    const trendSort = buildTrendSort(trendGroup);

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
            // webSync:true yozuvlar Attendance collection da allaqachon hisoblanadi — istisno
            totalAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }, { $ne: ["$webSync", true] }] }, 1, 0] } },
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
            totalAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }, { $ne: ["$webSync", true] }] }, 1, 0] } },
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
        { $match: trendAttMatch },
        {
          $group: {
            _id: trendGroupId,
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callStatus", "chaqirilgan"] }, { $eq: ["$attendanceStatus", "keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $and: [{ $eq: ["$callStatus", "chaqirilgan"] }, { $eq: ["$attendanceStatus", "kelmadi"] }] }, 1, 0] } }
          }
        },
        { $sort: trendSort }
      ]).catch((err) => {
        console.error("trendAgg error:", err);
        return [];
      }),

      CoddyAttendance.aggregate([
        { $match: trendBotMatch },
        { $addFields: { dateObj: { $dateFromString: { dateString: "$date", onError: new Date(0) } } } },
        {
          $group: {
            _id: buildTrendGroupId(trendGroup, "$dateObj"),
            invited: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }] }, 1, 0] } },
            invitedAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }, { $ne: ["$webSync", true] }] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $and: [{ $eq: ["$callConfirmed", true] }, { $in: ["$requestType", ["call_extra", "keep"]] }, { $eq: ["$status", "Kelmadi"] }] }, 1, 0] } }
          }
        },
        { $sort: trendSort }
      ]).catch((err) => {
        console.error("trendBotAgg error:", err);
        return [];
      }),

      CalledStudent.aggregate([
        { $match: trendPlatformMatch },
        {
          $group: {
            _id: trendGroupId,
            invited: { $sum: "$callCount" },
            invitedAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } },
            totalAttended: { $sum: { $cond: [{ $eq: ["$lastStatus", "keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ["$lastStatus", "kelmadi"] }, 1, 0] } }
          }
        },
        { $sort: trendSort }
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
    // gPlatform.totalAttended qo'shilmaydi: platformdan chaqirilgan va kelgan o'quvchilar
    // allaqachon Attendance collection orqali gAtt.totalAttended da hisoblanadi
    const totalAttended = (gAtt.totalAttended || 0) + (gBot.totalAttended || 0);
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
        // totalAttended qo'shilmaydi: platform orqali kelganlar Attendance da allaqachon hisoblanadi
        totalAttended: existing.totalAttended || 0
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

    const trendBuckets = [];
    if (trendGroup === "day") {
      for (let d = startOfDay(trendStart); d <= trendEnd; d = addDays(d, 1)) {
        const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        const label = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
        trendBuckets.push({ key, label });
      }
    } else if (trendGroup === "week") {
      for (let d = startOfWeekMonday(trendStart); d <= trendEnd; d = addDays(d, 7)) {
        const iso = getIsoWeekInfo(d);
        const weekStart = startOfDay(d);
        const weekEndRaw = addDays(weekStart, 6);
        const weekEnd = weekEndRaw > trendEnd ? trendEnd : weekEndRaw;
        const fromLabel = `${String(weekStart.getDate()).padStart(2, "0")}.${String(weekStart.getMonth() + 1).padStart(2, "0")}`;
        const toLabel = `${String(weekEnd.getDate()).padStart(2, "0")}.${String(weekEnd.getMonth() + 1).padStart(2, "0")}`;
        trendBuckets.push({ key: `${iso.year}-W${iso.week}`, label: `${fromLabel} - ${toLabel}` });
      }
    } else {
      for (let d = startOfMonth(trendStart); d <= trendEnd; d = startOfMonth(addMonths(d, 1))) {
        const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
        trendBuckets.push({ key, label: MONTH_UZ[d.getMonth()] });
      }
    }

    const trendMap = new Map(
      trendBuckets.map((bucket) => [
        bucket.key,
        { name: bucket.label, invited: 0, invitedAttended: 0, totalAttended: 0, missed: 0 }
      ])
    );

    trendAgg.forEach((r) => {
      const key = trendKeyFromAgg(trendGroup, r._id || {});
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += (r.invited || 0);
        existing.invitedAttended += (r.invitedAttended || 0);
        existing.totalAttended += (r.totalAttended || 0);
        existing.missed += (r.missed || 0);
      }
    });

    trendBotAgg.forEach((r) => {
      const key = trendKeyFromAgg(trendGroup, r._id || {});
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += (r.invited || 0);
        existing.invitedAttended += (r.invitedAttended || 0);
        existing.totalAttended += (r.totalAttended || 0);
        existing.missed += (r.missed || 0);
      }
    });

    trendPlatformCallAgg.forEach((r) => {
      const key = trendKeyFromAgg(trendGroup, r._id || {});
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += (r.invited || 0);
        existing.invitedAttended += (r.invitedAttended || 0);
        // totalAttended qo'shilmaydi: platform orqali kelganlar Attendance da allaqachon hisoblanadi
        existing.missed += (r.missed || 0);
      }
    });

    const trend = trendBuckets.map((bucket) => trendMap.get(bucket.key)).map((t) => ({
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
