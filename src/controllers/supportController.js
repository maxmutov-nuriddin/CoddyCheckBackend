const User = require("../models/User");
const Group = require("../models/Group");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const CalledStudent = require("../models/CalledStudent");
const FrozenStudent = require("../models/FrozenStudent");
const TaNotificationTask = require("../models/TaNotificationTask");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/response");

// ── Telegram helper ────────────────────────────────────────────────────────
async function sendTelegramMsg(telegramId, text) {
  try {
    const { getBotInstance } = require("../coddyCheck/bot");
    const bot = getBotInstance();
    if (bot && telegramId) {
      await bot.telegram.sendMessage(Number(telegramId), text, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("[support] Telegram notify failed:", err.message);
  }
}

// ── GET /api/support/requests  ─────────────────────────────────────────────
// Pending kurator requests
const listRequests = asyncHandler(async (req, res) => {
  const requests = await User.find({ role: "kurator", registrationStatus: "pending" })
    .select("_id fullName phone telegramId createdAt")
    .sort({ createdAt: -1 })
    .lean();

  return ok(res, requests, "Pending kurator requests");
});

// ── POST /api/support/requests/:id/approve  ────────────────────────────────
const approveRequest = asyncHandler(async (req, res) => {
  const kurator = await User.findOne({ _id: req.params.id, role: "kurator", registrationStatus: "pending" });
  if (!kurator) throw new ApiError(404, "So'rov topilmadi");

  kurator.registrationStatus = "approved";
  kurator.isActive = true;
  await kurator.save();

  // Notify kurator
  if (kurator.telegramId) {
    await sendTelegramMsg(
      kurator.telegramId,
      [
        `✅ *Tabriklaymiz, ${kurator.fullName}!*`,
        ``,
        `Kurator so'rovingiz *qabul qilindi*.`,
        `Endi CoddyCheck tizimiga kirishingiz mumkin.`
      ].join("\n")
    );
  }

  return ok(res, { _id: kurator._id, fullName: kurator.fullName }, "Kurator tasdiqlandi");
});

// ── POST /api/support/requests/:id/reject  ─────────────────────────────────
const rejectRequest = asyncHandler(async (req, res) => {
  const kurator = await User.findOne({ _id: req.params.id, role: "kurator", registrationStatus: "pending" });
  if (!kurator) throw new ApiError(404, "So'rov topilmadi");

  const { telegramId, fullName } = kurator;

  await User.findByIdAndDelete(kurator._id);

  // Notify kurator
  if (telegramId) {
    await sendTelegramMsg(
      telegramId,
      [
        `❌ *${fullName}, so'rovingiz rad etildi.*`,
        ``,
        `Kurator ro'yxatdan o'tish so'rovingiz qabul qilinmadi.`,
        `Qo'shimcha ma'lumot uchun support bilan bog'laning.`
      ].join("\n")
    );
  }

  return ok(res, null, "So'rov rad etildi");
});

// ── GET /api/support/analytics  ────────────────────────────────────────────
// Monthly stats for all approved kurators
const getAllKuratorsAnalytics = asyncHandler(async (req, res) => {
  const kurators = await User.find({ role: "kurator", registrationStatus: "approved", isActive: true })
    .select("_id fullName phone telegramId createdAt filials")
    .sort({ createdAt: -1 })
    .lean();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  monthStart.setHours(0, 0, 0, 0);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  monthEnd.setHours(23, 59, 59, 999);

  const stats = await Promise.all(
    kurators.map(async (k) => {
      const kuratorId = k._id;

      const FROZEN_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];

      const [activeStudents, leadStudents, allStudents, totalGroups, totalWorkers, monthlyAtt, monthlyCalledAgg] = await Promise.all([
        Student.countDocuments({ kuratorId, isActive: true, frozenStatus: { $nin: [...FROZEN_STATUSES, "lead"] } }),
        Student.countDocuments({ kuratorId, isActive: true, frozenStatus: "lead" }),
        Student.countDocuments({ kuratorId }),
        Group.countDocuments({ kuratorId }),
        User.countDocuments({ kuratorId, role: { $in: ["mentor", "ta", "mentor_ta"] }, isActive: true }),
        Attendance.aggregate([
          { $match: { kuratorId, date: { $gte: monthStart, $lte: monthEnd } } },
          {
            $group: {
              _id: null,
              called: { $sum: { $cond: [{ $eq: ["$callStatus", "chaqirilgan"] }, 1, 0] } },
              came: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "keldi"] }, 1, 0] } },
              notCame: { $sum: { $cond: [{ $eq: ["$attendanceStatus", "kelmadi"] }, 1, 0] } }
            }
          }
        ]),
        CalledStudent.aggregate([
          { $match: { kuratorId, date: { $gte: monthStart, $lte: monthEnd } } },
          { $group: { _id: null, totalCalled: { $sum: 1 } } }
        ])
      ]);

      const att = monthlyAtt[0] || { called: 0, came: 0, notCame: 0 };
      const calledCount = monthlyCalledAgg[0]?.totalCalled || 0;
      const inactiveStudents = allStudents - activeStudents - leadStudents; // frozen + isActive:false

      return {
        _id: k._id,
        fullName: k.fullName,
        phone: k.phone,
        telegramId: k.telegramId,
        registeredAt: k.createdAt,
        filials: k.filials || [],
        stats: {
          activeStudents,
          leadStudents,
          inactiveStudents,
          allStudents,
          totalGroups,
          totalWorkers,
          thisMonth: {
            calledStudents: calledCount,
            attendanceCalled: att.called,
            came: att.came,
            notCame: att.notCame,
            attendanceRate: att.called > 0 ? Math.round((att.came / att.called) * 100) : 0
          }
        }
      };
    })
  );

  return ok(res, stats, "All kurators analytics");
});

// ── GET /api/support/kurators  ─────────────────────────────────────────────
// All approved kurators (for management)
const listKurators = asyncHandler(async (req, res) => {
  const kurators = await User.find({
    role: "kurator",
    registrationStatus: { $ne: "pending" }
  })
    .select("_id fullName phone telegramId isActive createdAt registrationStatus filials")
    .sort({ createdAt: -1 })
    .lean();

  return ok(res, kurators, "Kurators list");
});

// ── PATCH /api/support/kurators/:id/filials  ───────────────────────────────
// Update kurator filials list
const updateKuratorFilials = asyncHandler(async (req, res) => {
  const kurator = await User.findOne({ _id: req.params.id, role: "kurator" });
  if (!kurator) throw new ApiError(404, "Kurator topilmadi");

  const { filials } = req.body;
  if (!Array.isArray(filials)) throw new ApiError(400, "filials array bo'lishi kerak");

  kurator.filials = filials.map(f => String(f).trim()).filter(Boolean);
  await kurator.save();

  return ok(res, { _id: kurator._id, filials: kurator.filials }, "Filiallar yangilandi");
});

// ── PATCH /api/support/kurators/:id/toggle  ────────────────────────────────
// Activate / deactivate a kurator
const toggleKuratorStatus = asyncHandler(async (req, res) => {
  const kurator = await User.findOne({ _id: req.params.id, role: "kurator", registrationStatus: "approved" });
  if (!kurator) throw new ApiError(404, "Kurator topilmadi");

  kurator.isActive = !kurator.isActive;
  await kurator.save();

  if (kurator.telegramId) {
    const msg = kurator.isActive
      ? [`✅ *${kurator.fullName}*, akkauntingiz *faollashtirildi*.`, ``, `CoddyCheck tizimiga kirishingiz mumkin.`].join("\n")
      : [`⏸ *${kurator.fullName}*, akkauntingiz *to'xtatildi*.`, ``, `Qo'shimcha ma'lumot uchun support bilan bog'laning.`].join("\n");
    await sendTelegramMsg(kurator.telegramId, msg);
  }

  return ok(res, { _id: kurator._id, isActive: kurator.isActive }, kurator.isActive ? "Kurator faollashtirildi" : "Kurator to'xtatildi");
});

// ── DELETE /api/support/kurators/:id  ─────────────────────────────────────
// Delete kurator and all their data
const deleteKurator = asyncHandler(async (req, res) => {
  const kurator = await User.findOne({ _id: req.params.id, role: "kurator" });
  if (!kurator) throw new ApiError(404, "Kurator topilmadi");

  const kuratorId = kurator._id;
  const { telegramId, fullName } = kurator;

  await Promise.all([
    AttendanceStatusLog.deleteMany({ kuratorId }),
    Attendance.deleteMany({ kuratorId }),
    CalledStudent.deleteMany({ kuratorId }),
    FrozenStudent.deleteMany({ kuratorId }),
    TaNotificationTask.deleteMany({ kuratorId }),
  ]);

  await Student.deleteMany({ kuratorId });
  await Group.deleteMany({ kuratorId });
  await User.deleteMany({ kuratorId }); // workers
  await User.findByIdAndDelete(kuratorId);

  if (telegramId) {
    await sendTelegramMsg(
      telegramId,
      [`❌ *${fullName}*, akkauntingiz *o'chirildi*.`, ``, `Barcha ma'lumotlaringiz tizimdan olib tashlandi.`].join("\n")
    );
  }

  return ok(res, null, "Kurator va barcha ma'lumotlari o'chirildi");
});

module.exports = {
  listRequests,
  approveRequest,
  rejectRequest,
  getAllKuratorsAnalytics,
  listKurators,
  toggleKuratorStatus,
  updateKuratorFilials,
  deleteKurator,
};
