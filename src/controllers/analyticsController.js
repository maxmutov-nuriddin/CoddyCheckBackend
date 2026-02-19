const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/response");
const User = require("../models/User");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");

const STAFF_ROLES = ["mentor", "ta", "mentor_ta"];
const FREEZE_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];
const MONTH_UZ = ["Yan", "Fev", "Mar", "Apr", "May", "Iyn", "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"];

const getAnalytics = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo } = req.query;

  // ── Date filter ───────────────────────────────────────────────────────────
  const dateFilter = {};
  if (dateFrom) dateFilter.$gte = new Date(dateFrom);
  if (dateTo) {
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);
    dateFilter.$lte = end;
  }
  const hasDates = Object.keys(dateFilter).length > 0;
  const attMatch = hasDates ? { date: dateFilter } : {};

  // ── Workers (mentors / TAs) ───────────────────────────────────────────────
  const workers = await User.find({ role: { $in: STAFF_ROLES }, isActive: true })
    .select("_id fullName role")
    .lean();

  // ── Total active students ─────────────────────────────────────────────────
  const totalStudents = await Student.countDocuments({ isActive: true });

  // ── Global student status counts ──────────────────────────────────────────
  const statusAggResult = await Student.aggregate([
    { $match: { isActive: true } },
    {
      $group: {
        _id: null,
        good:    { $sum: { $cond: [{ $eq: ["$frozenStatus", "good"]    }, 1, 0] } },
        average: { $sum: { $cond: [{ $eq: ["$frozenStatus", "average"] }, 1, 0] } },
        lead:    { $sum: { $cond: [{ $eq: ["$frozenStatus", "lead"]    }, 1, 0] } },
        poor:    { $sum: { $cond: [{ $eq: ["$frozenStatus", "poor"]    }, 1, 0] } },
        freeze:  { $sum: { $cond: [{ $in: ["$frozenStatus", FREEZE_STATUSES] }, 1, 0] } },
      }
    }
  ]);
  const statusCounts = statusAggResult.length > 0
    ? { good: statusAggResult[0].good, average: statusAggResult[0].average, lead: statusAggResult[0].lead, poor: statusAggResult[0].poor, freeze: statusAggResult[0].freeze }
    : { good: 0, average: 0, lead: 0, poor: 0, freeze: 0 };

  // ── Global attendance totals ──────────────────────────────────────────────
  const globalAttResult = await Attendance.aggregate([
    { $match: attMatch },
    {
      $group: {
        _id: null,
        totalInvited:  { $sum: { $cond: [{ $eq: ["$callStatus",       "chaqirilgan"] }, 1, 0] } },
        totalAttended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"]       }, 1, 0] } },
      }
    }
  ]);
  const globalAtt = globalAttResult.length > 0
    ? { totalInvited: globalAttResult[0].totalInvited, totalAttended: globalAttResult[0].totalAttended }
    : { totalInvited: 0, totalAttended: 0 };

  const attendancePct = totalStudents > 0
    ? Number(((globalAtt.totalAttended / totalStudents) * 100).toFixed(1))
    : 0;

  // ── Per-mentor: student status counts (via Group.mentor string match) ─────
  // Group.mentor is a string name — joins by $toLower for case-insensitive matching
  const studentsByMentorAgg = await Student.aggregate([
    { $match: { isActive: true } },
    {
      $lookup: {
        from: "groups",
        localField: "groupId",
        foreignField: "_id",
        as: "grp"
      }
    },
    { $unwind: { path: "$grp", preserveNullAndEmpty: false } },
    {
      $group: {
        _id: { $toLower: "$grp.mentor" },
        groupList:    { $addToSet: "$grp.name" },
        totalStudents: { $sum: 1 },
        good:    { $sum: { $cond: [{ $eq: ["$frozenStatus", "good"]    }, 1, 0] } },
        average: { $sum: { $cond: [{ $eq: ["$frozenStatus", "average"] }, 1, 0] } },
        lead:    { $sum: { $cond: [{ $eq: ["$frozenStatus", "lead"]    }, 1, 0] } },
        poor:    { $sum: { $cond: [{ $eq: ["$frozenStatus", "poor"]    }, 1, 0] } },
        freeze:  { $sum: { $cond: [{ $in: ["$frozenStatus", FREEZE_STATUSES] }, 1, 0] } },
      }
    }
  ]);
  const studentsByMentorMap = new Map(studentsByMentorAgg.map((r) => [r._id, r]));

  // ── Per-mentor: attendance counts (via Attendance.mentorId ObjectId) ──────
  const perMentorAttAgg = await Attendance.aggregate([
    { $match: { ...attMatch, mentorId: { $ne: null } } },
    {
      $group: {
        _id: "$mentorId",
        invited:  { $sum: { $cond: [{ $eq: ["$callStatus",       "chaqirilgan"] }, 1, 0] } },
        attended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"]       }, 1, 0] } },
      }
    }
  ]);
  const perMentorAttMap = new Map(perMentorAttAgg.map((r) => [String(r._id), r]));

  // ── Build mentor rows ─────────────────────────────────────────────────────
  const mentorRows = workers.map((worker) => {
    const nameKey = worker.fullName.toLowerCase();
    const sd = studentsByMentorMap.get(nameKey) || {
      totalStudents: 0, groupList: [], good: 0, average: 0, lead: 0, poor: 0, freeze: 0
    };
    const ad = perMentorAttMap.get(String(worker._id)) || { invited: 0, attended: 0 };
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
      invited:       ad.invited,
      attended:      ad.attended,
      attendancePct: total > 0 ? Math.round((ad.attended / total) * 100) : 0,
      good:    sd.good,
      average: sd.average,
      lead:    sd.lead,
      poor:    sd.poor,
      freeze:  sd.freeze,
      qualityScore,
    };
  });

  // ── Trend: last 6 months of attendance ───────────────────────────────────
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const trendAgg = await Attendance.aggregate([
    { $match: { date: { $gte: sixMonthsAgo }, attendanceStatus: { $ne: null } } },
    {
      $group: {
        _id: { year: { $year: "$date" }, month: { $month: "$date" } },
        attended: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"]   }, 1, 0] } },
        missed:   { $sum: { $cond: [{ $eq: ["$attendanceStatus", "kelmadi"] }, 1, 0] } },
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } }
  ]);

  const trend = trendAgg.map((t) => ({
    month:    MONTH_UZ[t._id.month - 1],
    attended: t.attended,
    missed:   t.missed,
  }));

  return ok(res, {
    global: {
      totalMentors:  workers.length,
      totalStudents,
      totalInvited:  globalAtt.totalInvited,
      totalAttended: globalAtt.totalAttended,
      attendancePct,
    },
    statusCounts,
    mentorRows,
    trend,
  }, "Analytics data");
});

module.exports = { getAnalytics };
