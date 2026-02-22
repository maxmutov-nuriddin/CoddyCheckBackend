const Student = require("../models/Student");
const Group = require("../models/Group");
const FrozenStudent = require("../models/FrozenStudent");
const syncFrozenStudent = require("../services/syncFrozenStudent");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");

const getStudents = asyncHandler(async (req, res) => {
  const { groupId, search, isActive } = req.query;

  const filter = {};
  if (groupId) filter.groupId = groupId;
  if (typeof isActive !== "undefined") filter.isActive = isActive === "true";
  if (search) {
    filter.fullName = { $regex: search, $options: "i" };
  }

  const students = await Student.find(filter)
    .populate("groupId", "name mentor")
    .sort({ createdAt: -1 });

  return ok(res, students);
});

const createStudent = asyncHandler(async (req, res) => {
  const { fullName, groupId, frozenStatus = null, comment = "", profileUrl = "" } = req.body;

  if (!fullName) {
    throw new ApiError(400, "fullName is required");
  }

  if (groupId) {
    const group = await Group.findById(groupId);
    if (!group) {
      throw new ApiError(404, "Group not found");
    }
  }

  const student = await Student.create({
    fullName,
    groupId,
    frozenStatus,
    comment,
    profileUrl
  });

  // Sync with FrozenStudent if created with frozen status
  await syncFrozenStudent(student);

  return created(res, student, "Student created");
});

const updateStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { fullName, groupId, frozenStatus, comment, isActive, profileUrl } = req.body;

  const student = await Student.findById(id);
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  if (groupId) {
    const group = await Group.findById(groupId);
    if (!group) {
      throw new ApiError(404, "Group not found");
    }
    student.groupId = groupId;
  }

  if (typeof fullName !== "undefined") student.fullName = fullName;
  if (typeof frozenStatus !== "undefined") student.frozenStatus = frozenStatus;
  if (typeof comment !== "undefined") student.comment = comment;
  if (typeof profileUrl !== "undefined") student.profileUrl = profileUrl;
  if (typeof isActive !== "undefined") student.isActive = Boolean(isActive);

  await student.save();

  // Auto-sync with FrozenStudent collection
  await syncFrozenStudent(student);

  return ok(res, student, "Student updated");
});

const deleteStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const student = await Student.findById(id);
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  student.isActive = false;
  await student.save();

  // Clean up any FrozenStudent record for this student
  await FrozenStudent.deleteOne({ studentId: student._id });

  return ok(res, { _id: student._id, isActive: student.isActive }, "Student deactivated");
});

const getFrozenStudents = asyncHandler(async (req, res) => {
  const { status } = req.query;

  // 1. Regular students with explicit frozen statuses (qarzdor / qaytadi / muzlatilgan)
  const studentFilter = {
    frozenStatus: status || { $in: ["qarzdor", "qaytadi", "muzlatilgan"] },
    isActive: true
  };

  const students = await Student.find(studentFilter)
    .populate("groupId", "name mentor")
    .sort({ updatedAt: -1 });

  // 2. Auto-synced students from FrozenStudent collection.
  //    Only include when no specific status is requested OR it matches "muzlatilgan".
  const includeSynced = !status || status === "muzlatilgan";
  let syncedRows = [];

  if (includeSynced) {
    const frozenRecords = await FrozenStudent.find({}).sort({ updatedAt: -1 });

    if (frozenRecords.length > 0) {
      // Fetch the actual Student documents in one query
      const studentIds = frozenRecords.map((fs) => fs.studentId);
      const refStudents = await Student.find({
        _id: { $in: studentIds },
        isActive: true
      }).populate("groupId", "name mentor");

      // Build a quick lookup map by Student._id string
      const studentMap = {};
      for (const s of refStudents) {
        studentMap[s._id.toString()] = s;
      }

      for (const fs of frozenRecords) {
        const ref = studentMap[fs.studentId.toString()];
        if (!ref) continue; // Student deleted or inactive — skip

        syncedRows.push({
          _id: ref._id,
          fullName: fs.fullName,
          profileUrl: fs.profileLink,
          frozenStatus: fs.status,       // "muzlatilgan"
          comment: ref.comment || "",
          groupId: ref.groupId || null,
          updatedAt: fs.updatedAt,
          createdAt: fs.createdAt,
          isActive: true
        });
      }
    }
  }

  // Merge and sort by most recently updated
  const combined = [...students, ...syncedRows];
  combined.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return ok(res, combined);
});

module.exports = {
  getStudents,
  createStudent,
  updateStudent,
  deleteStudent,
  getFrozenStudents
};
