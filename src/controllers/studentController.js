const Student = require("../models/Student");
const Group = require("../models/Group");
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
    .populate("groupId", "name")
    .sort({ createdAt: -1 });

  return ok(res, students);
});

const createStudent = asyncHandler(async (req, res) => {
  const { fullName, groupId, frozenStatus = null, comment = "" } = req.body;

  if (!fullName || !groupId) {
    throw new ApiError(400, "fullName and groupId are required");
  }

  const group = await Group.findById(groupId);
  if (!group) {
    throw new ApiError(404, "Group not found");
  }

  const student = await Student.create({
    fullName,
    groupId,
    frozenStatus,
    comment
  });

  return created(res, student, "Student created");
});

const updateStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { fullName, groupId, frozenStatus, comment, isActive } = req.body;

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
  if (typeof isActive !== "undefined") student.isActive = Boolean(isActive);

  await student.save();

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

  return ok(res, { _id: student._id, isActive: student.isActive }, "Student deactivated");
});

const getFrozenStudents = asyncHandler(async (req, res) => {
  const { status } = req.query;

  const filter = {
    frozenStatus: status || { $in: ["qarzdor", "qaytadi", "muzlatilgan"] }
  };

  const students = await Student.find(filter)
    .populate("groupId", "name")
    .sort({ updatedAt: -1 });

  return ok(res, students);
});

module.exports = {
  getStudents,
  createStudent,
  updateStudent,
  deleteStudent,
  getFrozenStudents
};
