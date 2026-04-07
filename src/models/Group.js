const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    days: {
      type: String,
      enum: ["Toq", "Juft"],
      required: true
    },
    time: {
      type: String,
      required: true,
      trim: true
    },
    mentor: {
      type: String,
      required: true,
      trim: true
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

module.exports = mongoose.model("Group", groupSchema);
