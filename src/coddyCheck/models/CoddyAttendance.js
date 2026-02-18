const mongoose = require("mongoose");

const coddyAttendanceSchema = new mongoose.Schema(
  {
    teacherId: {
      type: Number,
      required: true,
      index: true
    },
    teacherName: {
      type: String,
      required: true,
      trim: true
    },
    studentName: {
      type: String,
      required: true,
      trim: true
    },
    studentGroup: {
      type: String,
      required: true,
      trim: true
    },
    mainTeacher: {
      type: String,
      required: true,
      trim: true
    },
    topic: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ["Keldi", "Kelmadi", "Kutilmoqda"],
      default: "Keldi"
    },
    requestType: {
      type: String,
      enum: ["mark", "call_extra", "keep"],
      default: "mark"
    },
    requesterRole: {
      type: String,
      enum: ["mentor", "ta", "mentor_ta", "unknown"],
      default: "unknown"
    },
    callConfirmed: {
      type: Boolean,
      default: false
    },
    confirmedAt: {
      type: Date,
      default: null
    },
    date: {
      type: String,
      required: false,
      index: true
    },
    time: {
      type: String,
      required: false
    }
  },
  { timestamps: true }
);

coddyAttendanceSchema.index({ teacherId: 1, date: 1 });

module.exports = mongoose.model("CoddyAttendance", coddyAttendanceSchema);
