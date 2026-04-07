const mongoose = require("mongoose");

const frozenStudentSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      unique: true
    },
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    profileLink: {
      type: String,
      default: ""
    },
    status: {
      type: String,
      default: "muzlatilgan"
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

module.exports = mongoose.model("FrozenStudent", frozenStudentSchema);
