const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true
    },
    mentorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    taId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    date: {
      type: Date,
      required: true,
      index: true
    },
    time: {
      type: Date,
      default: null
    },
    callStatus: {
      type: String,
      enum: ["chaqirilgan", "chaqirilmagan"],
      required: true,
      default: "chaqirilmagan"
    },
    attendanceStatus: {
      type: String,
      enum: ["keldi", "kelmadi", null],
      default: null
    },
    comment: {
      type: String,
      default: ""
    },
    botIntegration: {
      type: Boolean,
      default: false
    },
    arrivalConfirmedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

attendanceSchema.index({ studentId: 1, date: 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
