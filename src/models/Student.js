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
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Student", studentSchema);
