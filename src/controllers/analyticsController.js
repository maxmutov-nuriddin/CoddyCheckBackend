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

    // ── Build date filters (used by multiple queries below) ───────────────
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

    // sixMonthsAgo is needed for trend queries — computed before Promise.all
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    // ── Fire ALL 11 independent DB queries concurrently ───────────────────
    // None of these queries depends on another's result — all filters
    // are derived from request params and sixMonthsAgo, both set above.
    // Sequential execution: ~5 async waves × avg 100ms = ~500ms
    // Parallel execution: max(single slowest query) ≈ 100-150ms
    const [
      workers,
      totalStudents,
      statusAggResult,
      globalAttAgg,
      globalBotAgg,
      perMentorAttAgg,
      perMentorBotAgg,
      studentsByMentorAgg,
      taEntriesAgg,
      trendAgg,
      trendBotAgg
    ] = await Promise.all([
      // 1. Active staff list
      User.find({ role: { $in: STAFF_ROLES }, isActive: true })
        .select("_id fullName role")
        .lean(),

      // 2. Total active students count
      Student.countDocuments({ isActive: true }),

      // 3. Student status distribution
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

      // 4. Global web attendance totals
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

      // 5. Global bot attendance totals
      CoddyAttendance.aggregate([
        { $match: botMatch },
        {
          $group: {
            _id: null,
            invited: { $sum: { $cond: [{ $in: ["$requestType", ["call_extra", "keep"]] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
          }
        }
      ]),

      // 6. Per-mentor web attendance
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

      // 7. Per-mentor bot attendance
      CoddyAttendance.aggregate([
        { $match: botMatch },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$mainTeacher", "noma'lum"] } },
            invited: { $sum: { $cond: [{ $in: ["$requestType", ["call_extra", "keep"]] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $and: [{ $eq: ["$requestType", "mark"] }, { $eq: ["$status", "Keldi"] }] }, 1, 0] } },
          }
        }
      ]),

      // 8. Students grouped by mentor (for quality scores + group lists)
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

      // 9. TA entry counts
      CoddyAttendance.aggregate([
        { $match: { ...botMatch, requestType: "mark" } },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$teacherName", "noma'lum"] } },
            count: { $sum: 1 }
          }
        }
      ]),

      // 10. 6-month attendance trend (web)
      Attendance.aggregate([
        { $match: { date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { month: { $month: "$date" }, year: { $year: "$date" } },
            invited: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
            attended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "kelmadi"] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch(err => { console.error("trendAgg error:", err); return []; }),

      // 11. 6-month attendance trend (bot)
      CoddyAttendance.aggregate([
        { $match: { requestType: "mark", date: { $gte: formatYMD(sixMonthsAgo) } } },
        { $addFields: { dateObj: { $dateFromString: { dateString: "$date", onError: new Date(0) } } } },
        {
          $group: {
            _id: { month: { $month: "$dateObj" }, year: { $year: "$dateObj" } },
            attended: { $sum: { $cond: [{ $eq: ["$status", "Keldi"] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ["$status", "Kelmadi"] }, 1, 0] } }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]).catch(err => { console.error("trendBotAgg error:", err); return []; })
    ]);

    // ── Process results (identical logic to before, just using resolved vars) ──

    // Status counts
    const statusCounts = statusAggResult.length > 0
      ? { good: statusAggResult[0].good, average: statusAggResult[0].average, lead: statusAggResult[0].lead, poor: statusAggResult[0].poor, freeze: statusAggResult[0].freeze }
      : { good: 0, average: 0, lead: 0, poor: 0, freeze: 0 };

    // Global metrics
    const gAtt = globalAttAgg[0] || { invited: 0, attended: 0 };
    const gBot = globalBotAgg[0] || { invited: 0, attended: 0 };
    const totalInvited = gAtt.invited + gBot.invited;
    const totalAttended = gAtt.attended + gBot.attended;
    const mentorCount = workers.filter(w => ["mentor", "mentor_ta"].includes(w.role)).length;

    const global = {
      totalMentors: mentorCount,
      totalStudents,
      totalInvited,
      totalAttended,
      attendancePct: totalInvited > 0 ? Math.min(Math.round((totalAttended / totalInvited) * 100), 100) : 0
    };

    // Per-mentor attendance map (merged web + bot)
    const perMentorAttMap = new Map();
    perMentorAttAgg.forEach(r => perMentorAttMap.set(r._id, r));
    perMentorBotAgg.forEach(r => {
      const existing = perMentorAttMap.get(r._id) || { invited: 0, attended: 0 };
      perMentorAttMap.set(r._id, {
        invited: existing.invited + r.invited,
        attended: existing.attended + r.attended
      });
    });

    const studentsByMentorMap = new Map(studentsByMentorAgg.map(r => [r._id, r]));

    const mentorOnly = workers.filter(w => ["mentor", "mentor_ta"].includes(w.role));
    const mentorRows = mentorOnly.map((worker) => {
      const nameKey = worker.fullName.toLowerCase();

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

    // TA statistics
    const taEntriesMap = new Map(taEntriesAgg.map(r => [r._id, r.count]));
    const taRoles = ["ta", "mentor_ta"];
    const taRows = workers
      .filter(w => taRoles.includes(w.role))
      .map(worker => {
        const nameKey = worker.fullName.toLowerCase();
        const matchedKey = Array.from(taEntriesMap.keys()).find(k =>
          k.includes(nameKey) || nameKey.includes(k)
        );
        const count = matchedKey ? taEntriesMap.get(matchedKey) : 0;
        return { id: worker._id, name: worker.fullName, role: worker.role, entryCount: count };
      })
      .sort((a, b) => b.entryCount - a.entryCount);

    // 6-month trend
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
        existing.missed += r.missed;
      }
    });
    trendBotAgg.forEach((r) => {
      const key = `${r._id.year}-${r._id.month}`;
      if (trendMap.has(key)) {
        const existing = trendMap.get(key);
        existing.attended += r.attended;
        existing.missed += r.missed;
      }
    });

    const trend = Array.from(trendMap.values()).map((t) => ({
      month: t.name,
      attended: t.attended,
      missed: t.missed,
      pct: t.invited > 0 ? Math.min(Math.round((t.attended / t.invited) * 100), 100) : 0
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
