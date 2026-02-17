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
    date: {
      type: String,
      required: true,
      index: true
    },
    time: {
      type: String,
      required: true
    }
  },
  { timestamps: true }
);

coddyAttendanceSchema.index({ teacherId: 1, date: 1 });

module.exports = mongoose.model("CoddyAttendance", coddyAttendanceSchema);
