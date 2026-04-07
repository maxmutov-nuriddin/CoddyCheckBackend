const mongoose = require("mongoose");

const attendanceStatusLogSchema = new mongoose.Schema(
  {
    attendanceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Attendance",
      required: true,
      index: true
    },
    previousStatus: {
      type: String,
      enum: ["keldi", "kelmadi", null],
      default: null
    },
    newStatus: {
      type: String,
      enum: ["keldi", "kelmadi"],
      required: true
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    source: {
      type: String,
      enum: ["manual", "cron", "bot"],
      default: "manual"
    },
    kuratorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("AttendanceStatusLog", attendanceStatusLogSchema);
