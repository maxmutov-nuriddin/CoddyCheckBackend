const mongoose = require("mongoose");
const connectDb = require("../src/config/db");
const CoddyAttendance = require("../src/coddyCheck/models/CoddyAttendance");
const Student = require("../src/models/Student");
const CalledStudent = require("../src/models/CalledStudent");
const { getDayBounds, formatYMD } = require("../src/utils/date");

function normalizeText(value) {
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
  return "pending";
}

function toDayStart(dateInput) {
  try {
    return getDayBounds(dateInput).start;
  } catch {
    return null;
  }
}

async function resolveStudentForBotRow(studentName, dayStart, cache) {
  const key = normalizeText(studentName).toLowerCase();
  if (!key) return null;

  let candidates = cache.get(key);
  if (!candidates) {
    const fullNameRegex = new RegExp(`^${escapeRegExp(studentName)}$`, "i");
    candidates = await Student.find({ fullName: fullNameRegex, isActive: true })
      .select("_id groupId")
      .lean();
    cache.set(key, candidates);
  }

  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const candidateIds = candidates.map((item) => item._id);
  const preferred = await CalledStudent.findOne({
    studentId: { $in: candidateIds },
    date: dayStart
  })
    .select("studentId")
    .lean();

  if (preferred?.studentId) {
    const matched = candidates.find((item) => String(item._id) === String(preferred.studentId));
    if (matched) return matched;
  }

  return candidates[0];
}

async function run() {
  await connectDb();
  console.log("Backfill started: bot calls -> called students");

  const rows = await CoddyAttendance.find({
    requestType: { $in: ["call_extra", "keep"] }
  })
    .sort({ createdAt: 1 })
    .lean();

  const stats = {
    totalBotRows: rows.length,
    processed: 0,
    createdRecords: 0,
    updatedRecords: 0,
    appendedCalls: 0,
    touchedExistingCalls: 0,
    skippedNoStudentName: 0,
    skippedNoDate: 0,
    skippedStudentNotFound: 0
  };

  const studentCache = new Map();

  for (const row of rows) {
    const studentName = normalizeText(row?.studentName);
    if (!studentName) {
      stats.skippedNoStudentName += 1;
      continue;
    }

    const dateText = normalizeText(row?.date) || formatYMD(row?.createdAt || new Date());
    const dayStart = toDayStart(dateText);
    if (!dayStart) {
      stats.skippedNoDate += 1;
      continue;
    }

    const student = await resolveStudentForBotRow(studentName, dayStart, studentCache);
    if (!student?._id) {
      stats.skippedStudentNotFound += 1;
      continue;
    }

    const mappedStatus = mapStatusLabelToCalledStatus(row?.status);
    const isResolved = mappedStatus === "keldi" || mappedStatus === "kelmadi";
    const isTrackable = Boolean(row?.callConfirmed) || isResolved;
    if (!isTrackable) {
      continue;
    }
    const timeValue = normalizeText(row?.time);
    const commentValue = normalizeText(row?.topic);
    const calledAt = new Date(row?.confirmedAt || row?.updatedAt || row?.createdAt || new Date());
    const resolvedAt = mappedStatus === "pending" ? null : new Date(row?.updatedAt || calledAt);

    let record = await CalledStudent.findOne({ studentId: student._id, date: dayStart });

    if (!record) {
      await CalledStudent.create({
        studentId: student._id,
        groupId: student.groupId || null,
        date: dayStart,
        callCount: 1,
        calls: [
          {
            time: timeValue,
            comment: commentValue,
            status: mappedStatus,
            calledAt,
            resolvedAt
          }
        ],
        lastStatus: mappedStatus
      });
      stats.createdRecords += 1;
      stats.processed += 1;
      continue;
    }

    if (!Array.isArray(record.calls)) {
      record.calls = [];
    }

    const existingCall = record.calls.find((call) => {
      const ts = new Date(call?.calledAt || 0).getTime();
      return ts === calledAt.getTime();
    });

    if (existingCall) {
      existingCall.time = timeValue;
      existingCall.comment = commentValue;
      existingCall.status = mappedStatus;
      existingCall.resolvedAt = resolvedAt;
      stats.touchedExistingCalls += 1;
    } else {
      record.calls.push({
        time: timeValue,
        comment: commentValue,
        status: mappedStatus,
        calledAt,
        resolvedAt
      });
      record.callCount = Number(record.callCount || 0) + 1;
      stats.appendedCalls += 1;
    }

    record.lastStatus = mappedStatus;
    if (!record.groupId && student.groupId) {
      record.groupId = student.groupId;
    }

    await record.save();
    stats.updatedRecords += 1;
    stats.processed += 1;
  }

  console.log("Backfill done.");
  console.log(JSON.stringify(stats, null, 2));
}

run()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
  });
