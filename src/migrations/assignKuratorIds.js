/**
 * One-time migration: assign kuratorId to all existing records
 * when there is exactly one kurator in the system.
 *
 * Safe to run multiple times (idempotent): only updates records
 * where kuratorId is not yet set.
 */

const User = require("../models/User");
const Group = require("../models/Group");
const Student = require("../models/Student");
const Attendance = require("../models/Attendance");
const CalledStudent = require("../models/CalledStudent");
const FrozenStudent = require("../models/FrozenStudent");
const TaNotificationTask = require("../models/TaNotificationTask");
const AttendanceStatusLog = require("../models/AttendanceStatusLog");

// Ensure support account exists with correct phone format
async function ensureSupportAccount() {
  try {
    const existing = await User.findOne({ role: "support" });

    if (existing) {
      // Normalize phone to digits-only format (no +) to match login flow
      const normalized = String(existing.phone || "").replace(/\D/g, "");
      if (existing.phone !== normalized) {
        existing.phone = normalized;
        await existing.save();
        console.log("[migration] Support account phone normalized to", normalized);
      }
      return;
    }

    await User.create({
      fullName: "Support",
      role: "support",
      phone: "998943322218",
      telegramId: "1604384939",
      password: "1234",
      isActive: true,
      registrationStatus: "approved"
    });

    console.log("[migration] Support account created: phone=998943322218");
  } catch (err) {
    // Ignore duplicate key errors (account already exists)
    if (err.code !== 11000) {
      console.error("[migration] ensureSupportAccount failed:", err.message);
    }
  }
}

async function assignKuratorIds() {
  try {
    const kurators = await User.find({ role: "kurator" }).lean();

    if (kurators.length !== 1) {
      // Only migrate when there is exactly one kurator (initial state).
      // If 0 kurators: nothing to assign. If 2+: can't know which owns what.
      return;
    }

    const kuratorId = kurators[0]._id;
    const noId = { kuratorId: { $in: [null, undefined] }, $or: [{ kuratorId: { $exists: false } }, { kuratorId: null }] };

    const [g, s, a, cs, fs, ta, asl, workers] = await Promise.all([
      Group.countDocuments({ kuratorId: null }),
      Student.countDocuments({ kuratorId: null }),
      Attendance.countDocuments({ kuratorId: null }),
      CalledStudent.countDocuments({ kuratorId: null }),
      FrozenStudent.countDocuments({ kuratorId: null }),
      TaNotificationTask.countDocuments({ kuratorId: null }),
      AttendanceStatusLog.countDocuments({ kuratorId: null }),
      User.countDocuments({ role: { $in: ["mentor", "ta", "mentor_ta"] }, kuratorId: null })
    ]);

    const hasUnassigned = g + s + a + cs + fs + ta + asl + workers > 0;
    if (!hasUnassigned) return;

    console.log(`[migration] Assigning kuratorId ${kuratorId} to existing records...`);

    await Promise.all([
      Group.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      Student.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      Attendance.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      CalledStudent.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      FrozenStudent.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      TaNotificationTask.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      AttendanceStatusLog.updateMany({ kuratorId: null }, { $set: { kuratorId } }),
      // Assign workers to the single kurator
      User.updateMany(
        { role: { $in: ["mentor", "ta", "mentor_ta"] }, kuratorId: null },
        { $set: { kuratorId } }
      )
    ]);

    console.log(`[migration] Done. Groups: ${g}, Students: ${s}, Attendance: ${a}, CalledStudents: ${cs}, FrozenStudents: ${fs}, TaTasks: ${ta}, Logs: ${asl}, Workers: ${workers}`);
  } catch (err) {
    console.error("[migration] assignKuratorIds failed:", err.message);
  }
}

async function runMigrations() {
  await ensureSupportAccount();
  await assignKuratorIds();
}

module.exports = runMigrations;
