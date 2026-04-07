const FrozenStudent = require("../models/FrozenStudent");

/**
 * Syncs a Student record with the FrozenStudent collection.
 *
 * Rules:
 * - frozenStatus === "frozen"  → upsert FrozenStudent (create if missing,
 *   update only fullName + profileLink if exists; never overwrite status)
 * - frozenStatus !== "frozen"  → delete FrozenStudent record if it exists
 *
 * Idempotent: safe to call multiple times for the same student.
 */
async function syncFrozenStudent(student, kuratorId) {
  try {
    if (student.frozenStatus === "frozen") {
      const existing = await FrozenStudent.findOne({ studentId: student._id });

      if (!existing) {
        await FrozenStudent.create({
          studentId: student._id,
          fullName: student.fullName,
          profileLink: student.profileUrl || "",
          status: "muzlatilgan",
          kuratorId: kuratorId || student.kuratorId || null
        });
      } else {
        // Only update name + link — do NOT touch status
        await FrozenStudent.updateOne(
          { studentId: student._id },
          { $set: { fullName: student.fullName, profileLink: student.profileUrl || "" } }
        );
      }
    } else {
      await FrozenStudent.deleteOne({ studentId: student._id });
    }
  } catch (err) {
    // Non-fatal: log but do not break the main update flow
    console.error("[syncFrozenStudent] Error:", err.message);
  }
}

module.exports = syncFrozenStudent;
