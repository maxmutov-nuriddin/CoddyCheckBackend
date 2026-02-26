const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");

const STAFF_ROLES = ["mentor", "ta", "mentor_ta"];
const DEFAULT_WORKER_COLOR = "#3B82F6";

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTelegramId(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  return digits || raw;
}

function sanitizeWorkerColor(value, fallback = DEFAULT_WORKER_COLOR) {
  const raw = normalizeText(value);
  if (!raw) return fallback;
  const normalized = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toUpperCase() : fallback;
}

function parseWorkerColor(value, fallback = DEFAULT_WORKER_COLOR) {
  const raw = normalizeText(value);
  if (!raw) return fallback;
  const normalized = raw.startsWith("#") ? raw : `#${raw}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new ApiError(400, "color formati noto'g'ri. Misol: #3B82F6");
  }
  return normalized.toUpperCase();
}

function toWorkerDto(user) {
  return {
    _id: user._id,
    fullName: user.fullName,
    role: user.role,
    telegramId: user.telegramId || "",
    color: sanitizeWorkerColor(user.color),
    isActive: Boolean(user.isActive),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

const listWorkers = asyncHandler(async (req, res) => {
  const q = normalizeText(req.query.q || "").toLowerCase();

  const query = { role: { $in: STAFF_ROLES } };
  const users = await User.find(query).sort({ isActive: -1, fullName: 1 });

  const filtered = q
    ? users.filter((user) => {
        const haystack = [user.fullName, user.telegramId, user.role]
          .map((part) => String(part || "").toLowerCase())
          .join(" ");
        return haystack.includes(q);
      })
    : users;

  return ok(res, filtered.map(toWorkerDto), "Workers list");
});

const createWorker = asyncHandler(async (req, res) => {
  const fullName = normalizeText(req.body.fullName);
  const telegramId = normalizeTelegramId(req.body.telegramId);
  const role = normalizeText(req.body.role).toLowerCase();
  const color = parseWorkerColor(req.body.color, DEFAULT_WORKER_COLOR);

  if (!fullName || !telegramId || !STAFF_ROLES.includes(role)) {
    throw new ApiError(400, "fullName, telegramId va role (mentor/ta/mentor_ta) majburiy");
  }

  const byTelegram = await User.findOne({ telegramId });
  if (byTelegram) {
    throw new ApiError(409, "Bu Telegram ID allaqachon mavjud");
  }

  const tempPassword = require("crypto").randomBytes(12).toString("base64url");

  const user = await User.create({
    fullName,
    role,
    telegramId,
    color,
    password: tempPassword,
    isActive: true
  });

  return created(res, toWorkerDto(user), "Ishchi qo'shildi");
});

const updateWorker = asyncHandler(async (req, res) => {
  const worker = await User.findById(req.params.id);
  if (!worker || worker.role === "kurator") {
    throw new ApiError(404, "Ishchi topilmadi");
  }

  const fullName = req.body.fullName !== undefined ? normalizeText(req.body.fullName) : worker.fullName;
  const telegramId =
    req.body.telegramId !== undefined ? normalizeTelegramId(req.body.telegramId) : normalizeTelegramId(worker.telegramId);
  const role = req.body.role !== undefined ? normalizeText(req.body.role).toLowerCase() : worker.role;
  const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : worker.isActive;
  const color =
    req.body.color !== undefined
      ? parseWorkerColor(req.body.color, sanitizeWorkerColor(worker.color))
      : sanitizeWorkerColor(worker.color);

  if (!fullName || !telegramId || !STAFF_ROLES.includes(role)) {
    throw new ApiError(400, "fullName, telegramId va role (mentor/ta/mentor_ta) majburiy");
  }

  const byTelegram = await User.findOne({ telegramId, _id: { $ne: worker._id } });
  if (byTelegram) {
    throw new ApiError(409, "Bu Telegram ID boshqa userga biriktirilgan");
  }

  worker.fullName = fullName;
  worker.telegramId = telegramId;
  worker.role = role;
  worker.color = color;
  worker.isActive = isActive;

  await worker.save();

  return ok(res, toWorkerDto(worker), "Ishchi yangilandi");
});

const deleteWorker = asyncHandler(async (req, res) => {
  const worker = await User.findById(req.params.id);
  if (!worker || worker.role === "kurator") {
    throw new ApiError(404, "Ishchi topilmadi");
  }

  await User.findByIdAndDelete(req.params.id);

  return ok(res, null, "Ishchi o'chirildi");
});

module.exports = {
  listWorkers,
  createWorker,
  updateWorker,
  deleteWorker
};
