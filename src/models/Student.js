const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: false
    },
    frozenStatus: {
      type: String,
      enum: ["average", "frozen", "poor", "good", "lead", "qarzdor", "qaytadi", "muzlatilgan", null],
      default: "good"
    },
    comment: {
      type: String,
      default: ""
    },
    profileUrl: {
      type: String,
      default: ""
    },
    isActive: {
      type: Boolean,
      default: true
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

// getStudents + analytics countDocuments: { isActive: true } — most-used filter
studentSchema.index({ isActive: 1 });
// analytics studentsByMentor aggregate joins groupId then filters isActive
studentSchema.index({ groupId: 1, isActive: 1 });
// Multi-kurator isolation
studentSchema.index({ kuratorId: 1, isActive: 1 });

module.exports = mongoose.model("Student", studentSchema);
