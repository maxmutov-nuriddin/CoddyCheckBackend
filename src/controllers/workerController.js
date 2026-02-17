const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");

const STAFF_ROLES = ["mentor", "ta", "mentor_ta"];

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTelegramId(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  return digits || raw;
}

function toWorkerDto(user) {
  return {
    _id: user._id,
    fullName: user.fullName,
    role: user.role,
    telegramId: user.telegramId || "",
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

  if (!fullName || !telegramId || !STAFF_ROLES.includes(role)) {
    throw new ApiError(400, "fullName, telegramId va role (mentor/ta/mentor_ta) majburiy");
  }

  const byTelegram = await User.findOne({ telegramId });
  if (byTelegram) {
    throw new ApiError(409, "Bu Telegram ID allaqachon mavjud");
  }

  const tempPassword = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const user = await User.create({
    fullName,
    role,
    telegramId,
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
  worker.isActive = isActive;

  await worker.save();

  return ok(res, toWorkerDto(worker), "Ishchi yangilandi");
});

const deactivateWorker = asyncHandler(async (req, res) => {
  const worker = await User.findById(req.params.id);
  if (!worker || worker.role === "kurator") {
    throw new ApiError(404, "Ishchi topilmadi");
  }

  worker.isActive = false;
  await worker.save();

  return ok(res, toWorkerDto(worker), "Ishchi nofaol qilindi");
});

module.exports = {
  listWorkers,
  createWorker,
  updateWorker,
  deactivateWorker
};
