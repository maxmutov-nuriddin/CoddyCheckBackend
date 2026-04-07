const Attendance = require("../models/Attendance");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");
const CalledStudent = require("../models/CalledStudent");

async function updateAttendanceStatus({ attendance, newStatus, changedBy, source = "manual" }) {
  const previousStatus = attendance.attendanceStatus;

  attendance.attendanceStatus = newStatus;
  attendance.taId = changedBy || attendance.taId;
  attendance.updatedAt = new Date();
  await attendance.save();

  await AttendanceStatusLog.create({
    attendanceId: attendance._id,
    previousStatus,
    newStatus,
    changedBy,
    source,
    kuratorId: attendance.kuratorId || null
  });

  return attendance;
}

async function syncCalledStudentsForAutoClose(rows, status) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let synced = 0;
  const now = new Date();

  for (const row of rows) {
    if (!row?.studentId || !row?.date) continue;

    const dateObj = new Date(row.date);
    if (Number.isNaN(dateObj.getTime())) continue;

    const start = new Date(dateObj);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateObj);
    end.setHours(23, 59, 59, 999);

    const calledRecord = await CalledStudent.findOne({
      studentId: row.studentId,
      date: { $gte: start, $lte: end }
    }).sort({ createdAt: -1 });

    if (!calledRecord) continue;

    calledRecord.lastStatus = status;

    if (Array.isArray(calledRecord.calls) && calledRecord.calls.length > 0) {
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
    synced += 1;
  }

  return synced;
}

async function autoCloseUnmarkedAttendances(dayStart, dayEnd) {
  const pendingRows = await Attendance.find({
    date: { $gte: dayStart, $lte: dayEnd },
    callStatus: "chaqirilgan",
    attendanceStatus: null
  })
    .select("_id studentId date arrivalConfirmedAt")
    .lean();

  const cameRows = pendingRows.filter((row) => Boolean(row.arrivalConfirmedAt));
  const notCameRows = pendingRows.filter((row) => !row.arrivalConfirmedAt);

  const cameIds = cameRows.map((row) => row._id);
  const notCameIds = notCameRows.map((row) => row._id);

  const markAsCame = cameIds.length > 0
    ? await Attendance.updateMany(
      { _id: { $in: cameIds } },
      {
        $set: {
          attendanceStatus: "keldi",
          comment: "Auto set by system: arrival confirmation found"
        }
      }
    )
    : { modifiedCount: 0 };

  const markAsNotCame = notCameIds.length > 0
    ? await Attendance.updateMany(
      { _id: { $in: notCameIds } },
      {
        $set: {
          attendanceStatus: "kelmadi",
          comment: "Auto set by system at end of day"
        }
      }
    )
    : { modifiedCount: 0 };

  const calledSyncedCame = await syncCalledStudentsForAutoClose(cameRows, "keldi");
  const calledSyncedNotCame = await syncCalledStudentsForAutoClose(notCameRows, "kelmadi");

  return {
    markAsCame: markAsCame.modifiedCount,
    markAsNotCame: markAsNotCame.modifiedCount,
    calledSyncedCame,
    calledSyncedNotCame
  };
}

module.exports = {
  updateAttendanceStatus,
  autoCloseUnmarkedAttendances
};
