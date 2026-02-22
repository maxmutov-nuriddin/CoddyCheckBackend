const Attendance = require("../models/Attendance");
const Student = require("../models/Student");
const CalledStudent = require("../models/CalledStudent");
const TaNotificationTask = require("../models/TaNotificationTask");
const User = require("../models/User");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");
const { getDayBounds, formatYMD } = require("../utils/date");
const { updateAttendanceStatus } = require("../services/attendanceService");
const env = require("../config/env");
const { loadActiveStaffForMatching, resolveMentorNameFromWorkers } = require("../coddyCheck/utils/mentorNameResolver");
const { getBotInstance } = require("../coddyCheck/bot");

function toComparableTelegramIds(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const result = new Set([raw]);
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    result.add(String(asNumber));
  }
  return Array.from(result);
}

function formatGroupDisplay(name) {
  if (!name) return "-";
  // Add space between letters and numbers
  let spaced = String(name)
    .replace(/([a-zA-Z]+)(\d+)/g, "$1 $2")
    .replace(/(\d+)([a-zA-Z]+)/g, "$1 $2");
  // Collapse multiple spaces
  spaced = spaced.replace(/\s+/g, " ").trim();
  // Capitalize first letter
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

async function loadKuratorTelegramIdSet() {
  const kurators = await User.find({ role: "kurator", isActive: true })
    .select("telegramId")
    .lean();

  const set = new Set();
  for (const item of kurators) {
    const ids = toComparableTelegramIds(item?.telegramId);
    ids.forEach((id) => set.add(id));
  }
  return set;
}

function resolveRequesterRole(row, roleByTelegramId) {
  const explicitRole = String(row?.requesterRole || "").trim().toLowerCase();
  if (explicitRole) return explicitRole;

  const teacherIds = toComparableTelegramIds(row?.teacherId);
  for (const id of teacherIds) {
    const mapped = String(roleByTelegramId.get(id) || "").trim().toLowerCase();
    if (mapped) return mapped;
  }

  return "unknown";
}

function buildRoleByTelegramIdMap(staff) {
  const map = new Map();
  (staff || [])
    .filter((item) => item && item.telegramId)
    .forEach((item) => {
      const role = String(item.role || "unknown").toLowerCase();
      const ids = toComparableTelegramIds(item.telegramId);
      ids.forEach((id) => map.set(id, role));
    });
  return map;
}

function isKuratorBotRow(row, roleByTelegramId, kuratorTelegramIdSet) {
  const requesterRole = resolveRequesterRole(row, roleByTelegramId);
  if (requesterRole === "kurator") return true;
  const teacherIds = toComparableTelegramIds(row?.teacherId);
  return teacherIds.some((id) => kuratorTelegramIdSet.has(id));
}

function isKuratorWebRow(row) {
  const mentorRole = String(row?.mentorId?.role || "").toLowerCase();
  const taRole = String(row?.taId?.role || "").toLowerCase();
  return mentorRole === "kurator" || taRole === "kurator";
}

function parseTimeMinutes(value) {
  const text = String(value || "").trim();
  const m = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

function choosePreferredActivityRow(existing, candidate) {
  const existingTime = parseTimeMinutes(existing?.time);
  const candidateTime = parseTimeMinutes(candidate?.time);
  if (candidateTime > existingTime) return candidate;
  if (candidateTime < existingTime) return existing;

  const existingSource = String(existing?.source || "").toLowerCase();
  const candidateSource = String(candidate?.source || "").toLowerCase();
  if (candidateSource === "web" && existingSource !== "web") return candidate;
  if (existingSource === "web" && candidateSource !== "web") return existing;

  const existingUpdated = new Date(existing?.updatedAt || existing?.createdAt || 0).getTime();
  const candidateUpdated = new Date(candidate?.updatedAt || candidate?.createdAt || 0).getTime();
  if (candidateUpdated > existingUpdated) return candidate;

  return existing;
}

function dedupeActivityRows(rows) {
  const map = new Map();

  rows.forEach((row) => {
    const key = [
      String(row?.date || "").trim(),
      String(row?.student || "").trim().toLowerCase(),
      String(row?.group || "").trim().toLowerCase(),
      String(row?.status || "").trim().toLowerCase()
    ].join("|");

    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      return;
    }

    map.set(key, choosePreferredActivityRow(existing, row));
  });

  return Array.from(map.values());
}

function normalizeDateOnly(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "Invalid date format");
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildDateTime(dateInput, timeInput) {
  if (!timeInput || timeInput === "Kun davomida") {
    return null;
  }

  const date = new Date(dateInput);
  const [hourStr, minuteStr] = String(timeInput).split(":");
  const hours = Number(hourStr);
  const minutes = Number(minuteStr);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new ApiError(400, "Invalid time format, expected HH:mm or 'Kun davomida'");
  }

  date.setHours(hours, minutes, 0, 0);
  return date;
}

function normalizeDirection(input) {
  const value = String(input || "").trim().toLowerCase();
  return value === "web" || value === "design" ? value : null;
}

function inferDirectionFromGroupName(groupName) {
  const normalized = String(groupName || "").trim().toLowerCase();
  return normalized.includes("design") ? "design" : "web";
}

function normalizeOptionalTime(input) {
  const value = String(input || "").trim();
  if (!value) return "";

  if (value === "Kun davomida") {
    return value;
  }

  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    throw new ApiError(400, "time must be HH:mm format or 'Kun davomida'");
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
  if (now.getHours() >= 9) {
    defaultDate.setDate(defaultDate.getDate() + 1);
  }

  defaultDate.setHours(0, 0, 0, 0);
  return defaultDate;
}

async function syncCalledStudentStatus({ studentId, date, status }) {
  if (!studentId || !date || !["keldi", "kelmadi"].includes(status)) {
    return null;
  }

  const normalizedDate = normalizeDateOnly(date);
  const calledRecord = await CalledStudent.findOne({ studentId, date: normalizedDate }).sort({ createdAt: -1 });
  if (!calledRecord) return null;

  calledRecord.lastStatus = status;

  if (Array.isArray(calledRecord.calls) && calledRecord.calls.length > 0) {
    const now = new Date();
    let targetCall = null;

    for (let i = calledRecord.calls.length - 1; i >= 0; i -= 1) {
      if (calledRecord.calls[i].status === "pending") {
        targetCall = calledRecord.calls[i];
        break;
      }
    }

    if (!targetCall) {
      targetCall = calledRecord.calls[calledRecord.calls.length - 1];
    }

    targetCall.status = status;
    targetCall.resolvedAt = now;
  }

  await calledRecord.save();
  return calledRecord;
}

const manualAttendance = asyncHandler(async (req, res) => {
  const { studentId, date, attendanceStatus, comment = "" } = req.body;

  if (!studentId || !date || !attendanceStatus) {
    throw new ApiError(400, "studentId, date and attendanceStatus are required");
  }

  if (!["keldi", "kelmadi"].includes(attendanceStatus)) {
    throw new ApiError(400, "attendanceStatus must be keldi or kelmadi");
  }

  const student = await Student.findById(studentId).lean();
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  const normalizedDate = normalizeDateOnly(date);
  const dayStr = formatYMD(normalizedDate);

  // 1. Check if an Attendance record exists for today
  let attendance = await Attendance.findOne({ studentId, date: normalizedDate });
  if (attendance) {
    if (attendance.attendanceStatus) {
      // It has a final mark (Keldi/Kelmadi), block.
      throw new ApiError(400, `Ushbu o'quvchi bugun uchun allaqachon belgilangan (${attendance.attendanceStatus}).`);
    }
  }

  // 2. Reconciliation: Try to find a pending bot call request for this student today
  const botCallRequests = await CoddyAttendance.find({
    studentName: student.fullName,
    date: dayStr,
    requestType: { $in: ["call_extra", "keep"] },
    status: "Kutilmoqda"
  });

  for (const botReq of botCallRequests) {
    botReq.status = attendanceStatus === "keldi" ? "Keldi" : "Kelmadi";
    await botReq.save();

    // Notify mentor if they arrived
    if (attendanceStatus === "keldi") {
      const bot = getBotInstance();
      if (bot && botReq.teacherId) {
        bot.telegram.sendMessage(
          botReq.teacherId,
          `✅ **O'quvchingiz keldi!**\n\nIsm: ${student.fullName}\nGuruh: ${student.groupName || botReq.studentGroup}\nSana: ${dayStr}`,
          { parse_mode: "Markdown" }
        ).catch(err => console.error("Telegram notify error:", err.message));
      }
    }
  }

  if (attendance) {
    // Update existing pending call record to final status
    attendance.attendanceStatus = attendanceStatus;
    attendance.comment = comment || attendance.comment;
    attendance.taId = req.user._id;
    attendance.callStatus = "chaqirilgan"; // If it existed but was null, it was a call
    await attendance.save();
    await syncCalledStudentStatus({ studentId: attendance.studentId, date: normalizedDate, status: attendanceStatus });
    return ok(res, attendance, "Attendance reconciled with existing call");
  }

  // Determine if it was called (reconciling with bot search)
  const wasCalled = botCallRequests.length > 0;

  // 3. Create fresh attendance record
  attendance = await Attendance.create({
    studentId,
    groupId: student.groupId,
    taId: req.user._id,
    date: normalizedDate,
    time: null,
    callStatus: wasCalled ? "chaqirilgan" : "chaqirilmagan",
    attendanceStatus,
    comment,
    botIntegration: wasCalled
  });

  await syncCalledStudentStatus({ studentId: attendance.studentId, date: normalizedDate, status: attendanceStatus });

  return created(res, attendance, wasCalled ? "Manual arrival reconciled" : "Manual attendance created");
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

  return created(res, task, "TA xabarnomasi 09:00 uchun rejalashtirildi");
});

const confirmBotCallRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, time = "", comment = "" } = req.body;

  const request = await CoddyAttendance.findById(id);
  if (!request) {
    throw new ApiError(404, "Bot so'rovi topilmadi");
  }

  const requestType = String(request.requestType || "").toLowerCase();
  if (requestType !== "call_extra" && requestType !== "keep") {
    throw new ApiError(400, "Faqat chaqirish so'rovlari tasdiqlanadi");
  }

  if (request.callConfirmed) {
    return ok(res, request, "So'rov allaqachon tasdiqlangan");
  }

  const notifyDate = resolveNotifyDate(date);
  const notifyTime = normalizeOptionalTime(time);
  const direction = inferDirectionFromGroupName(request.studentGroup);
  const normalizedComment = String(comment || request.topic || "").trim();

  const task = await TaNotificationTask.create({
    studentName: request.studentName,
    direction,
    date: notifyDate,
    time: notifyTime,
    comment: normalizedComment,
    createdBy: req.user._id
  });

  request.callConfirmed = true;
  request.confirmedAt = new Date();
  request.status = "Kutilmoqda";
  request.date = formatYMD(notifyDate);
  request.time = notifyTime || request.time;
  if (normalizedComment) {
    request.topic = normalizedComment;
  }

  await request.save();

  // Notify the requester (mentor/TA) via Telegram
  const bot = getBotInstance();
  if (bot && request.teacherId) {
    const message = [
      `🔔 **O'quvchingiz chaqirildi**`,
      `O'quvchi: ${request.studentName}`,
      `Guruh: ${request.studentGroup}`,
      `Sana: ${request.date}`,
      `Vaqt: ${request.time || "belgilanmagan"}`
    ].join("\n");

    bot.telegram.sendMessage(request.teacherId, message, { parse_mode: "Markdown" }).catch((err) => {
      console.error(`Failed to notify requester ${request.teacherId}:`, err.message);
    });
  }

  return ok(
    res,
    {
      request,
      task
    },
    "Bot so'rovi chaqirildi sifatida tasdiqlandi"
  );
});

const callStudent = asyncHandler(async (req, res) => {
  const { studentId, date, time, comment = "" } = req.body;

  if (!studentId || !date) {
    throw new ApiError(400, "studentId and date are required");
  }

  const student = await Student.findById(studentId).lean();
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  const normalizedDate = normalizeDateOnly(date);
  const dayStr = formatYMD(normalizedDate);

  // Duplicate check Web: Verify if student already has a record for this date
  const existingWeb = await Attendance.findOne({ studentId, date: normalizedDate });
  if (existingWeb) {
    if (existingWeb.attendanceStatus) {
      // It has a final mark (Keldi/Kelmadi), block.
      throw new ApiError(400, `Bu o'quvchi bugun uchun allaqachon belgilangan (${existingWeb.attendanceStatus}).`);
    }
    // It's just a call record, allow updating it
    existingWeb.time = buildDateTime(normalizedDate, time);
    existingWeb.comment = comment || existingWeb.comment;
    existingWeb.mentorId = req.user._id;
    await existingWeb.save();
    return ok(res, existingWeb, "Attendance call updated");

  }

  // Duplicate check Bot: Verify if student is already in bot activity for this date
  const existingBot = await CoddyAttendance.findOne({
    studentName: student.fullName,
    date: dayStr,
    requestType: "mark"
  });
  if (existingBot) {
    throw new ApiError(400, `Bu o'quvchi bot orqali allaqachon belgilangan.`);
  }

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

  await syncCalledStudentStatus({ studentId: updated.studentId, date: updated.date, status: attendanceStatus });

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
    .populate("mentorId", "fullName role")
    .populate("taId", "fullName role")
    .sort({ time: 1, createdAt: 1 })
    .lean();

  const filteredRows = rows.filter((row) => !isKuratorWebRow(row));
  return ok(res, filteredRows, "Called students list");
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
    .populate("mentorId", "fullName role")
    .populate("taId", "fullName role")
    .sort({ time: 1, createdAt: 1 })
    .lean();

  const filteredRows = rows.filter((row) => !isKuratorWebRow(row));
  const totalCalled = filteredRows.length;
  const came = filteredRows.filter((row) => row.attendanceStatus === "keldi").length;
  const didNotCome = filteredRows.filter((row) => row.attendanceStatus === "kelmadi").length;

  const list = filteredRows.map((row) => ({
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

const getResults = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, groupBy = "day" } = req.query;

  const start = dateFrom ? new Date(dateFrom) : new Date();
  const end = dateTo ? new Date(dateTo) : new Date();
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  const filter = {
    date: { $gte: start, $lte: end }
  };

  const botMatch = {
    date: { $gte: formatYMD(start), $lte: formatYMD(end) }
  };

  const [attendanceRowsRaw, botRowsRaw, platformCallsRaw, staff, kuratorTelegramIdSet, totalActiveStudents] = await Promise.all([
    Attendance.find(filter).lean(),
    CoddyAttendance.find(botMatch).lean(),
    CalledStudent.find(filter).lean(),
    loadActiveStaffForMatching(),
    loadKuratorTelegramIdSet(),
    Student.countDocuments({ isActive: true })
  ]);

  const roleByTelegramId = buildRoleByTelegramIdMap(staff);

  const attendanceRows = attendanceRowsRaw.filter((row) => !isKuratorWebRow(row));
  const botRows = botRowsRaw.filter((row) => !isKuratorBotRow(row, roleByTelegramId, kuratorTelegramIdSet));

  const resultsMap = new Map();
  const uniqueArrivedStudents = new Set();

  const processRow = (dateStr, isInvited, isAttended, isMissed, studentId = null) => {
    let groupKey = dateStr;
    if (groupBy === "week") {
      const d = new Date(dateStr);
      const first = d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1);
      const monday = new Date(d.setDate(first));
      groupKey = `Hafta: ${formatYMD(monday)}`;
    } else if (groupBy === "month") {
      groupKey = dateStr.slice(0, 7); // YYYY-MM
    }

    if (!resultsMap.has(groupKey)) {
      resultsMap.set(groupKey, { period: groupKey, total: 0, came: 0, invitedCame: 0, missed: 0 });
    }
    const stats = resultsMap.get(groupKey);

    if (isInvited) stats.total = (stats.total || 0) + 1;
    if (isAttended) {
      stats.came = (stats.came || 0) + 1;
      if (studentId) uniqueArrivedStudents.add(String(studentId));
    }
    if (isInvited && isAttended) stats.invitedCame = (stats.invitedCame || 0) + 1;
    if (isInvited && isMissed) stats.missed = (stats.missed || 0) + 1;
  };

  attendanceRows.forEach(r => {
    const isInvited = r.callStatus === "chaqirilgan";
    const isAttended = r.attendanceStatus === "keldi";
    const isMissed = r.attendanceStatus === "kelmadi";
    processRow(formatYMD(r.date), isInvited, isAttended, isMissed, r.studentId);
  });

  botRows.forEach(r => {
    const isInvited = r.callConfirmed === true && ["call_extra", "keep"].includes(r.requestType);
    const isAttended = r.status === "Keldi";
    const isMissed = r.status === "Kelmadi";
    const studentIdentifier = r.studentId || r.studentName || r.phone;
    processRow(r.date, isInvited, isAttended, isMissed, studentIdentifier);
  });

  platformCallsRaw.forEach(r => {
    const isInvited = true;
    const isAttended = r.lastStatus === "keldi";
    const isMissed = r.lastStatus === "kelmadi";
    processRow(formatYMD(r.date), isInvited, isAttended, isMissed, r.studentId);
  });

  const list = Array.from(resultsMap.values()).sort((a, b) => b.period.localeCompare(a.period));

  return ok(res, {
    dateFrom: formatYMD(start),
    dateTo: formatYMD(end),
    groupBy,
    totalActiveStudents,
    uniqueArrivedCount: uniqueArrivedStudents.size,
    list
  }, "Results list");
});

const getRecentActivity = asyncHandler(async (req, res) => {
  const { date, status = "Barchasi", search = "", sort = "date-desc" } = req.query;

  const coddyQuery = {};
  const attendanceQuery = {};

  if (date) {
    const { start, end } = getDayBounds(date);
    const dayStr = formatYMD(start);
    // Bot so'rovlari: yoki berilgan sanaga mos keladiganlar, yoki hali tasdiqlanmaganlar (hammasi)
    coddyQuery.$or = [{ date: dayStr }, { callConfirmed: false }];
    attendanceQuery.date = { $gte: start, $lte: end };
  }

  const [botRows, webRows, staff, kuratorTelegramIdSet] = await Promise.all([
    CoddyAttendance.find(coddyQuery).sort({ createdAt: -1 }).lean(),
    Attendance.find(attendanceQuery)
      .populate("studentId", "fullName")
      .populate("groupId", "name")
      .populate("mentorId", "fullName role")
      .populate("taId", "fullName role")
      .sort({ date: -1, time: -1, createdAt: -1 })
      .lean(),
    loadActiveStaffForMatching(),
    loadKuratorTelegramIdSet()
  ]);

  const q = String(search || "").trim().toLowerCase();

  const roleByTelegramId = buildRoleByTelegramIdMap(staff);

  const mappedBot = botRows
    .filter((row) => !isKuratorBotRow(row, roleByTelegramId, kuratorTelegramIdSet))
    .map((row) => ({
      id: `bot-${row._id}`,
      date: row.date || "-",
      time: row.time || "-",
      mentor: resolveMentorNameFromWorkers(row.mainTeacher, staff),
      group: row.studentGroup,
      student: row.studentName,
      status: row.status || "Keldi",
      comment: row.topic,
      ta: row.teacherName,
      source: "bot",
      requestType: row.requestType || "mark",
      requesterRole: resolveRequesterRole(row, roleByTelegramId),
      callConfirmed: typeof row.callConfirmed === "boolean" ? row.callConfirmed : String(row.requestType || "").toLowerCase() === "mark",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));

  const mappedWeb = webRows
    .filter((row) => !isKuratorWebRow(row))
    .map((row) => {
      const statusLabel =
        row.attendanceStatus === "keldi"
          ? "Keldi"
          : row.attendanceStatus === "kelmadi"
            ? "Kelmadi"
            : "Kutilmoqda";

      const timeLabel = row.time ? new Date(row.time).toTimeString().slice(0, 5) : "--:--";

      return {
        id: `web-${row._id}`,
        date: formatYMD(row.date),
        time: timeLabel,
        mentor: row.mentorId?.fullName || "-",
        group: row.groupId?.name || "-",
        student: row.studentId?.fullName || "Deleted student",
        status: statusLabel,
        comment: row.comment || "",
        ta: row.taId?.fullName || "-",
        source: "web",
        callStatus: row.callStatus || "chaqirilmagan",
        requestType: "web_attendance",
        requesterRole: "web",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    });

  let mapped = dedupeActivityRows([...mappedWeb, ...mappedBot]).filter((row) => {
    if (!q) return true;
    const haystack = [row.student, row.group, row.mentor, row.ta, row.comment, row.status, row.callStatus]
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

  await syncCalledStudentStatus({ studentId: updated.studentId, date: updated.date, status });

  return ok(res, updated, "Attendance status updated from bot callback");
});

const deleteActivity = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (id.startsWith("bot-")) {
    const coddyId = id.slice(4);
    const request = await CoddyAttendance.findById(coddyId);
    if (request && request.callConfirmed === false && request.teacherId) {
      const bot = getBotInstance();
      if (bot) {
        const message = [
          `❌ **So'rovingiz rad etildi**`,
          ``,
          `O'quvchi: ${request.studentName}`,
          `Guruh: ${request.studentGroup}`,
          ``,
          `Sizning ushbu o'quvchini chaqirish bo'yicha so'rovingiz Kurator tomonidan rad etildi.`
        ].join("\n");

        bot.telegram.sendMessage(request.teacherId, message, { parse_mode: "Markdown" }).catch((err) => {
          console.error(`Failed to notify rejection to ${request.teacherId}:`, err.message);
        });
      }
    }
    await CoddyAttendance.findByIdAndDelete(coddyId);
  } else {
    await Attendance.findByIdAndDelete(id);
  }

  return ok(res, null, "Record deleted permanently");
});

const getAllActivity = asyncHandler(async (req, res) => {
  const { date, status = "Barchasi", search = "", sort = "date-desc" } = req.query;

  // Only "mark" requestType from bot — excludes oquvchi_chaqirish (call_extra, keep)
  const coddyQuery = { requestType: "mark" };
  const attendanceQuery = {};

  if (date) {
    const { start, end } = getDayBounds(date);
    const dayStr = formatYMD(start);
    coddyQuery.date = dayStr;
    attendanceQuery.date = { $gte: start, $lte: end };
  }

  const [botRows, webRows, staff, kuratorTelegramIdSet] = await Promise.all([
    CoddyAttendance.find(coddyQuery).sort({ createdAt: -1 }).lean(),
    Attendance.find(attendanceQuery)
      .populate("studentId", "fullName")
      .populate("groupId", "name")
      .populate("mentorId", "fullName role")
      .populate("taId", "fullName role")
      .sort({ date: -1, time: -1, createdAt: -1 })
      .lean(),
    loadActiveStaffForMatching(),
    loadKuratorTelegramIdSet()
  ]);

  const q = String(search || "").trim().toLowerCase();
  const roleByTelegramId = buildRoleByTelegramIdMap(staff);

  const mappedBot = botRows
    .filter((row) => !isKuratorBotRow(row, roleByTelegramId, kuratorTelegramIdSet))
    .map((row) => ({
      id: `bot-${row._id}`,
      date: row.date || "-",
      time: row.time || "-",
      mentor: resolveMentorNameFromWorkers(row.mainTeacher, staff),
      group: formatGroupDisplay(row.studentGroup),
      student: row.studentName,
      status: row.status || "Keldi",
      comment: row.topic,
      ta: row.teacherName,
      source: "bot",
      requestType: row.requestType || "mark",
      requesterRole: resolveRequesterRole(row, roleByTelegramId),
      callConfirmed: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));

  const mappedWeb = webRows
    .filter((row) => !isKuratorWebRow(row))
    .map((row) => {
      const statusLabel =
        row.attendanceStatus === "keldi"
          ? "Keldi"
          : row.attendanceStatus === "kelmadi"
            ? "Kelmadi"
            : "Kutilmoqda";

      const timeLabel = row.time ? new Date(row.time).toTimeString().slice(0, 5) : "--:--";

      return {
        id: `web-${row._id}`,
        date: formatYMD(row.date),
        time: timeLabel,
        mentor: row.mentorId?.fullName || "-",
        group: row.groupId?.name || "-",
        student: row.studentId?.fullName || "Deleted student",
        status: statusLabel,
        comment: row.comment || "",
        ta: row.taId?.fullName || "-",
        source: "web",
        callStatus: row.callStatus || "chaqirilmagan",
        requestType: "web_attendance",
        requesterRole: "web",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    });

  let mapped = dedupeActivityRows([...mappedWeb, ...mappedBot])
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

  return ok(res, mapped, "All activity list");
});

const getBotCalls = asyncHandler(async (req, res) => {
  const { sort = "date-desc", date } = req.query;

  // Only oquvchi_chaqirish records (call_extra, keep) — NOT shown in So'nggi faollik
  const coddyQuery = { requestType: { $in: ["call_extra", "keep"] } };

  if (date) {
    const dateStr = formatYMD(date);
    const { start, end } = getDayBounds(date);

    coddyQuery.$or = [
      { date: dateStr },
      {
        callConfirmed: false,
        $or: [{ date: { $exists: false } }, { date: null }, { date: "" }],
        createdAt: { $gte: start, $lte: end }
      }
    ];
  }

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : null;

  const [botRows, staff, kuratorTelegramIdSet] = await Promise.all([
    CoddyAttendance.find(coddyQuery)
      .sort({ createdAt: -1 })
      .limit(limit || 0)
      .lean(),
    loadActiveStaffForMatching(),
    loadKuratorTelegramIdSet()
  ]);

  const roleByTelegramId = buildRoleByTelegramIdMap(staff);

  let mapped = botRows
    .filter((row) => !isKuratorBotRow(row, roleByTelegramId, kuratorTelegramIdSet))
    .map((row) => ({
      id: `bot-${row._id}`,
      date: row.date || "-",
      time: row.time || "-",
      mentor: resolveMentorNameFromWorkers(row.mainTeacher, staff),
      group: formatGroupDisplay(row.studentGroup),
      student: row.studentName,
      status: row.status || "Kutilmoqda",
      comment: row.topic,
      ta: row.teacherName,
      source: "bot",
      requestType: row.requestType,
      requesterRole: resolveRequesterRole(row, roleByTelegramId),
      callConfirmed: typeof row.callConfirmed === "boolean" ? row.callConfirmed : false
    }));

  if (sort === "date-asc") {
    mapped.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  } else {
    mapped.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }

  return ok(res, mapped, "Bot calls list");
});

const createCalledStudent = asyncHandler(async (req, res) => {
  const { studentId, date, time = "", comment = "" } = req.body;

  if (!studentId || !date) throw new ApiError(400, "studentId and date are required");

  const student = await Student.findById(studentId).lean();
  if (!student) throw new ApiError(404, "Student not found");

  const normalizedDate = normalizeDateOnly(date);
  const callEntry = {
    time: String(time || "").trim(),
    comment: String(comment || "").trim(),
    status: "pending",
    calledAt: new Date()
  };

  const record = await CalledStudent.findOneAndUpdate(
    { studentId, date: normalizedDate },
    {
      $inc: { callCount: 1 },
      $push: { calls: callEntry },
      $set: { lastStatus: "pending" },
      $setOnInsert: { groupId: student.groupId || undefined }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return ok(res, record, "Call record saved");
});

const getCalledStudents = asyncHandler(async (req, res) => {
  const date = req.query.date;
  let filter = {};
  if (date) {
    const { start, end } = getDayBounds(date);
    filter = { date: { $gte: start, $lte: end } };
  }

  const rows = await CalledStudent.find(filter)
    .populate("studentId", "fullName")
    .populate("groupId", "name mentor")
    .sort({ date: -1, createdAt: -1 })
    .lean();

  return ok(res, rows, "Called students list");
});

const deleteCalledStudent = asyncHandler(async (req, res) => {
  await CalledStudent.findByIdAndDelete(req.params.id);
  return ok(res, null, "Record deleted");
});

const updateActivity = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment, status } = req.body;

  if (id.startsWith("bot-")) {
    const botId = id.slice(4);
    const updateData = {};
    if (typeof comment !== "undefined") updateData.topic = comment;
    if (typeof status !== "undefined") updateData.status = status;

    const updated = await CoddyAttendance.findByIdAndUpdate(botId, updateData, { new: true });
    if (!updated) throw new ApiError(404, "Bot activity not found");
    return ok(res, updated, "Bot activity updated");
  } else if (id.startsWith("web-")) {
    const webId = id.slice(4);
    const updateData = {};
    if (typeof comment !== "undefined") updateData.comment = comment;
    if (typeof status !== "undefined") {
      updateData.attendanceStatus = status === "Kutilmoqda" ? null : status === "Keldi" ? "keldi" : "kelmadi";
    }

    const updated = await Attendance.findByIdAndUpdate(webId, updateData, { new: true });
    if (!updated) throw new ApiError(404, "Web activity not found");
    return ok(res, updated, "Web activity updated");
  }

  throw new ApiError(400, "Invalid activity ID format");
});

const updateCalledStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment, status } = req.body;

  const record = await CalledStudent.findById(id);
  if (!record) throw new ApiError(404, "Called student record not found");

  if (typeof status !== "undefined") {
    record.lastStatus = status === "Kutilmoqda" ? "pending" : status.toLowerCase();
  }

  if (typeof comment !== "undefined" && record.calls.length > 0) {
    // Update the comment of the most recent call
    record.calls[record.calls.length - 1].comment = comment;
    if (status) {
      record.calls[record.calls.length - 1].status = status === "Kutilmoqda" ? "pending" : status.toLowerCase();
    }
  }

  await record.save();

  // Sync with Attendance model for consistency (AttendancePage / Guruhlar)
  try {
    const matchingAttendance = await Attendance.findOne({
      studentId: record.studentId,
      date: record.date
    });
    if (matchingAttendance) {
      if (typeof comment !== "undefined") matchingAttendance.comment = comment;
      if (typeof status !== "undefined") {
        matchingAttendance.attendanceStatus = (status === "Kutilmoqda" || status === "pending") ? null : status.toLowerCase();
      }
      await matchingAttendance.save();
    }
  } catch (syncErr) {
    console.error("Failed to sync CalledStudent update to Attendance:", syncErr.message);
  }

  return ok(res, record, "Called student record updated");
});

module.exports = {
  manualAttendance,
  queueTaNotification,
  confirmBotCallRequest,
  callStudent,
  confirmArrival,
  updateStatus,
  recallStudent,
  getCalledList,
  getDailyReport,
  getResults,
  getRecentActivity,
  telegramWebhook,
  deleteActivity,
  getAllActivity,
  getBotCalls,
  createCalledStudent,
  getCalledStudents,
  deleteCalledStudent,
  updateActivity,
  updateCalledStudent
};














