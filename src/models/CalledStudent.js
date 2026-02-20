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
   calledAt: {
      type: Date,
      default: Date.now
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
      required: true
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
   }
}, { timestamps: true });

// Ensure one record per student per day
calledStudentSchema.index({ studentId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("CalledStudent", calledStudentSchema);
