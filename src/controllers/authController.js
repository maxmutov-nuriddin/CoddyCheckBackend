const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");
const { signToken } = require("../services/tokenService");

const FIXED_KURATOR_PASSWORD = "1234";

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
  const role = normalizeRole(req.body.role);
  const telegramId = req.body.telegramId;
  const password = req.body.password;

  if (!fullName || !phone) {
    throw new ApiError(400, "fullName (or name) and phone are required");
  }

  if (role !== "kurator") {
    throw new ApiError(400, "Only kurator role can register for web access");
  }

  if (password && String(password) !== FIXED_KURATOR_PASSWORD) {
    throw new ApiError(400, "Password must be 1234 for kurator web login");
  }

  let user = await User.findOne({ phone });

  if (user) {
    if (user.role !== "kurator") {
      throw new ApiError(409, "This phone already belongs to non-kurator user");
    }

    user.fullName = fullName;
    user.telegramId = telegramId || user.telegramId;
    user.password = FIXED_KURATOR_PASSWORD;
    user.isActive = true;
    await user.save();

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
      "Kurator account reset and logged in"
    );
  }

  user = await User.create({
    fullName,
    role: "kurator",
    phone,
    telegramId,
    password: FIXED_KURATOR_PASSWORD
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
        telegramId: user.telegramId
      }
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

  if (password !== FIXED_KURATOR_PASSWORD) {
    throw new ApiError(401, "Invalid credentials. Kurator password must be 1234");
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

module.exports = {
  register,
  login
};
