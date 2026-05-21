const mongoose = require("mongoose");

const callEntrySchema = new mongoose.Schema({
   time: {
      type: String,
      default: ""
   },
   comment: {
      type: String,
      default: ""
   },
   status: {
      type: String,
      enum: ["pending", "keldi", "kelmadi"],
      default: "pending"
   },
   taComment: {
      type: String,
      default: ""
   },
   calledAt: {
      type: Date,
      default: Date.now
   },
   resolvedAt: {
      type: Date,
      default: null
   }
});

const calledStudentSchema = new mongoose.Schema({
   studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true
   },
   groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: false,
      default: null
   },
   date: {
      type: Date,
      required: true
   },
   callCount: {
      type: Number,
      default: 0
   },
   calls: [callEntrySchema],
   lastStatus: {
      type: String,
      enum: ["pending", "keldi", "kelmadi"],
      default: "pending"
   },
   kuratorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
   }
}, { timestamps: true });

// Ensure one record per student per day
calledStudentSchema.index({ studentId: 1, date: 1 }, { unique: true });
// Guruhlar page called counters: date-filtered list (daily)
calledStudentSchema.index({ date: -1, createdAt: -1 });
// getCalledStudents / getResults / analytics: kuratorId + date range queries
calledStudentSchema.index({ kuratorId: 1, date: -1 });

module.exports = mongoose.model("CalledStudent", calledStudentSchema);
