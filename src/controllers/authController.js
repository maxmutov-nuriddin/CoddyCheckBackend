const User = require("../models/User");
const Group = require("../models/Group");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");
const CalledStudent = require("../models/CalledStudent");
const TaNotificationTask = require("../models/TaNotificationTask");
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

  // Check uniqueness by phone across all users
  const existingByPhone = await User.findOne({ phone });
  if (existingByPhone) {
    throw new ApiError(409, "Bu telefon raqam allaqachon ro'yxatdan o'tgan.");
  }

  // Create kurator as "pending" — support must approve before they can login
  const user = await User.create({
    fullName,
    role: "kurator",
    phone,
    telegramId,
    password,
    registrationStatus: "pending",
    isActive: false,
  });

  // Notify support via Telegram with inline approve/reject buttons
  try {
    const support = await User.findOne({ role: "support", isActive: true }).lean();
    if (support?.telegramId) {
      const { getBotInstance } = require("../coddyCheck/bot");
      const bot = getBotInstance();
      if (bot) {
        const msg = [
          `📋 *Yangi kurator so'rovi!*`,
          ``,
          `👤 Ism: *${fullName}*`,
          `📱 Telefon: ${phone}`,
          `🆔 Telegram ID: ${telegramId || "kiritilmagan"}`,
        ].join("\n");
        await bot.telegram.sendMessage(Number(support.telegramId), msg, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Qabul qilish", callback_data: `sup_approve_${user._id}` },
              { text: "❌ Rad etish", callback_data: `sup_reject_${user._id}` },
            ]]
          }
        });
      }
    }
  } catch (notifyErr) {
    console.error("[register] Support notification failed:", notifyErr.message);
  }

  return created(
    res,
    {
      pending: true,
      user: {
        _id: user._id,
        fullName: user.fullName,
        role: user.role,
        phone: user.phone,
        telegramId: user.telegramId,
        registrationStatus: user.registrationStatus,
      },
    },
    "So'rov yuborildi. Support tasdiqlashini kuting."
  );
});

const login = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body);
  const password = String(req.body.password || "").trim();

  if (!phone || !password) {
    throw new ApiError(400, "phone and password are required");
  }

  // DB'da +998... yoki 998... formatida saqlangan bo'lishi mumkin — ikkalasini ham qidiramiz
  const phoneVariants = phone.startsWith("+")
    ? [phone, phone.slice(1)]
    : [phone, `+${phone}`];

  const user = await User.findOne({
    phone: { $in: phoneVariants },
    role: { $in: ["kurator", "support", "mentor", "mentor_ta"] }
  }).select("+password");
  if (!user) {
    throw new ApiError(401, "Telefon raqam yoki parol noto'g'ri");
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    throw new ApiError(401, "Telefon raqam yoki parol noto'g'ri");
  }

  // Kurators must be approved before they can login
  if (user.role === "kurator" && user.registrationStatus === "pending") {
    throw new ApiError(403, "So'rovingiz hali ko'rib chiqilmagan. Support tasdiqlashini kuting.");
  }

  if (!user.isActive) {
    throw new ApiError(403, "Foydalanuvchi faol emas");
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
        telegramId: user.telegramId,
        registrationStatus: user.registrationStatus,
        kuratorId: user.kuratorId
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
    telegramId: user.telegramId,
    registrationStatus: user.registrationStatus,
    filials: user.filials || []
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

  if (telegramId !== undefined && !["mentor", "mentor_ta"].includes(req.user.role)) {
    user.telegramId = telegramId || null;
  }

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
  const password = String(req.body.password || "").trim();
  if (!password) {
    throw new ApiError(400, "Akkauntni o'chirish uchun parolni kiriting");
  }

  // Parolni tekshirish
  const user = await User.findById(req.user._id).select("+password");
  if (!user) throw new ApiError(404, "Foydalanuvchi topilmadi");

  const isValid = await user.comparePassword(password);
  if (!isValid) {
    throw new ApiError(401, "Parol noto'g'ri. Akkaunt o'chirilmadi.");
  }

  const kuratorId = user._id;

  // Delete only records belonging to this kurator
  await Promise.all([
    AttendanceStatusLog.deleteMany({ kuratorId }),
    Attendance.deleteMany({ kuratorId }),
    CalledStudent.deleteMany({ kuratorId }),
    TaNotificationTask.deleteMany({ kuratorId }),
  ]);

  await Student.deleteMany({ kuratorId });
  await Group.deleteMany({ kuratorId });
  // Delete workers belonging to this kurator
  await User.deleteMany({ kuratorId });
  // Delete the kurator account itself
  await User.findByIdAndDelete(kuratorId);

  return ok(res, null, "Akkaunt va barcha ma'lumotlar o'chirildi");
});

// In-memory OTP store: phone → { code, expiresAt, attempts }
const _resetStore = new Map();

const forgotPassword = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body);
  if (!phone) throw new ApiError(400, "Telefon raqamini kiriting");

  const phoneVariants = phone.startsWith("+") ? [phone, phone.slice(1)] : [phone, `+${phone}`];
  const kurator = await User.findOne({ phone: { $in: phoneVariants }, isActive: true });
  if (!kurator) throw new ApiError(404, "Bu telefon raqam bilan foydalanuvchi topilmadi");

  const telegramId = kurator.telegramId;
  if (!telegramId) {
    throw new ApiError(400, "Akkauntga Telegram ID biriktirilmagan");
  }

  const { getBotInstance } = require("../coddyCheck/bot");
  const bot = getBotInstance();
  if (!bot) throw new ApiError(503, "Telegram bot hozirda ishlamayapti");

  const code = String(Math.floor(10000 + Math.random() * 90000)); // 5 xonali
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 daqiqa

  await bot.telegram.sendMessage(
    Number(telegramId),
    `🔐 Parolni tiklash kodi:\n\n*${code}*\n\n⏱ 10 daqiqa ichida amal qiladi.`,
    { parse_mode: "Markdown" }
  );

  _resetStore.set(phone, { code, expiresAt, attempts: 0 });
  return ok(res, null, "Kod Telegram botga yuborildi");
});

const resetPassword = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body);
  const code = String(req.body.code || "").trim();
  const newPassword = String(req.body.newPassword || "").trim();

  if (!phone) throw new ApiError(400, "Telefon raqamini kiriting");
  if (!code) throw new ApiError(400, "Kodni kiriting");
  if (!newPassword || newPassword.length < 4) {
    throw new ApiError(400, "Yangi parol kamida 4 ta belgidan iborat bo'lishi kerak");
  }

  // OTP store key: forgotPassword'da saqlangan phone bilan mos kelishi kerak
  const phoneVariants = phone.startsWith("+") ? [phone, phone.slice(1)] : [phone, `+${phone}`];
  const storeKey = phoneVariants.find((v) => _resetStore.has(v));
  const store = storeKey ? _resetStore.get(storeKey) : null;

  if (!store) throw new ApiError(400, "Avval kod yuborish so'rovini qiling");
  if (Date.now() > store.expiresAt) {
    _resetStore.delete(storeKey);
    throw new ApiError(400, "Kod muddati tugagan. Qaytadan urinib ko'ring");
  }
  if (store.attempts >= 5) {
    _resetStore.delete(storeKey);
    throw new ApiError(400, "Juda ko'p noto'g'ri urinish. Qaytadan kod so'rang.");
  }
  if (code !== store.code) {
    store.attempts += 1;
    throw new ApiError(400, "Kod noto'g'ri");
  }

  const kurator = await User.findOne({ phone: { $in: phoneVariants }, isActive: true }).select("+password");
  if (!kurator) throw new ApiError(404, "Foydalanuvchi topilmadi");

  kurator.password = newPassword;
  await kurator.save();

  _resetStore.delete(storeKey);
  return ok(res, null, "Parol muvaffaqiyatli yangilandi");
});

const getCommentPresets = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  return ok(res, { presets: user.commentPresets || [] });
});

const updateCommentPresets = asyncHandler(async (req, res) => {
  const { presets } = req.body;
  if (!Array.isArray(presets)) {
    throw new ApiError(400, "presets array bo'lishi kerak");
  }

  const cleaned = presets
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .slice(0, 200);

  await User.findByIdAndUpdate(req.user._id, { commentPresets: cleaned });
  return ok(res, { presets: cleaned }, "Shablonlar saqlandi");
});

module.exports = {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  deleteAccount,
  forgotPassword,
  resetPassword,
  getCommentPresets,
  updateCommentPresets
};
