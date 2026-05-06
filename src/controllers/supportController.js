const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Group = require("../models/Group");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const CalledStudent = require("../models/CalledStudent");
const FrozenStudent = require("../models/FrozenStudent");
const TaNotificationTask = require("../models/TaNotificationTask");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");
const CoddyAttendance = require("../coddyCheck/models/CoddyAttendance");
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

  // CoddyAttendance uses string dates "YYYY-MM-DD"
  const pad = (n) => String(n).padStart(2, "0");
  const monthStartStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthEndStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;

  // Load all groups (to map groupName → kuratorId) and CoddyAttendance in parallel
  const [allGroups, coddyByGroup] = await Promise.all([
    Group.find({}).select("name kuratorId").lean(),
    CoddyAttendance.aggregate([
      {
        $match: {
          date: { $gte: monthStartStr, $lte: monthEndStr },
          studentGroup: { $nin: ["-", "–", "—", "", " "] }
        }
      },
      {
        $group: {
          _id: {
            $replaceAll: {
              input: {
                $replaceAll: {
                  input: { $toLower: "$studentGroup" },
                  find: "-", replacement: ""
                }
              },
              find: " ", replacement: ""
            }
          },
          total: {
            $sum: { $cond: [{ $eq: ["$requestType", "mark"] }, 1, 0] }
          },
          called: {
            $sum: {
              $cond: {
                if: { $and: [
                  { $in: ["$requestType", ["call_extra", "keep"]] },
                  { $eq: ["$status", "Kutilmoqda"] }
                ]},
                then: 1, else: 0
              }
            }
          },
          came: {
            $sum: {
              $cond: {
                if: { $and: [
                  { $in: ["$requestType", ["call_extra", "keep"]] },
                  { $eq: ["$status", "Keldi"] }
                ]},
                then: 1, else: 0
              }
            }
          },
          notCame: {
            $sum: {
              $cond: {
                if: { $and: [
                  { $in: ["$requestType", ["call_extra", "keep"]] },
                  { $eq: ["$status", "Kelmadi"] }
                ]},
                then: 1, else: 0
              }
            }
          }
        }
      }
    ])
  ]);

  // Map normalized group name → kuratorId string
  const normalizeGroupName = (name) => name.toLowerCase().replace(/[-\s]/g, "");
  const groupToKurator = new Map();
  for (const g of allGroups) {
    if (g.kuratorId) groupToKurator.set(normalizeGroupName(g.name), g.kuratorId.toString());
  }

  // Aggregate attendance per kuratorId
  const kuratorAttMap = new Map();
  let globalCame = 0, globalNotCame = 0, globalTotal = 0, globalCalled = 0;
  const unmatchedAtt = { came: 0, notCame: 0, total: 0, called: 0 };

  for (const row of coddyByGroup) {
    globalCame += row.came;
    globalNotCame += row.notCame;
    globalTotal += row.total;
    globalCalled += row.called;
    const kid = groupToKurator.get(row._id);
    if (!kid) {
      unmatchedAtt.came += row.came;
      unmatchedAtt.notCame += row.notCame;
      unmatchedAtt.total += row.total;
      unmatchedAtt.called += row.called;
      continue;
    }
    const prev = kuratorAttMap.get(kid) || { came: 0, notCame: 0, total: 0, called: 0 };
    prev.came += row.came;
    prev.notCame += row.notCame;
    prev.total += row.total;
    prev.called += row.called;
    kuratorAttMap.set(kid, prev);
  }

  // If only 1 kurator, assign unmatched (groups not yet in DB) to them
  if (kurators.length === 1 && (unmatchedAtt.total > 0 || unmatchedAtt.called > 0)) {
    const kid = kurators[0]._id.toString();
    const prev = kuratorAttMap.get(kid) || { came: 0, notCame: 0, total: 0, called: 0 };
    prev.came += unmatchedAtt.came;
    prev.notCame += unmatchedAtt.notCame;
    prev.total += unmatchedAtt.total;
    prev.called += unmatchedAtt.called;
    kuratorAttMap.set(kid, prev);
  }

  const FROZEN_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];

  const kuratorsStats = await Promise.all(
    kurators.map(async (k) => {
      const kuratorId = k._id;

      const [activeStudents, leadStudents, allStudents, totalGroups, totalWorkers] = await Promise.all([
        Student.countDocuments({ kuratorId, isActive: true, frozenStatus: { $nin: [...FROZEN_STATUSES, "lead"] } }),
        Student.countDocuments({ kuratorId, isActive: true, frozenStatus: "lead" }),
        Student.countDocuments({ kuratorId, isActive: true }),
        Group.countDocuments({ kuratorId }),
        User.countDocuments({ kuratorId, role: { $in: ["mentor", "ta", "mentor_ta"] }, isActive: true }),
      ]);

      const att = kuratorAttMap.get(kuratorId.toString()) || { came: 0, notCame: 0, total: 0, called: 0 };
      const resolved = att.came + att.notCame;
      const attendanceRate = resolved > 0 ? Math.round((att.came / resolved) * 100) : 0;

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
          inactiveStudents: allStudents - activeStudents - leadStudents,
          allStudents,
          totalGroups,
          totalWorkers,
          thisMonth: {
            total: att.total,
            called: att.called,
            came: att.came,
            notCame: att.notCame,
            attendanceRate,
          }
        }
      };
    })
  );

  const globalResolved = globalCame + globalNotCame;
  const globalRate = globalResolved > 0 ? Math.round((globalCame / globalResolved) * 100) : 0;

  return ok(res, {
    kurators: kuratorsStats,
    monthStats: {
      totalCame: globalCame,
      totalNotCame: globalNotCame,
      total: globalTotal,
      attendanceRate: globalRate,
    }
  }, "All kurators analytics");
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

// ── GET /api/support/mentors  ──────────────────────────────────────────────
// All mentors with kurator + filial info
const listMentors = asyncHandler(async (req, res) => {
  const mentors = await User.find({ role: { $in: ["mentor", "mentor_ta"] } })
    .select("_id fullName phone role isActive createdAt kuratorId")
    .sort({ createdAt: -1 })
    .lean();

  const kuratorIds = [...new Set(mentors.filter(m => m.kuratorId).map(m => String(m.kuratorId)))];
  const kurators = await User.find({ _id: { $in: kuratorIds } })
    .select("_id fullName filials")
    .lean();
  const kuratorMap = Object.fromEntries(kurators.map(k => [String(k._id), k]));

  const result = mentors.map(m => ({
    _id: m._id,
    fullName: m.fullName,
    phone: m.phone || "",
    role: m.role,
    isActive: m.isActive,
    createdAt: m.createdAt,
    kuratorId: m.kuratorId,
    kuratorName: kuratorMap[String(m.kuratorId)]?.fullName || "—",
    filials: kuratorMap[String(m.kuratorId)]?.filials || [],
  }));

  return ok(res, result, "Mentors list");
});

// ── POST /api/support/mentors/:id/reset-password  ─────────────────────────
const resetMentorPassword = asyncHandler(async (req, res) => {
  const mentor = await User.findOne({ _id: req.params.id, role: { $in: ["mentor", "mentor_ta"] } });
  if (!mentor) throw new ApiError(404, "Mentor topilmadi");

  const hashed = await bcrypt.hash("1234", 10);
  await User.updateOne({ _id: mentor._id }, { $set: { password: hashed } });

  return ok(res, { _id: mentor._id, fullName: mentor.fullName }, "Parol 1234 ga tiklandi");
});

// ── POST /api/support/broadcast  ───────────────────────────────────────────
// Barcha foydalanuvchilarga (kurator + workers) Telegram xabar yuborish
const broadcast = asyncHandler(async (req, res) => {
  const { message, password } = req.body;

  if (!message || !String(message).trim()) {
    throw new ApiError(400, "Xabar matni kiritilmagan");
  }
  if (!password) {
    throw new ApiError(400, "Parolni kiriting");
  }

  // Parolni tekshirish
  const support = await User.findById(req.user._id).select("+password");
  if (!support) throw new ApiError(404, "Foydalanuvchi topilmadi");
  const isValid = await support.comparePassword(String(password));
  if (!isValid) throw new ApiError(401, "Parol noto'g'ri");

  // Barcha faol foydalanuvchilar (kurator + worker)lar telegramId si bor bo'lsa
  const users = await User.find({
    isActive: true,
    telegramId: { $ne: null, $exists: true },
    role: { $in: ["kurator", "mentor", "ta", "mentor_ta"] }
  }).select("telegramId fullName").lean();

  const text = `📢 *Support xabari*\n\n${String(message).trim()}`;

  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      await sendTelegramMsg(u.telegramId, text);
      sent++;
    } catch {
      failed++;
    }
  }

  return ok(res, { total: users.length, sent, failed }, "Xabar yuborildi");
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
  broadcast,
  listMentors,
  resetMentorPassword,
};
