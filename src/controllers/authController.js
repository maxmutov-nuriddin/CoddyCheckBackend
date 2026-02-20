const User = require("../models/User");
const Group = require("../models/Group");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");
const CalledStudent = require("../models/CalledStudent");
const TaNotificationTask = require("../models/TaNotificationTask");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const CoddyTeacher = require("../coddyCheck/models/CoddyTeacher");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");
const { signToken } = require("../services/tokenService");

function normalizeRole(inputRole) {
  const raw = String(inputRole || "kurator").trim().toLowerCase();
  if (raw === "curator") return "kurator";
  return raw;
}

function normalizePhone(payload) {
  const raw = String(payload.phone || payload.phoneNumber || payload.tel || "").trim();
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

function normalizeFullName(payload) {
  const value = payload.fullName || payload.name || "";
  return String(value).trim();
}

const register = asyncHandler(async (req, res) => {
  const fullName = normalizeFullName(req.body);
  const phone = normalizePhone(req.body);
  const telegramId = req.body.telegramId;
  const password = String(req.body.password || "").trim();

  if (!fullName || !phone) {
    throw new ApiError(400, "Ism va telefon raqam kiritilishi shart");
  }

  if (!password) {
    throw new ApiError(400, "Parol kiritilishi shart");
  }

  // Only one account allowed in the system
  const existingCount = await User.countDocuments({ role: "kurator" });
  if (existingCount > 0) {
    throw new ApiError(403, "Tizimda allaqachon akkaunt mavjud. Yangi ro'yxatdan o'tish mumkin emas.");
  }

  const user = await User.create({
    fullName,
    role: "kurator",
    phone,
    telegramId,
    password,
  });

  const token = signToken(user);

  return created(
    res,
    {
      token,
      user: {
        _id: user._id,
        fullName: user.fullName,
        role: user.role,
        phone: user.phone,
        telegramId: user.telegramId,
      },
    },
    "Kurator registered"
  );
});

const login = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body);
  const password = String(req.body.password || "").trim();

  if (!phone || !password) {
    throw new ApiError(400, "phone and password are required");
  }

  const user = await User.findOne({ phone, role: "kurator" }).select("+password");
  if (!user) {
    throw new ApiError(401, "Invalid credentials. Kurator not found for this phone");
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid credentials. Please re-register this phone once");
  }

  if (!user.isActive) {
    throw new ApiError(403, "User is inactive");
  }

  const token = signToken(user);

  return ok(
    res,
    {
      token,
      user: {
        _id: user._id,
        fullName: user.fullName,
        role: user.role,
        phone: user.phone,
        telegramId: user.telegramId
      }
    },
    "Logged in"
  );
});

const getMe = asyncHandler(async (req, res) => {
  const user = req.user;
  return ok(res, {
    _id: user._id,
    fullName: user.fullName,
    role: user.role,
    phone: user.phone,
    telegramId: user.telegramId
  });
});

const updateProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  const fullName = normalizeFullName(req.body);
  const phone = normalizePhone(req.body);
  const { telegramId } = req.body;

  if (fullName) user.fullName = fullName;

  if (phone) {
    const existing = await User.findOne({ phone, _id: { $ne: user._id } });
    if (existing) throw new ApiError(409, "Bu telefon raqam allaqachon ishlatilmoqda");
    user.phone = phone;
  }

  if (telegramId !== undefined) user.telegramId = telegramId || null;

  await user.save();

  return ok(res, {
    _id: user._id,
    fullName: user.fullName,
    role: user.role,
    phone: user.phone,
    telegramId: user.telegramId
  }, "Profil yangilandi");
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new ApiError(400, "Joriy va yangi parol kiritilishi shart");
  }

  if (String(newPassword).length < 4) {
    throw new ApiError(400, "Yangi parol kamida 4 ta belgidan iborat bo'lishi kerak");
  }

  const user = await User.findById(req.user._id).select("+password");
  const isValid = await user.comparePassword(String(currentPassword));
  if (!isValid) {
    throw new ApiError(401, "Joriy parol noto'g'ri");
  }

  user.password = String(newPassword);
  await user.save();

  return ok(res, null, "Parol muvaffaqiyatli o'zgartirildi");
});

const deleteAccount = asyncHandler(async (req, res) => {
  // Single-curator system: wipe ALL data from every collection
  await Promise.all([
    AttendanceStatusLog.deleteMany({}),
    Attendance.deleteMany({}),
    CalledStudent.deleteMany({}),
    TaNotificationTask.deleteMany({}),
    CoddyAttendance.deleteMany({}),
    CoddyTeacher.deleteMany({}),
  ]);

  await Student.deleteMany({});
  await Group.deleteMany({});
  await User.deleteMany({});

  return ok(res, null, "Akkaunt va barcha ma'lumotlar o'chirildi");
});

module.exports = {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  deleteAccount
};
