const Group = require("../models/Group");
const Student = require("../models/Student");
const CalledStudent = require("../models/CalledStudent");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/response");

// Statuslar: mentor o'zgartira oladigan
const MENTOR_ALLOWED_STATUSES = ["good", "average", "poor"];
// Bu statuslarda mentor o'zgartira olmaydi
const LOCKED_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi", "lead"];

// Mentorning guruhlarini topish: group.mentor === user.fullName AND group.kuratorId === user.kuratorId
const getMyGroups = asyncHandler(async (req, res) => {
  const { fullName, kuratorId } = req.user;

  const groups = await Group.find({ mentor: fullName, kuratorId }).sort({ name: 1 }).lean();
  return ok(res, groups);
});

const getMyStudents = asyncHandler(async (req, res) => {
  const { fullName, kuratorId } = req.user;

  const groups = await Group.find({ mentor: fullName, kuratorId }).lean();
  if (!groups.length) {
    return ok(res, []);
  }

  const groupIds = groups.map((g) => g._id);
  const groupMap = Object.fromEntries(groups.map((g) => [String(g._id), g]));

  const students = await Student.find({
    groupId: { $in: groupIds },
    kuratorId,
    isActive: true
  })
    .sort({ groupId: 1, fullName: 1 })
    .lean();

  if (!students.length) {
    return ok(res, []);
  }

  const studentIds = students.map((s) => s._id);

  // Har bir o'quvchi uchun jami chaqiruvlar soni (callCount yig'indisi)
  const callCounts = await CalledStudent.aggregate([
    { $match: { studentId: { $in: studentIds }, kuratorId } },
    { $group: { _id: "$studentId", totalCalls: { $sum: "$callCount" } } }
  ]);

  const callCountMap = Object.fromEntries(
    callCounts.map((r) => [String(r._id), r.totalCalls])
  );

  const result = students.map((s) => ({
    _id: s._id,
    fullName: s.fullName,
    frozenStatus: s.frozenStatus,
    comment: s.comment || "",
    isActive: s.isActive,
    groupId: s.groupId,
    groupName: groupMap[String(s.groupId)]?.name || "",
    callCount: callCountMap[String(s._id)] || 0,
    isLocked: LOCKED_STATUSES.includes(s.frozenStatus)
  }));

  return ok(res, result);
});

const getDashboard = asyncHandler(async (req, res) => {
  const { fullName, kuratorId } = req.user;

  const groups = await Group.find({ mentor: fullName, kuratorId }).lean();
  const groupIds = groups.map((g) => g._id);

  const totalStudents = groupIds.length
    ? await Student.countDocuments({
        groupId: { $in: groupIds },
        kuratorId,
        isActive: true,
        frozenStatus: { $nin: LOCKED_STATUSES }
      })
    : 0;

  // Bugungi kelganlar sonini hisoblash
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  let cameToday = 0;
  if (groupIds.length) {
    const todayCalls = await CalledStudent.find({
      kuratorId,
      groupId: { $in: groupIds },
      date: { $gte: today, $lt: tomorrow },
      lastStatus: "keldi"
    })
      .select("studentId")
      .lean();
    cameToday = todayCalls.length;
  }

  return ok(res, {
    groupsCount: groups.length,
    totalStudents,
    cameToday,
    groups: groups.map((g) => ({ _id: g._id, name: g.name, days: g.days, time: g.time }))
  });
});

const updateStudentStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { frozenStatus, comment } = req.body;
  const { fullName, kuratorId } = req.user;

  // Mentorning guruhlarini topish
  const groups = await Group.find({ mentor: fullName, kuratorId }).select("_id").lean();
  const groupIds = groups.map((g) => g._id);

  const student = await Student.findOne({ _id: id, groupId: { $in: groupIds }, kuratorId });
  if (!student) {
    throw new ApiError(404, "O'quvchi topilmadi yoki siz uchun ruxsat yo'q");
  }

  // Agar o'quvchi locked statusda bo'lsa, status o'zgartirib bo'lmaydi
  if (LOCKED_STATUSES.includes(student.frozenStatus)) {
    throw new ApiError(403, "Bu o'quvchining statusi o'zgartirib bo'lmaydi");
  }

  if (frozenStatus !== undefined) {
    if (!MENTOR_ALLOWED_STATUSES.includes(frozenStatus)) {
      throw new ApiError(400, `Status faqat: ${MENTOR_ALLOWED_STATUSES.join(", ")} bo'lishi mumkin`);
    }
    student.frozenStatus = frozenStatus;
  }

  if (comment !== undefined) {
    student.comment = String(comment || "").trim();
  }

  await student.save();

  return ok(res, {
    _id: student._id,
    frozenStatus: student.frozenStatus,
    comment: student.comment
  }, "Status yangilandi");
});

module.exports = {
  getMyGroups,
  getMyStudents,
  getDashboard,
  updateStudentStatus
};
