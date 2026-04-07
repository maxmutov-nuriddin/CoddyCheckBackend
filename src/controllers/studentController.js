const Student = require("../models/Student");
const Group = require("../models/Group");
const FrozenStudent = require("../models/FrozenStudent");
const syncFrozenStudent = require("../services/syncFrozenStudent");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const getStudents = asyncHandler(async (req, res) => {
  const { groupId, search, isActive, lite } = req.query;
  const liteMode = String(lite || "").toLowerCase();
  const kuratorId = req.user._id;

  const filter = { kuratorId };
  if (groupId === "none") {
    filter.$or = [{ groupId: null }, { groupId: { $exists: false } }];
  } else if (groupId) {
    filter.groupId = groupId;
  }
  if (typeof isActive !== "undefined") filter.isActive = isActive === "true";
  if (search) {
    filter.fullName = { $regex: escapeRegex(String(search).slice(0, 100)), $options: "i" };
  }

  let query = Student.find(filter);

  if (liteMode === "attendance") {
    query = query
      .select("_id fullName groupId frozenStatus comment profileUrl isActive")
      .sort({ groupId: 1, fullName: 1 })
      .lean();
  } else {
    query = query
      .populate("groupId", "name mentor")
      .sort({ createdAt: -1 })
      .lean();
  }

  const students = await query;

  return ok(res, students);
});

const createStudent = asyncHandler(async (req, res) => {
  const { fullName, groupId, frozenStatus = null, comment = "", profileUrl = "" } = req.body;
  const kuratorId = req.user._id;

  if (!fullName) {
    throw new ApiError(400, "fullName is required");
  }

  if (groupId) {
    const group = await Group.findOne({ _id: groupId, kuratorId });
    if (!group) {
      throw new ApiError(404, "Group not found");
    }
  }

  const student = await Student.create({
    fullName,
    groupId,
    frozenStatus,
    comment,
    profileUrl,
    kuratorId
  });

  // Sync with FrozenStudent if created with frozen status
  await syncFrozenStudent(student, kuratorId);

  return created(res, student, "Student created");
});

const updateStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { fullName, groupId, frozenStatus, comment, isActive, profileUrl } = req.body;
  const kuratorId = req.user._id;

  const student = await Student.findOne({ _id: id, kuratorId });
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  if (groupId === null || groupId === "none" || groupId === "") {
    student.groupId = null;
  } else if (groupId) {
    const group = await Group.findOne({ _id: groupId, kuratorId });
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
  await syncFrozenStudent(student, kuratorId);

  return ok(res, student, "Student updated");
});

const deleteStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const kuratorId = req.user._id;

  const student = await Student.findOne({ _id: id, kuratorId });
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
  const kuratorId = req.user._id;

  // 1. Regular students with explicit frozen statuses
  // Backward compatibility: old rows may store "frozen" instead of "muzlatilgan".
  let statusFilter;
  if (!status) {
    statusFilter = { $in: ["qarzdor", "qaytadi", "muzlatilgan", "frozen"] };
  } else if (status === "muzlatilgan") {
    statusFilter = { $in: ["muzlatilgan", "frozen"] };
  } else {
    statusFilter = status;
  }

  const studentFilter = {
    frozenStatus: statusFilter,
    isActive: true,
    kuratorId
  };

  const rawStudents = await Student.find(studentFilter)
    .populate("groupId", "name mentor")
    .sort({ updatedAt: -1 });

  const students = rawStudents.map((row) => {
    const plain = row.toObject ? row.toObject() : row;
    if (plain.frozenStatus === "frozen") {
      plain.frozenStatus = "muzlatilgan";
    }
    return plain;
  });

  // 2. Auto-synced students from FrozenStudent collection.
  //    Only include when no specific status is requested OR it matches "muzlatilgan".
  const includeSynced = !status || status === "muzlatilgan";
  let syncedRows = [];

  if (includeSynced) {
    const frozenRecords = await FrozenStudent.find({ kuratorId }).sort({ updatedAt: -1 });

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

  // Merge + dedupe by student id, then sort by most recently updated.
  const dedupedMap = new Map();
  [...students, ...syncedRows].forEach((row) => {
    const key = String(row?._id || "");
    if (!key) return;
    const prev = dedupedMap.get(key);
    if (!prev) {
      dedupedMap.set(key, row);
      return;
    }

    const prevTime = new Date(prev.updatedAt || 0).getTime();
    const nextTime = new Date(row.updatedAt || 0).getTime();
    dedupedMap.set(key, nextTime >= prevTime ? row : prev);
  });

  const combined = Array.from(dedupedMap.values());
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
