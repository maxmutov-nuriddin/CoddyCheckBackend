const Attendance = require("../models/Attendance");
const Student = require("../models/Student");
const TaNotificationTask = require("../models/TaNotificationTask");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");
const { getDayBounds, formatYMD } = require("../utils/date");
const { updateAttendanceStatus } = require("../services/attendanceService");
const env = require("../config/env");
const { loadActiveStaffForMatching, resolveMentorNameFromWorkers } = require("../coddyCheck/utils/mentorNameResolver");

function normalizeDateOnly(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "Invalid date format");
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildDateTime(dateInput, timeInput) {
  if (!timeInput) {
    return null;
  }

  const date = new Date(dateInput);
  const [hourStr, minuteStr] = String(timeInput).split(":");
  const hours = Number(hourStr);
  const minutes = Number(minuteStr);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new ApiError(400, "Invalid time format, expected HH:mm");
  }

  date.setHours(hours, minutes, 0, 0);
  return date;
}

function normalizeDirection(input) {
  const value = String(input || "").trim().toLowerCase();
  return value === "web" || value === "design" ? value : null;
}

function normalizeOptionalTime(input) {
  const value = String(input || "").trim();
  if (!value) return "";

  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    throw new ApiError(400, "time must be HH:mm format");
  }

  return value;
}

function resolveNotifyDate(dateInput) {
  if (dateInput) {
    const selected = normalizeDateOnly(dateInput);
    const today = normalizeDateOnly(new Date());
    if (selected < today) {
      throw new ApiError(400, "date bugundan oldin bo'lishi mumkin emas");
    }
    return selected;
  }

  const now = new Date();
  const defaultDate = new Date(now);
  if (now.getHours() >= 8) {
    defaultDate.setDate(defaultDate.getDate() + 1);
  }

  defaultDate.setHours(0, 0, 0, 0);
  return defaultDate;
}

const manualAttendance = asyncHandler(async (req, res) => {
  const { studentId, date, attendanceStatus, comment = "" } = req.body;

  if (!studentId || !date || !attendanceStatus) {
    throw new ApiError(400, "studentId, date and attendanceStatus are required");
  }

  if (!["keldi", "kelmadi"].includes(attendanceStatus)) {
    throw new ApiError(400, "attendanceStatus must be keldi or kelmadi");
  }

  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  const normalizedDate = normalizeDateOnly(date);

  const attendance = await Attendance.create({
    studentId,
    groupId: student.groupId,
    taId: req.user._id,
    date: normalizedDate,
    time: null,
    callStatus: "chaqirilmagan",
    attendanceStatus,
    comment,
    botIntegration: false
  });

  return created(res, attendance, "Manual attendance created");
});

const queueTaNotification = asyncHandler(async (req, res) => {
  const { studentName, direction, date, time = "", comment = "" } = req.body;
  const normalizedName = String(studentName || "").trim().replace(/\s+/g, " ");
  const normalizedDirection = normalizeDirection(direction);

  if (!normalizedName || !normalizedDirection) {
    throw new ApiError(400, "studentName and valid direction (web/design) are required");
  }

  const notifyDate = resolveNotifyDate(date);
  const notifyTime = normalizeOptionalTime(time);

  const task = await TaNotificationTask.create({
    studentName: normalizedName,
    direction: normalizedDirection,
    date: notifyDate,
    time: notifyTime,
    comment: String(comment || "").trim(),
    createdBy: req.user._id
  });

  return created(res, task, "TA xabarnomasi 08:00 uchun rejalashtirildi");
});

const callStudent = asyncHandler(async (req, res) => {
  const { studentId, date, time, comment = "" } = req.body;

  if (!studentId || !date) {
    throw new ApiError(400, "studentId and date are required");
  }

  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  const normalizedDate = normalizeDateOnly(date);
  const parsedTime = buildDateTime(normalizedDate, time);

  const attendance = await Attendance.create({
    studentId,
    groupId: student.groupId,
    mentorId: req.user._id,
    date: normalizedDate,
    time: parsedTime,
    callStatus: "chaqirilgan",
    attendanceStatus: null,
    comment,
    botIntegration: true
  });

  return created(res, attendance, "Student called successfully");
});

const confirmArrival = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const attendance = await Attendance.findById(id);
  if (!attendance) {
    throw new ApiError(404, "Attendance record not found");
  }

  attendance.arrivalConfirmedAt = new Date();
  await attendance.save();

  return ok(res, attendance, "Arrival confirmed");
});

const updateStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { attendanceStatus, comment } = req.body;

  if (!["keldi", "kelmadi"].includes(attendanceStatus)) {
    throw new ApiError(400, "attendanceStatus must be keldi or kelmadi");
  }

  const attendance = await Attendance.findById(id);
  if (!attendance) {
    throw new ApiError(404, "Attendance record not found");
  }

  if (typeof comment !== "undefined") {
    attendance.comment = comment;
  }

  const updated = await updateAttendanceStatus({
    attendance,
    newStatus: attendanceStatus,
    changedBy: req.user._id,
    source: "manual"
  });

  return ok(res, updated, "Attendance status updated");
});

const recallStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment = "Qayta chaqirish" } = req.body;

  const previous = await Attendance.findById(id);
  if (!previous) {
    throw new ApiError(404, "Attendance record not found");
  }

  if (previous.attendanceStatus !== "kelmadi") {
    throw new ApiError(400, "Re-call is allowed only for kelmadi status");
  }

  const now = new Date();
  const dateOnly = new Date(now);
  dateOnly.setHours(0, 0, 0, 0);

  const newRecord = await Attendance.create({
    studentId: previous.studentId,
    groupId: previous.groupId,
    mentorId: previous.mentorId,
    taId: req.user._id,
    date: dateOnly,
    time: now,
    callStatus: "chaqirilgan",
    attendanceStatus: null,
    comment,
    botIntegration: true
  });

  return created(res, newRecord, "Student re-called successfully");
});

const getCalledList = asyncHandler(async (req, res) => {
  const date = req.query.date || formatYMD(new Date());
  const { start, end } = getDayBounds(date);

  const rows = await Attendance.find({
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan"
  })
    .populate("studentId", "fullName")
    .populate("groupId", "name")
    .populate("mentorId", "fullName")
    .sort({ time: 1, createdAt: 1 });

  return ok(res, rows, "Called students list");
});

const getDailyReport = asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) {
    throw new ApiError(400, "date query is required: YYYY-MM-DD");
  }

  const { start, end } = getDayBounds(date);

  const rows = await Attendance.find({
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan"
  })
    .populate("studentId", "fullName")
    .populate("groupId", "name")
    .sort({ time: 1, createdAt: 1 });

  const totalCalled = rows.length;
  const came = rows.filter((row) => row.attendanceStatus === "keldi").length;
  const didNotCome = rows.filter((row) => row.attendanceStatus === "kelmadi").length;

  const list = rows.map((row) => ({
    attendanceId: row._id,
    student: row.studentId?.fullName || "Deleted student",
    group: row.groupId?.name || "-",
    status: row.attendanceStatus,
    callStatus: row.callStatus,
    comment: row.comment,
    date: formatYMD(row.date),
    time: row.time
  }));

  return ok(res, {
    date,
    summary: {
      totalCalled,
      came,
      didNotCome
    },
    list
  });
});

const getRecentActivity = asyncHandler(async (req, res) => {
  const { date, status = "Barchasi", search = "", sort = "date-desc" } = req.query;

  const query = {};
  if (date) {
    query.date = date;
  }

  const rows = await CoddyAttendance.find(query).sort({ date: -1, time: -1, createdAt: -1 });
  const staff = await loadActiveStaffForMatching();

  const q = String(search || "").trim().toLowerCase();

  let mapped = rows
    .map((row) => ({
      id: row._id,
      date: row.date,
      time: row.time,
      mentor: resolveMentorNameFromWorkers(row.mainTeacher, staff),
      group: row.studentGroup,
      student: row.studentName,
      status: row.status || "Keldi",
      comment: row.topic,
      ta: row.teacherName,
      source: "bot"
    }))
    .filter((row) => {
      if (!q) return true;
      const haystack = [row.student, row.group, row.mentor, row.ta, row.comment, row.status]
        .map((part) => String(part || "").toLowerCase())
        .join(" ");
      return haystack.includes(q);
    });

  if (status !== "Barchasi") {
    mapped = mapped.filter((row) => row.status === status);
  }

  if (sort === "date-asc") {
    mapped.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  } else if (sort === "student-asc") {
    mapped.sort((a, b) => String(a.student).localeCompare(String(b.student)));
  } else if (sort === "student-desc") {
    mapped.sort((a, b) => String(b.student).localeCompare(String(a.student)));
  } else {
    mapped.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }

  return ok(res, mapped, "Recent activity list");
});

const telegramWebhook = asyncHandler(async (req, res) => {
  if (env.telegramWebhookSecret) {
    const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (incomingSecret !== env.telegramWebhookSecret) {
      throw new ApiError(401, "Invalid telegram webhook secret");
    }
  }

  const callback = req.body?.callback_query;
  if (!callback || !callback.data) {
    return ok(res, { ignored: true }, "No callback data");
  }

  const [statusRaw, attendanceId] = callback.data.split(":");
  const status = statusRaw === "keldi" ? "keldi" : statusRaw === "kelmadi" ? "kelmadi" : null;

  if (!status || !attendanceId) {
    throw new ApiError(400, "Invalid callback payload");
  }

  const attendance = await Attendance.findById(attendanceId);
  if (!attendance) {
    throw new ApiError(404, "Attendance record not found");
  }

  const updated = await updateAttendanceStatus({
    attendance,
    newStatus: status,
    changedBy: null,
    source: "bot"
  });

  return ok(res, updated, "Attendance status updated from bot callback");
});

module.exports = {
  manualAttendance,
  queueTaNotification,
  callStudent,
  confirmArrival,
  updateStatus,
  recallStudent,
  getCalledList,
  getDailyReport,
  getRecentActivity,
  telegramWebhook
};

