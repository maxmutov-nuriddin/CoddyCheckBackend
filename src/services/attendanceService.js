const Attendance = require("../models/Attendance");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");

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
    source
  });

  return attendance;
}

async function autoCloseUnmarkedAttendances(dayStart, dayEnd) {
  const markAsCame = await Attendance.updateMany(
    {
      date: { $gte: dayStart, $lte: dayEnd },
      attendanceStatus: null,
      arrivalConfirmedAt: { $ne: null }
    },
    {
      $set: {
        attendanceStatus: "keldi",
        comment: "Auto set by system: arrival confirmation found"
      }
    }
  );

  const markAsNotCame = await Attendance.updateMany(
    {
      date: { $gte: dayStart, $lte: dayEnd },
      attendanceStatus: null
    },
    {
      $set: {
        attendanceStatus: "kelmadi",
        comment: "Auto set by system at end of day"
      }
    }
  );

  return {
    markAsCame: markAsCame.modifiedCount,
    markAsNotCame: markAsNotCame.modifiedCount
  };
}

module.exports = {
  updateAttendanceStatus,
  autoCloseUnmarkedAttendances
};
