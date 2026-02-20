const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    role: {
      type: String,
      enum: ["kurator", "ta", "mentor", "mentor_ta"],
      required: true
    },
    specialization: {
      type: String,
      enum: ["web", "design", "both"],
      default: "both"
    },
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    telegramId: {
      type: String,
      trim: true,
      default: null
    },
    password: {
      type: String,
      required: true,
      minlength: 4,
      select: false
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

// Bot auth: findOne({ telegramId, isActive:true, role:$in }) — fires on every bot message
userSchema.index({ telegramId: 1, isActive: 1, role: 1 });
// Analytics + cron: User.find({ role:$in, isActive:true }) — fires every 30s refresh
userSchema.index({ role: 1, isActive: 1 });

userSchema.pre("save", async function hashPassword(next) {
  if (!this.isModified("password")) {
    return next();
  }

  this.password = await bcrypt.hash(this.password, 10);
  return next();
});

userSchema.methods.comparePassword = function comparePassword(rawPassword) {
  return bcrypt.compare(rawPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);

