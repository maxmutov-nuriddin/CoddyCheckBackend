const mongoose = require("mongoose");

const taNotificationTaskSchema = new mongoose.Schema(
  {
    studentName: {
      type: String,
      required: true,
      trim: true
    },
    direction: {
      type: String,
      enum: ["web", "design"],
      required: true
    },
    date: {
      type: Date,
      required: true,
      index: true
    },
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
      enum: ["pending", "sent", "failed"],
      default: "pending",
      index: true
    },
    sentAt: {
      type: Date,
      default: null
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    }
  },
  { timestamps: true }
);

taNotificationTaskSchema.index({ date: 1, status: 1, direction: 1 });

module.exports = mongoose.model("TaNotificationTask", taNotificationTaskSchema);
