const mongoose = require("mongoose");

const talkEntrySchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true
  },
  comment: {
    type: String,
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const studentTalkSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      unique: true
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: false,
      default: null
    },
    talkCount: {
      type: Number,
      default: 0
    },
    talks: [talkEntrySchema]
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudentTalk", studentTalkSchema);
