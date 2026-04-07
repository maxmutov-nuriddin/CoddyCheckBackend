const User = require("../models/User");
const CoddyTeacher = require("../coddyCheck/models/CoddyTeacher");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { created, ok } = require("../utils/response");
const env = require("../config/env");

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

// "none" — hech qachon /start bosmagan
// "low"  — start bosgan, lekin so'nggi 30 kunda faoliyat yo'q
// "medium" — 1–9 ta yozuv (so'nggi 30 kun)
// "high"  — 10+ ta yozuv (so'nggi 30 kun)
function calcBotStatus(telegramId, startedSet, activityMap) {
  const num = Number(telegramId);
  if (!num || !Number.isFinite(num)) return "none";
  if (!startedSet.has(num)) return "none";
  const count = activityMap[num] || 0;
  if (count === 0) return "low";
  if (count < 10) return "medium";
  return "high";
}

const listWorkers = asyncHandler(async (req, res) => {
  const q = normalizeText(req.query.q || "").toLowerCase();
  const kuratorId = req.user._id;

  const query = { role: { $in: STAFF_ROLES }, kuratorId };
  const users = await User.find(query).sort({ isActive: -1, fullName: 1 });

  const filtered = q
    ? users.filter((user) => {
        const haystack = [user.fullName, user.telegramId, user.role]
          .map((part) => String(part || "").toLowerCase())
          .join(" ");
        return haystack.includes(q);
      })
    : users;

  // Bot faoliyatini hisoblash
  const tgIds = filtered
    .map((u) => Number(u.telegramId))
    .filter((n) => Number.isFinite(n) && n > 0);

  let startedSet = new Set();
  let activityMap = {};

  if (tgIds.length) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [started, counts] = await Promise.all([
      CoddyTeacher.find({ telegramId: { $in: tgIds } }).select("telegramId").lean(),
      CoddyAttendance.aggregate([
        { $match: { teacherId: { $in: tgIds }, createdAt: { $gte: thirtyDaysAgo } } },
        { $group: { _id: "$teacherId", count: { $sum: 1 } } }
      ])
    ]);
    startedSet = new Set(started.map((d) => d.telegramId));
    counts.forEach((r) => { activityMap[r._id] = r.count; });
  }

  return ok(
    res,
    filtered.map((u) => ({
      ...toWorkerDto(u),
      botStatus: calcBotStatus(u.telegramId, startedSet, activityMap)
    })),
    "Workers list"
  );
});

const createWorker = asyncHandler(async (req, res) => {
  const fullName = normalizeText(req.body.fullName);
  const telegramId = normalizeTelegramId(req.body.telegramId);
  const role = normalizeText(req.body.role).toLowerCase();
  const color = parseWorkerColor(req.body.color, DEFAULT_WORKER_COLOR);
  const kuratorId = req.user._id;

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
    isActive: true,
    kuratorId
  });

  return created(res, toWorkerDto(user), "Ishchi qo'shildi");
});

const updateWorker = asyncHandler(async (req, res) => {
  const kuratorId = req.user._id;
  const worker = await User.findOne({ _id: req.params.id, kuratorId, role: { $in: STAFF_ROLES } });
  if (!worker) {
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
  const kuratorId = req.user._id;
  const worker = await User.findOne({ _id: req.params.id, kuratorId, role: { $in: STAFF_ROLES } });
  if (!worker) {
    throw new ApiError(404, "Ishchi topilmadi");
  }

  await User.findByIdAndDelete(req.params.id);

  return ok(res, null, "Ishchi o'chirildi");
});

const notifyWorker = asyncHandler(async (req, res) => {
  const kuratorId = req.user._id;
  const worker = await User.findOne({ _id: req.params.id, kuratorId, role: { $in: STAFF_ROLES } });
  if (!worker) {
    throw new ApiError(404, "Ishchi topilmadi");
  }

  if (!worker.telegramId) {
    throw new ApiError(400, "Bu ishchining Telegram ID si yo'q");
  }

  const token = env.coddyBotToken;
  if (!token) {
    throw new ApiError(503, "Bot token sozlanmagan");
  }

  const text = `Hurmatli ${worker.fullName}, iltimos boshaganizda kurator bilan uchrashib keting.`;
  const url = `${env.telegramApiBase}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: worker.telegramId, text })
  });

  const json = await response.json();
  if (!response.ok || !json.ok) {
    const desc = json.description || "Noma'lum xato";
    throw new ApiError(502, `Telegram xato: ${desc}`);
  }

  return ok(res, { fullName: worker.fullName }, "Xabar yuborildi");
});

module.exports = {
  listWorkers,
  createWorker,
  updateWorker,
  deleteWorker,
  notifyWorker
};
