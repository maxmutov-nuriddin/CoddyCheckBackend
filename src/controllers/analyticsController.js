const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/response");
const User = require("../models/User");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const { formatYMD } = require("../utils/date");

const STAFF_ROLES = ["mentor", "ta", "mentor_ta"];
const FREEZE_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];
const MONTH_UZ = ["Yan", "Fev", "Mar", "Apr", "May", "Iyn", "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"];

const getAnalytics = asyncHandler(async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    // ── 1. Global Metrics ──────────────────────────────────────────────────
    const attMatch = {};
    const botMatch = {}; // Date filter only, internal filtering by requestType

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

    // ── 2. Entities & Status Counts ─────────────────────────────────────────
    const workers = await User.find({ role: { $in: STAFF_ROLES }, isActive: true })
      .select("_id fullName role")
      .lean();

    const totalStudents = await Student.countDocuments({ isActive: true });

    const statusAggResult = await Student.aggregate([
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
    ]);
    const statusCounts = statusAggResult.length > 0
      ? { good: statusAggResult[0].good, average: statusAggResult[0].average, lead: statusAggResult[0].lead, poor: statusAggResult[0].poor, freeze: statusAggResult[0].freeze }
      : { good: 0, average: 0, lead: 0, poor: 0, freeze: 0 };

    const [globalAttAgg, globalBotAgg] = await Promise.all([
      Attendance.aggregate([
        { $match: attMatch },
        {
          $group: {
            _id: null,
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
          }
        }
      ]),
      CoddyAttendance.aggregate([
        { $match: botMatch },
        {
          $group: {
            _id: null,
            invited: { $sum: { $cond: [{ $in: ["$requestType", ["call_extra", "keep"]] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
          }
        }
      ])
    ]);

    const gAtt = globalAttAgg[0] || { invited: 0, attended: 0 };
    const gBot = globalBotAgg[0] || { invited: 0, attended: 0 };

    const totalInvited = gAtt.invited + gBot.invited;
    const totalAttended = gAtt.attended + gBot.attended;

    const global = {
      totalMentors: workers.length,
      totalStudents,
      totalInvited,
      totalAttended,
      attendancePct: totalInvited > 0 ? Math.min(Math.round((totalAttended / totalInvited) * 100), 100) : 0
    };

    // ── 3. Per-mentor Metrics ──────────────────────────────────────────────
    // (via Group.mentor through Attendance.groupId AND CoddyAttendance.mainTeacher)
    const [perMentorAttAgg, perMentorBotAgg] = await Promise.all([
      Attendance.aggregate([
        { $match: attMatch },
        { $lookup: { from: "groups", localField: "groupId", foreignField: "_id", as: "grp" } },
        { $unwind: { path: "$grp", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$grp.mentor", "noma'lum"] } },
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
          }
        }
      ]),
      CoddyAttendance.aggregate([
        { $match: botMatch },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$mainTeacher", "noma'lum"] } },
            invited: { $sum: { $cond: [{ $in: ["$requestType", ["call_extra", "keep"]] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
          }
        }
      ])
    ]);

    const perMentorAttMap = new Map();
    perMentorAttAgg.forEach(r => perMentorAttMap.set(r._id, r));
    perMentorBotAgg.forEach(r => {
      const existing = perMentorAttMap.get(r._id) || { invited: 0, attended: 0 };
      perMentorAttMap.set(r._id, {
        invited: existing.invited + r.invited,
        attended: existing.attended + r.attended
      });
    });

    const studentsByMentorAgg = await Student.aggregate([
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
    ]);
    const studentsByMentorMap = new Map(studentsByMentorAgg.map(r => [r._id, r]));

    const mentorRows = workers.map((worker) => {
      const nameKey = worker.fullName.toLowerCase();

      // Fuzzy match: Find an entry in the map where either the map key contains the user's name 
      // or the user's name contains the map key.
      const matchedSdKey = Array.from(studentsByMentorMap.keys()).find(k =>
        k.includes(nameKey) || nameKey.includes(k)
      );
      const sd = matchedSdKey ? studentsByMentorMap.get(matchedSdKey) : {
        totalStudents: 0, groupList: [], good: 0, average: 0, lead: 0, poor: 0, freeze: 0
      };

      const matchedAdKey = Array.from(perMentorAttMap.keys()).find(k =>
        k.includes(nameKey) || nameKey.includes(k)
      );
      const ad = matchedAdKey ? perMentorAttMap.get(matchedAdKey) : { invited: 0, attended: 0 };

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
        attended: ad.attended,
        attendancePct: ad.invited > 0 ? Math.min(Math.round((ad.attended / ad.invited) * 100), 100) : 0,
        good: sd.good,
        average: sd.average,
        lead: sd.lead,
        poor: sd.poor,
        freeze: sd.freeze,
        qualityScore,
      };
    });

    // ── 4. Trend (6 months) ──────────────────────────────────────────────────
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [trendAgg, trendBotAgg] = await Promise.all([
      Attendance.aggregate([
        { $match: { date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { month: { $month: "$date" }, year: { $year: "$date" } },
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch(err => { console.error("trendAgg error:", err); return []; }),
      CoddyAttendance.aggregate([
        { $match: { date: { $gte: formatYMD(sixMonthsAgo) } } },
        { $addFields: { dateObj: { $dateFromString: { dateString: "$date", onError: new Date(0) } } } },
        {
          $group: {
            _id: { month: { $month: "$dateObj" }, year: { $year: "$dateObj" } },
            invited: { $sum: { $cond: [{ $in: ["$requestType", ["call_extra", "keep"]] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch(err => { console.error("trendBotAgg error:", err); return []; })
    ]);

    const trendMap = new Map();
    for (let i = 0; i < 6; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() - (5 - i));
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const key = `${y}-${m}`;
      trendMap.set(key, { name: MONTH_UZ[m - 1], invited: 0, attended: 0, missed: 0 });
    }

    trendAgg.forEach((r) => {
      const key = `${r._id.year}-${r._id.month}`;
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += r.invited;
        existing.attended += r.attended;
      }
    });
    trendBotAgg.forEach((r) => {
      const key = `${r._id.year}-${r._id.month}`;
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.invited += r.invited;
        existing.attended += r.attended;
      }
    });

    const trend = Array.from(trendMap.values()).map((t) => ({
      month: t.name,
      attended: t.attended,
      missed: Math.max(0, t.invited - t.attended),
      pct: t.invited > 0 ? Math.min(Math.round((t.attended / t.invited) * 100), 100) : 0
    }));

    return ok(res, {
      global,
      statusCounts,
      mentorRows,
      trend,
    }, "Analytics data");
  } catch (error) {
    console.error("CRITICAL ERROR IN getAnalytics:", error);
    return res.status(500).json({ success: false, message: error.message, stack: error.stack });
  }
});

module.exports = { getAnalytics };
