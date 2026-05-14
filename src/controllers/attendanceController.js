const Attendance = require("../models/Attendance");
const Student = require("../models/Student");
const Group = require("../models/Group");
const CalledStudent = require("../models/CalledStudent");
const StudentTalk = require("../models/StudentTalk");
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

const FROZEN_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];

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

let _kuratorIdSetCache = null;
let _kuratorIdSetExpiresAt = 0;
const KURATOR_ID_SET_TTL_MS = 60_000;

async function loadKuratorTelegramIdSet() {
  const now = Date.now();
  if (_kuratorIdSetCache && _kuratorIdSetExpiresAt > now) {
    return _kuratorIdSetCache;
  }
  const kurators = await User.find({ role: "kurator", isActive: true })
    .select("telegramId")
    .lean();

  const set = new Set();
  for (const item of kurators) {
    const ids = toComparableTelegramIds(item?.telegramId);
    ids.forEach((id) => set.add(id));
  }
  _kuratorIdSetCache = set;
  _kuratorIdSetExpiresAt = now + KURATOR_ID_SET_TTL_MS;
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

function parseObjectIdCsv(input, maxItems = 2000) {
  const items = String(input || "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[a-f\d]{24}$/i.test(part));

  if (!items.length) return [];
  return Array.from(new Set(items)).slice(0, maxItems);
}

function isAttendanceLiteRequest(req) {
  return String(req?.query?.lite || "").toLowerCase() === "attendance";
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

function normalizeCompactText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapStatusLabelToCalledStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "keldi") return "keldi";
  if (normalized === "kelmadi") return "kelmadi";
  if (normalized === "kutilmoqda" || normalized === "pending") return "pending";
  return null;
}

function getTodayYmdInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value || "0000";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";
  return `${year}-${month}-${day}`;
}

async function syncBotCallActivityToCalledStudent(botRow, changes = {}) {
  const requestType = String(botRow?.requestType || "").toLowerCase();
  if (!["call_extra", "keep"].includes(requestType)) return null;

  const studentName = normalizeCompactText(botRow?.studentName);
  if (!studentName) return null;

  const targetDateRaw = normalizeCompactText(
    typeof changes.date !== "undefined" && changes.date ? changes.date : botRow?.date
  );
  if (!targetDateRaw || targetDateRaw === "-") return null;

  let targetDay = null;
  try {
    targetDay = getDayBounds(targetDateRaw).start;
  } catch {
    return null;
  }

  const statusLabel = typeof changes.status !== "undefined" ? changes.status : botRow?.status;
  const mappedStatus = mapStatusLabelToCalledStatus(statusLabel) || "pending";
  const isResolved = mappedStatus === "keldi" || mappedStatus === "kelmadi";
  const callConfirmedFlag =
    typeof changes.callConfirmed !== "undefined"
      ? Boolean(changes.callConfirmed)
      : Boolean(botRow?.callConfirmed);

  // Do not track plain bot "So'rov" rows in CalledStudent history
  // until they are confirmed (or resolved manually to keldi/kelmadi).
  if (!callConfirmedFlag && !isResolved) {
    return null;
  }
  const timeValue = normalizeCompactText(typeof changes.time !== "undefined" ? changes.time : botRow?.time);
  const commentValue = normalizeCompactText(typeof changes.comment !== "undefined" ? changes.comment : botRow?.topic);

  const fullNameRegex = new RegExp(`^${escapeRegExp(studentName)}$`, "i");
  const candidates = await Student.find({ fullName: fullNameRegex, isActive: true })
    .select("_id groupId kuratorId")
    .lean();
  if (!candidates.length) return null;

  let targetStudent = candidates[0];
  if (candidates.length > 1) {
    const candidateIds = candidates.map((item) => item._id);
    const preferred = await CalledStudent.findOne({
      studentId: { $in: candidateIds },
      date: targetDay
    }).select("studentId").lean();

    if (preferred?.studentId) {
      const matched = candidates.find((item) => String(item._id) === String(preferred.studentId));
      if (matched) targetStudent = matched;
    }
  }

  const botKuratorId = targetStudent.kuratorId || null;

  let record = await CalledStudent.findOne({ studentId: targetStudent._id, date: targetDay });

  if (!record && changes.previousDate) {
    try {
      const previousDay = getDayBounds(changes.previousDate).start;
      record = await CalledStudent.findOne({ studentId: targetStudent._id, date: previousDay });
      if (record) {
        record.date = targetDay;
      }
    } catch {
      // ignore invalid previousDate format
    }
  }

  if (!record) {
    return CalledStudent.create({
      studentId: targetStudent._id,
      groupId: targetStudent.groupId || null,
      date: targetDay,
      callCount: 1,
      calls: [{
        time: timeValue,
        comment: commentValue,
        status: mappedStatus,
        calledAt: new Date(),
        resolvedAt: isResolved ? new Date() : null
      }],
      lastStatus: mappedStatus,
      kuratorId: botKuratorId
    });
  }

  if (!Array.isArray(record.calls)) {
    record.calls = [];
  }

  if (record.calls.length === 0) {
    record.calls.push({
      time: timeValue,
      comment: commentValue,
      status: mappedStatus,
      calledAt: new Date(),
      resolvedAt: isResolved ? new Date() : null
    });
    record.callCount = Math.max(Number(record.callCount) || 0, 1);
  } else {
    const lastCall = record.calls[record.calls.length - 1];
    if (typeof changes.time !== "undefined") {
      lastCall.time = timeValue;
    }
    if (typeof changes.comment !== "undefined") {
      lastCall.comment = commentValue;
    }
    if (typeof changes.status !== "undefined") {
      lastCall.status = mappedStatus;
      lastCall.resolvedAt = isResolved ? new Date() : null;
    }
  }

  if (typeof changes.status !== "undefined") {
    record.lastStatus = mappedStatus;
  } else if (!record.lastStatus) {
    record.lastStatus = "pending";
  }

  if (!record.groupId && targetStudent.groupId) {
    record.groupId = targetStudent.groupId;
  }

  await record.save();
  return record;
}

const _reconciledDates = new Map();
const RECONCILE_TTL_MS = 2 * 60_000;

async function reconcileBotCallsToCalledStudentsByDate(dateInput) {
  let day;
  try {
    day = getDayBounds(dateInput).start;
  } catch {
    return;
  }

  const ymd = formatYMD(day);

  const cacheExpiry = _reconciledDates.get(ymd);
  if (cacheExpiry && cacheExpiry > Date.now()) {
    return;
  }

  const botRows = await CoddyAttendance.find({
    requestType: { $in: ["call_extra", "keep"] },
    date: ymd,
    $or: [
      { callConfirmed: true },
      { status: { $in: ["Keldi", "Kelmadi"] } }
    ]
  }).lean();

  if (!botRows.length) {
    _reconciledDates.set(ymd, Date.now() + RECONCILE_TTL_MS);
    return;
  }

  for (const row of botRows) {
    try {
      await syncBotCallActivityToCalledStudent(row);
    } catch (error) {
      console.error("Failed to reconcile bot call row to CalledStudent:", error.message);
    }
  }

  _reconciledDates.set(ymd, Date.now() + RECONCILE_TTL_MS);
}

const manualAttendance = asyncHandler(async (req, res) => {
  const { studentId, date, attendanceStatus, comment = "" } = req.body;
  const kuratorId = req.user._id;

  if (!studentId || !date || !attendanceStatus) {
    throw new ApiError(400, "studentId, date and attendanceStatus are required");
  }

  if (!["keldi", "kelmadi"].includes(attendanceStatus)) {
    throw new ApiError(400, "attendanceStatus must be keldi or kelmadi");
  }

  const student = await Student.findOne({ _id: studentId, kuratorId }).lean();
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  const normalizedDate = normalizeDateOnly(date);
  const dayStr = formatYMD(normalizedDate);

  // 1. Check if an Attendance record exists for today
  let attendance = await Attendance.findOne({ studentId, date: normalizedDate, kuratorId });
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
    botIntegration: wasCalled,
    kuratorId
  });

  await syncCalledStudentStatus({ studentId: attendance.studentId, date: normalizedDate, status: attendanceStatus });

  return created(res, attendance, wasCalled ? "Manual arrival reconciled" : "Manual attendance created");
});

const queueTaNotification = asyncHandler(async (req, res) => {
  const { studentName, direction, date, time = "", comment = "" } = req.body;
  const kuratorId = req.user._id;
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
    createdBy: kuratorId,
    kuratorId
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
    createdBy: req.user._id,
    kuratorId: req.user._id
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
  const kuratorId = req.user._id;

  if (!studentId || !date) {
    throw new ApiError(400, "studentId and date are required");
  }

  const student = await Student.findOne({ _id: studentId, kuratorId }).lean();
  if (!student) {
    throw new ApiError(404, "Student not found");
  }

  const normalizedDate = normalizeDateOnly(date);
  const dayStr = formatYMD(normalizedDate);
  const { start, end } = getDayBounds(normalizedDate);

  // Only one active (pending) call is allowed per student per day.
  // If previous calls are finalized (keldi/kelmadi), a new call is allowed.
  const pendingWebCall = await Attendance.findOne({
    studentId,
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan",
    attendanceStatus: null,
    kuratorId
  }).sort({ createdAt: -1 });

  if (pendingWebCall) {
    throw new ApiError(400, "Bu o'quvchi shu sana uchun allaqachon chaqirilgan (Kutilmoqda). Avval statusni belgilang.");
  }

  // Duplicate check Bot call requests for this date: So'rov or Kutilmoqda -> block.
  const pendingBotCall = await CoddyAttendance.findOne({
    studentName: student.fullName,
    date: dayStr,
    requestType: { $in: ["call_extra", "keep"] },
    $or: [{ callConfirmed: false }, { status: "Kutilmoqda" }]
  });

  if (pendingBotCall) {
    throw new ApiError(400, "Bu o'quvchi shu sana uchun botda allaqachon So'rov/Kutilmoqda holatda.");
  }

  // Bot "mark" rows are blocked only while pending.
  const pendingBotMark = await CoddyAttendance.findOne({
    studentName: student.fullName,
    date: dayStr,
    requestType: "mark",
    status: "Kutilmoqda"
  });
  if (pendingBotMark) {
    throw new ApiError(400, "Bu o'quvchi bot orqali shu sana uchun Kutilmoqda holatda.");
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
    botIntegration: true,
    kuratorId
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
    botIntegration: true,
    kuratorId: previous.kuratorId || req.user._id
  });

  return created(res, newRecord, "Student re-called successfully");

});

const getCalledList = asyncHandler(async (req, res) => {
  const date = req.query.date || formatYMD(new Date());
  const { start, end } = getDayBounds(date);
  const kuratorId = req.user._id;

  const rows = await Attendance.find({
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan",
    kuratorId
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
  const kuratorId = req.user._id;

  const rows = await Attendance.find({
    date: { $gte: start, $lte: end },
    callStatus: "chaqirilgan",
    kuratorId
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
  const kuratorId = req.user._id;

  const start = dateFrom ? new Date(dateFrom) : new Date();
  const end = dateTo ? new Date(dateTo) : new Date();
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  const filter = {
    date: { $gte: start, $lte: end },
    kuratorId
  };

  const botMatch = {
    date: { $gte: formatYMD(start), $lte: formatYMD(end) }
  };

  const [attendanceRowsRaw, botRowsRaw, staff, kuratorTelegramIdSet, totalActiveStudents] = await Promise.all([
    Attendance.find(filter).lean(),
    CoddyAttendance.find(botMatch).lean(),
    loadActiveStaffForMatching(),
    loadKuratorTelegramIdSet(),
    Student.countDocuments({ isActive: true, frozenStatus: { $nin: FROZEN_STATUSES }, kuratorId })
  ]);

  const botDatesForReconcile = Array.from(
    new Set(
      botRowsRaw
        .filter((row) => {
          const requestType = String(row?.requestType || "").toLowerCase();
          if (!["call_extra", "keep"].includes(requestType)) return false;
          if (!row?.date) return false;
          const status = String(row?.status || "");
          return Boolean(row?.callConfirmed) || status === "Keldi" || status === "Kelmadi";
        })
        .map((row) => String(row.date))
    )
  );

  if (botDatesForReconcile.length > 0) {
    await Promise.all(
      botDatesForReconcile.map((dateStr) =>
        reconcileBotCallsToCalledStudentsByDate(dateStr).catch((error) => {
          console.error(`Failed to reconcile bot calls for ${dateStr}:`, error.message);
        })
      )
    );
  }

  const platformCallsRaw = await CalledStudent.find({ ...filter, kuratorId }).lean();

  const roleByTelegramId = buildRoleByTelegramIdMap(staff);
  const todayYmd = getTodayYmdInTimezone(env.appTimezone);

  const attendanceRows = attendanceRowsRaw.filter((row) => !isKuratorWebRow(row));
  const botRows = botRowsRaw.filter((row) => !isKuratorBotRow(row, roleByTelegramId, kuratorTelegramIdSet));

  const resultsMap = new Map();
  const uniqueArrivedStudents = new Set();
  const uniqueCameByGroup = new Map();
  const invitedByDateStudent = new Set();
  const invitedCameByDateStudent = new Set();
  const invitedMissedByDateStudent = new Set();
  const attendedByDateStudent = new Set();

  const processRow = (dateStr, isInvited, isAttended, isMissed, studentId = null, isInvitedAttended = false) => {
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
      resultsMap.set(groupKey, { period: groupKey, total: 0, came: 0, uniqueCame: 0, invitedCame: 0, missed: 0 });
    }
    const stats = resultsMap.get(groupKey);
    const studentKey = studentId ? String(studentId).trim() : "";
    const dayStudentKey = studentKey ? `${dateStr}|${studentKey}` : "";
    const shouldDedupByStudent = Boolean(dayStudentKey);

    if (isInvited) {
      if (!shouldDedupByStudent || !invitedByDateStudent.has(dayStudentKey)) {
        stats.total = (stats.total || 0) + 1;
        if (shouldDedupByStudent) invitedByDateStudent.add(dayStudentKey);
      }
    }
    if (isAttended) {
      const isNewAttendedRow = !shouldDedupByStudent || !attendedByDateStudent.has(dayStudentKey);
      if (isNewAttendedRow) {
        stats.came = (stats.came || 0) + 1;
        if (shouldDedupByStudent) attendedByDateStudent.add(dayStudentKey);

        if (studentKey) {
          if (!uniqueCameByGroup.has(groupKey)) {
            uniqueCameByGroup.set(groupKey, new Set());
          }
          const cameSet = uniqueCameByGroup.get(groupKey);
          cameSet.add(studentKey);
          stats.uniqueCame = cameSet.size;
          uniqueArrivedStudents.add(studentKey);
        } else {
          stats.uniqueCame = Math.max(Number(stats.uniqueCame || 0), Number(stats.came || 0));
        }
      }
    }
    if (isInvitedAttended || (isInvited && isAttended)) {
      if (!shouldDedupByStudent || !invitedCameByDateStudent.has(dayStudentKey)) {
        stats.invitedCame = (stats.invitedCame || 0) + 1;
        if (shouldDedupByStudent) invitedCameByDateStudent.add(dayStudentKey);
      }
    }
    if (isInvited && isMissed) {
      if (!shouldDedupByStudent || !invitedMissedByDateStudent.has(dayStudentKey)) {
        stats.missed = (stats.missed || 0) + 1;
        if (shouldDedupByStudent) invitedMissedByDateStudent.add(dayStudentKey);
      }
    }
  };

  // attendanceRows: faqat "kelganlar" soniga (isAttended). Chaqirilganlar CalledStudent dan olinadi.
  attendanceRows.forEach(r => {
    const isAttended = r.attendanceStatus === "keldi";
    if (!isAttended) return;
    const dateStr = formatYMD(r.date);
    processRow(dateStr, false, isAttended, false, r.studentId, false);
  });

  // botRows: faqat mark yozuvlari "kelganlar" soniga. Chaqirilganlar CalledStudent dan olinadi.
  botRows.forEach(r => {
    const requestType = String(r.requestType || "").toLowerCase();
    const status = String(r.status || "");
    const isAttended = requestType === "mark" && status === "Keldi" && r.webSync !== true;
    if (!isAttended) return;
    const dateStr = r.date;
    const studentIdentifier = r.studentId || r.studentName || r.phone;
    processRow(dateStr, false, isAttended, false, studentIdentifier, false);
  });

  // platformCallsRaw (CalledStudent): chaqirilganlar uchun YAGONA manba.
  // unique index {studentId, date} — har bir o'quvchi uchun kuniga bitta yozuv, dedup kerak emas.
  platformCallsRaw.forEach(r => {
    const dateStr = formatYMD(r.date);
    const studentIdentifier = r.studentId ? String(r.studentId) : null;
    const lastStatus = String(r.lastStatus || "").toLowerCase();
    const isInvited = lastStatus === "keldi" || lastStatus === "kelmadi" || lastStatus === "pending";
    if (!isInvited) return;
    const isHistoricalPending = lastStatus === "pending" && dateStr < todayYmd;
    const isMissed = lastStatus === "kelmadi" || isHistoricalPending;
    const isInvitedAttended = lastStatus === "keldi";
    processRow(dateStr, isInvited, false, isMissed, studentIdentifier, isInvitedAttended);
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
  const kuratorId = req.user._id;

  const coddyQuery = { requestType: { $ne: "talk_request" } };
  const attendanceQuery = { kuratorId };

  if (date) {
    const { start, end } = getDayBounds(date);
    const dayStr = formatYMD(start);
    // Bot so'rovlari: yoki berilgan sanaga mos keladiganlar, yoki hali tasdiqlanmaganlar (hammasi)
    coddyQuery.$or = [{ date: dayStr }, { callConfirmed: false }];
    attendanceQuery.date = { $gte: start, $lte: end };
  }


  const fetchLimit = date ? 0 : 500;

  const [botRows, webRows, staff, kuratorTelegramIdSet] = await Promise.all([
    CoddyAttendance.find(coddyQuery).sort({ createdAt: -1 }).limit(fetchLimit).lean(),
    Attendance.find(attendanceQuery)
      .populate("studentId", "fullName")
      .populate("groupId", "name")
      .populate("mentorId", "fullName role")
      .populate("taId", "fullName role")
      .sort({ date: -1, time: -1, createdAt: -1 })
      .limit(fetchLimit)
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
    const requestType = String(request?.requestType || "").toLowerCase();
    const isCallRequest = requestType === "call_extra" || requestType === "keep";
    const isTalkRequest = requestType === "talk_request";
    const skipNotify = req.query.skipNotify === "true";
    if (!skipNotify && request && isCallRequest && request.callConfirmed === false && request.teacherId) {
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
    if (!skipNotify && request && isTalkRequest && request.teacherId) {
      const bot = getBotInstance();
      if (bot) {
        const message = [
          "❌ Murojatingiz qabul qilinmadi.",
          `O'quvchi: ${request.studentName || "-"}`,
          `Guruh: ${request.studentGroup || "-"}`
        ].join("\n");

        bot.telegram.sendMessage(request.teacherId, message).catch((err) => {
          console.error(`Failed to notify talk rejection to ${request.teacherId}:`, err.message);
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
  const kuratorId = req.user._id;

  // Only "mark" requestType from bot — excludes oquvchi_chaqirish (call_extra, keep)
  const coddyQuery = { requestType: "mark" };
  const attendanceQuery = { kuratorId };

  if (date) {
    const { start, end } = getDayBounds(date);
    const dayStr = formatYMD(start);
    coddyQuery.date = dayStr;
    attendanceQuery.date = { $gte: start, $lte: end };
  }

  const fetchLimit = date ? 0 : 500;

  const [botRows, webRows, staff, kuratorTelegramIdSet] = await Promise.all([
    CoddyAttendance.find(coddyQuery).sort({ createdAt: -1 }).limit(fetchLimit).lean(),
    Attendance.find(attendanceQuery)
      .populate("studentId", "fullName")
      .populate("groupId", "name")
      .populate("mentorId", "fullName role")
      .populate("taId", "fullName role")
      .sort({ date: -1, time: -1, createdAt: -1 })
      .limit(fetchLimit)
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

  // oquvchi_chaqirish + murojat records — NOT shown in So'nggi faollik
  const coddyQuery = { requestType: { $in: ["call_extra", "keep", "talk_request"] } };

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
  const kuratorId = req.user._id;

  if (!studentId || !date) throw new ApiError(400, "studentId and date are required");

  const student = await Student.findOne({ _id: studentId, kuratorId }).lean();
  if (!student) throw new ApiError(404, "Student not found");

  const normalizedDate = normalizeDateOnly(date);
  const existingRecord = await CalledStudent.findOne({ studentId, date: normalizedDate, kuratorId });
  if (existingRecord) {
    const latestCall = Array.isArray(existingRecord.calls) && existingRecord.calls.length > 0
      ? existingRecord.calls[existingRecord.calls.length - 1]
      : null;
    const hasPending =
      existingRecord.lastStatus === "pending" ||
      String(latestCall?.status || "").toLowerCase() === "pending";

    if (hasPending) {
      throw new ApiError(400, "Bu o'quvchi shu sana uchun allaqachon chaqirilgan (Kutilmoqda).");
    }
  }

  const callEntry = {
    time: String(time || "").trim(),
    comment: String(comment || "").trim(),
    status: "pending",
    calledAt: new Date()
  };

  const record = await CalledStudent.findOneAndUpdate(
    { studentId, date: normalizedDate, kuratorId },
    {
      $inc: { callCount: 1 },
      $push: { calls: callEntry },
      $set: { lastStatus: "pending" },
      $setOnInsert: { groupId: student.groupId || undefined, kuratorId }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return ok(res, record, "Call record saved");
});

const createStudentTalk = asyncHandler(async (req, res) => {
  const { studentId, date, comment = "" } = req.body;

  if (!studentId) throw new ApiError(400, "studentId is required");

  const student = await Student.findById(studentId).lean();
  if (!student) throw new ApiError(404, "Student not found");

  const normalizedDate = date ? normalizeDateOnly(date) : normalizeDateOnly(new Date());
  const talkEntry = {
    date: normalizedDate,
    comment: String(comment || "").trim(),
    createdAt: new Date()
  };

  const record = await StudentTalk.findOneAndUpdate(
    { studentId },
    {
      $inc: { talkCount: 1 },
      $push: { talks: talkEntry },
      $setOnInsert: { groupId: student.groupId || undefined }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return ok(res, record, "Student talk saved");
});

const resolveBotTalkRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { curatorComment = "" } = req.body;

  const request = await CoddyAttendance.findById(id);
  if (!request) {
    throw new ApiError(404, "Bot so'rovi topilmadi");
  }

  if (String(request.requestType || "").toLowerCase() !== "talk_request") {
    throw new ApiError(400, "Faqat murojat so'rovi uchun ruxsat berilgan");
  }

  const mentorComment = normalizeCompactText(request.topic);
  if (!mentorComment) {
    throw new ApiError(400, "Mentor izohi topilmadi");
  }

  const studentName = normalizeCompactText(request.studentName);
  if (!studentName) {
    throw new ApiError(400, "O'quvchi nomi topilmadi");
  }

  const studentNameRegex = new RegExp(`^${escapeRegExp(studentName)}$`, "i");
  const candidates = await Student.find({ fullName: studentNameRegex, isActive: true })
    .select("_id groupId fullName")
    .lean();

  if (!candidates.length) {
    throw new ApiError(404, "Murojat uchun o'quvchi topilmadi");
  }

  let targetStudent = candidates[0];
  if (candidates.length > 1) {
    const groupName = normalizeCompactText(request.studentGroup);
    if (groupName) {
      const groupRegex = new RegExp(`^${escapeRegExp(groupName)}$`, "i");
      const matchedGroups = await Group.find({ name: groupRegex }).select("_id").lean();
      if (matchedGroups.length > 0) {
        const matchedGroupIds = new Set(matchedGroups.map((g) => String(g._id)));
        const byGroup = candidates.find((s) => s.groupId && matchedGroupIds.has(String(s.groupId)));
        if (byGroup) {
          targetStudent = byGroup;
        }
      }
    }
  }

  let talkDate = normalizeDateOnly(new Date());
  if (request.date) {
    try {
      talkDate = normalizeDateOnly(request.date);
    } catch {
      // keep today
    }
  }

  const curatorCommentText = normalizeCompactText(curatorComment);
  const mergedComment = curatorCommentText
    ? `Mentor murojati: ${mentorComment}\nKurator izohi: ${curatorCommentText}`
    : `Mentor murojati: ${mentorComment}`;

  const talkEntry = {
    date: talkDate,
    comment: mergedComment,
    createdAt: new Date()
  };

  const talkRecord = await StudentTalk.findOneAndUpdate(
    { studentId: targetStudent._id },
    {
      $inc: { talkCount: 1 },
      $push: { talks: talkEntry },
      $setOnInsert: { groupId: targetStudent.groupId || undefined }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (request.teacherId) {
    const bot = getBotInstance();
    if (bot) {
      const deliveredMessage = [
        "✅ Murojatingiz yetqazildi.",
        `O'quvchi: ${request.studentName || "-"}`,
        `Guruh: ${request.studentGroup || "-"}`
      ].join("\n");

      bot.telegram.sendMessage(request.teacherId, deliveredMessage).catch((err) => {
        console.error(`Failed to notify talk delivery to ${request.teacherId}:`, err.message);
      });
    }
  }

  await CoddyAttendance.findByIdAndDelete(id);

  return ok(
    res,
    {
      removedRequestId: id,
      talkRecord
    },
    "Murojat gaplashildi holatiga o'tkazildi"
  );
});

const getStudentTalks = asyncHandler(async (req, res) => {
  const { studentId, studentIds } = req.query;
  const filter = {};
  const parsedStudentIds = parseObjectIdCsv(studentIds);
  const liteMode = isAttendanceLiteRequest(req);

  if (studentId) {
    filter.studentId = studentId;
  } else if (parsedStudentIds.length > 0) {
    filter.studentId = { $in: parsedStudentIds };
  }

  let query = StudentTalk.find(filter)
    .populate("studentId", "fullName")
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  if (!liteMode) {
    query = query.populate("groupId", "name mentor");
  }

  const rows = await query;

  const normalizedRows = rows.map((row) => {
    const talks = Array.isArray(row.talks) ? row.talks.slice() : [];
    talks.sort((a, b) => {
      const aDate = new Date(a?.date || a?.createdAt || 0).getTime();
      const bDate = new Date(b?.date || b?.createdAt || 0).getTime();
      if (bDate !== aDate) return bDate - aDate;
      const aCreated = new Date(a?.createdAt || 0).getTime();
      const bCreated = new Date(b?.createdAt || 0).getTime();
      return bCreated - aCreated;
    });

    return {
      ...row,
      talks,
      talkCount: Number(row?.talkCount || talks.length || 0)
    };
  });

  return ok(res, normalizedRows, "Student talks list");
});

const deleteStudentTalkEntry = asyncHandler(async (req, res) => {
  const { recordId, talkId } = req.params;

  if (!recordId || !talkId) {
    throw new ApiError(400, "recordId and talkId are required");
  }

  const record = await StudentTalk.findById(recordId);
  if (!record) {
    throw new ApiError(404, "Student talk record not found");
  }

  const talkEntry = record.talks.id(talkId);
  if (!talkEntry) {
    throw new ApiError(404, "Talk entry not found");
  }

  const createdAt = talkEntry.createdAt ? new Date(talkEntry.createdAt) : new Date(talkEntry.date);
  if (Number.isNaN(createdAt.getTime())) {
    throw new ApiError(400, "Talk entry time is invalid");
  }

  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - createdAt.getTime() > TWENTY_FOUR_HOURS_MS) {
    throw new ApiError(400, "Talk yozuvini faqat 24 soat ichida o'chirish mumkin");
  }

  talkEntry.deleteOne();

  if (!record.talks.length) {
    await StudentTalk.findByIdAndDelete(recordId);
    return ok(res, { removedRecord: true, recordId }, "Talk entry deleted");
  }

  record.talkCount = record.talks.length;
  await record.save();

  return ok(res, { removedRecord: false, record }, "Talk entry deleted");
});

const getCalledStudents = asyncHandler(async (req, res) => {
  const date = req.query.date;
  const studentIds = parseObjectIdCsv(req.query.studentIds);
  const liteMode = isAttendanceLiteRequest(req);
  const kuratorId = req.user._id;
  let filter = { kuratorId };
  if (date) {
    await reconcileBotCallsToCalledStudentsByDate(date);
    const { start, end } = getDayBounds(date);
    filter.date = { $gte: start, $lte: end };
  }
  if (studentIds.length > 0) {
    filter.studentId = { $in: studentIds };
  }

  let query = CalledStudent.find(filter)
    .populate("studentId", "fullName")
    .sort({ date: -1, createdAt: -1 })
    .lean();

  if (!liteMode) {
    query = query.populate("groupId", "name mentor");
  }

  const rows = await query;

  return ok(res, rows, "Called students list");
});

const deleteCalledStudent = asyncHandler(async (req, res) => {
  const record = await CalledStudent.findById(req.params.id).lean();
  if (!record) return ok(res, null, "Record deleted");

  await CalledStudent.findByIdAndDelete(req.params.id);

  // Tegishli Attendance yozuvlarini ham o'chirish (callStudent yaratgan chaqirilgan yozuvlar)
  if (record.studentId && record.date) {
    const { start, end } = getDayBounds(record.date);
    await Attendance.deleteMany({
      studentId: record.studentId,
      date: { $gte: start, $lte: end },
      callStatus: "chaqirilgan"
    });
  }

  return ok(res, null, "Record deleted");
});

const updateActivity = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment, status, date, time } = req.body;

  if (id.startsWith("bot-")) {
    const botId = id.slice(4);
    const row = await CoddyAttendance.findById(botId);
    if (!row) throw new ApiError(404, "Bot activity not found");

    const previousDate = row.date;

    if (typeof comment !== "undefined") row.topic = comment;
    if (typeof status !== "undefined") row.status = status;
    if (typeof date !== "undefined" && date) {
      row.date = formatYMD(getDayBounds(date).start);
    }
    if (typeof time !== "undefined") {
      row.time = time;
    }

    await row.save();

    try {
      await syncBotCallActivityToCalledStudent(row, { comment, status, date, time, previousDate });
    } catch (syncError) {
      console.error("Failed to sync bot activity to CalledStudent:", syncError.message);
    }

    return ok(res, row, "Bot activity updated");
  } else if (id.startsWith("web-")) {
    const webId = id.slice(4);
    const updateData = {};
    if (typeof comment !== "undefined") updateData.comment = comment;
    if (typeof status !== "undefined") {
      updateData.attendanceStatus = status === "Kutilmoqda" ? null : status === "Keldi" ? "keldi" : "kelmadi";
    }
    if (typeof date !== "undefined" && date) {
      updateData.date = getDayBounds(date).start;
    }
    if (typeof time !== "undefined") {
      const normalizedDate = typeof date !== "undefined" && date ? getDayBounds(date).start : null;
      const ymd = formatYMD(normalizedDate || new Date());
      if (time === "Kun davomida") {
        updateData.time = null;
      } else if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(time))) {
        updateData.time = new Date(`${ymd}T${time}:00`);
      }
    }

    const updated = await Attendance.findByIdAndUpdate(webId, updateData, { new: true });
    if (!updated) throw new ApiError(404, "Web activity not found");
    return ok(res, updated, "Web activity updated");
  }

  throw new ApiError(400, "Invalid activity ID format");
});

const updateCalledStudent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment, status, date, time } = req.body;

  const record = await CalledStudent.findById(id);
  if (!record) throw new ApiError(404, "Called student record not found");

  const oldDate = record.date ? new Date(record.date) : null;

  if (typeof date !== "undefined" && date) {
    record.date = getDayBounds(date).start;
  }

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

  if (typeof time !== "undefined" && record.calls.length > 0) {
    record.calls[record.calls.length - 1].time = time;
  }

  await record.save();

  // Sync with Attendance model for consistency (AttendancePage / Guruhlar)
  try {
    let matchingAttendance = null;
    const targetDate = record.date ? new Date(record.date) : null;

    if (oldDate) {
      const oldBounds = getDayBounds(oldDate);
      matchingAttendance = await Attendance.findOne({
        studentId: record.studentId,
        date: { $gte: oldBounds.start, $lte: oldBounds.end }
      });
    }

    if (!matchingAttendance && targetDate) {
      const newBounds = getDayBounds(targetDate);
      matchingAttendance = await Attendance.findOne({
        studentId: record.studentId,
        date: { $gte: newBounds.start, $lte: newBounds.end }
      });
    }

    if (matchingAttendance) {
      if (typeof comment !== "undefined") matchingAttendance.comment = comment;
      if (typeof status !== "undefined") {
        matchingAttendance.attendanceStatus = (status === "Kutilmoqda" || status === "pending") ? null : status.toLowerCase();
      }
      if (typeof date !== "undefined" && date) {
        matchingAttendance.date = getDayBounds(date).start;
      }
      if (typeof time !== "undefined") {
        const effectiveDate = typeof date !== "undefined" && date
          ? getDayBounds(date).start
          : (matchingAttendance.date || targetDate || new Date());
        const ymd = formatYMD(effectiveDate);
        if (time === "Kun davomida") {
          matchingAttendance.time = null;
        } else if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(time))) {
          matchingAttendance.time = new Date(`${ymd}T${time}:00`);
        }
      }
      await matchingAttendance.save();
    }
  } catch (syncErr) {
    console.error("Failed to sync CalledStudent update to Attendance:", syncErr.message);
  }

  return ok(res, record, "Called student record updated");
});

const dismissFromCall = asyncHandler(async (req, res) => {
  const { studentId, studentName, groupName, reason } = req.body;

  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, "Sabab majburiy");
  }

  const cleanReason = normalizeCompactText(reason);

  let student = null;
  if (studentId) {
    student = await Student.findById(studentId)
      .populate("groupId", "name mentor")
      .lean();
  } else if (studentName) {
    const nameRegex = new RegExp(`^${escapeRegExp(normalizeCompactText(studentName))}$`, "i");
    student = await Student.findOne({ fullName: nameRegex, isActive: true })
      .populate("groupId", "name mentor")
      .lean();
  }

  const talkDate = normalizeDateOnly(new Date());
  const talkComment = `Atmen qilindi: ${cleanReason}`;

  if (student?._id) {
    await StudentTalk.findOneAndUpdate(
      { studentId: student._id },
      {
        $inc: { talkCount: 1 },
        $push: { talks: { date: talkDate, comment: talkComment, createdAt: new Date() } },
        $setOnInsert: { groupId: student.groupId?._id || undefined }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const mentorName = student?.groupId?.mentor || normalizeCompactText(groupName);
  if (mentorName) {
    const mentorUser = await User.findOne({
      fullName: new RegExp(`^${escapeRegExp(mentorName)}$`, "i"),
      role: { $in: ["mentor", "mentor_ta"] },
      isActive: true
    }).select("telegramId").lean();

    if (mentorUser?.telegramId) {
      const bot = getBotInstance();
      if (bot) {
        const displayName = student?.fullName || normalizeCompactText(studentName) || "Noma'lum o'quvchi";
        const displayGroup = student?.groupId?.name || normalizeCompactText(groupName) || "-";
        const message = `❌ O'quvchi chaqiruvdan chiqarildi\n\n👤 ${displayName}\n📚 Guruh: ${displayGroup}\n📝 Sabab: ${cleanReason}`;
        bot.telegram.sendMessage(String(mentorUser.telegramId), message).catch((err) => {
          console.error("dismissFromCall: mentor notification error:", err.message);
        });
      }
    }
  }

  return ok(res, { studentId: student?._id || null }, "O'quvchi chaqiruvdan chiqarildi");
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
  createStudentTalk,
  resolveBotTalkRequest,
  getCalledStudents,
  getStudentTalks,
  deleteStudentTalkEntry,
  deleteCalledStudent,
  updateActivity,
  updateCalledStudent,
  dismissFromCall
};














