const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const Attendance = require("../../models/Attendance");
const Group = require("../../models/Group");
const Student = require("../../models/Student");
const CalledStudent = require("../../models/CalledStudent");
const { getWorkerMainKeyboard } = require("../keyboards");
const { resolveMentorDisplayName } = require("../utils/mentorNameResolver");
const { normalizeGroupName, canonicalGroupName } = require("../utils/normalizeGroupName");

const { WizardScene } = Scenes;

const CANCEL_BTN = "❌ Bekor qilish";
const MANUAL_BTN = "✏️ O'zim yozaman";
const RETRY_BTN = "🔁 Qayta yozaman";
const cancelKeyboard = Markup.keyboard([[CANCEL_BTN]]).resize();
const FROZEN_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];

function mainKeyboard(ctx) {
  return Markup.keyboard(getWorkerMainKeyboard(ctx.state?.worker?.role)).resize();
}

function groupLabel(group) {
  const parts = [group.name];
  if (group.days) parts.push(group.days);
  if (group.time) parts.push(group.time);
  return `${parts.join(" | ")} | Ustoz: ${group.mentor || "-"}`;
}

async function selectGroupAndAskStudent(ctx, group) {
  ctx.wizard.state.groupFound = true;
  ctx.wizard.state.studentGroup = normalizeGroupName(group.name);

  let mentorName = String(group.mentor || "").trim();
  if (mentorName) {
    try {
      mentorName = await resolveMentorDisplayName(mentorName);
    } catch (error) {
      console.error("mentor resolve error:", error.message);
    }
  }
  ctx.wizard.state.mainTeacher = mentorName || String(group.mentor || "").trim();

  let students = [];
  try {
    students = await Student.find({
      groupId: group._id,
      isActive: true,
      frozenStatus: { $nin: FROZEN_STATUSES }
    }).sort({ fullName: 1 }).lean();
  } catch {
    // ignore
  }

  ctx.wizard.state.students = students;

  if (!students.length) {
    ctx.wizard.state.mode = "group_no_students";
    await ctx.reply(
      [
        `✅ Guruh topildi: ${group.name}`,
        `👨‍🏫 Ustoz: ${ctx.wizard.state.mainTeacher || "-"}`,
        "Faol o'quvchi topilmadi.",
        "O'quvchi ism familiyasini kiriting:"
      ].join("\n"),
      cancelKeyboard
    );
    return;
  }

  const studentButtons = students.map((row) => [row.fullName]);
  studentButtons.push([MANUAL_BTN]);
  studentButtons.push([CANCEL_BTN]);

  ctx.wizard.state.mode = "group_students";
  await ctx.reply(
    [
      `✅ Guruh topildi: ${group.name}`,
      `👨‍🏫 Ustoz: ${ctx.wizard.state.mainTeacher || "-"}`,
      "O'quvchini tanlang:"
    ].join("\n"),
    Markup.keyboard(studentButtons).resize()
  );
}

async function saveAttendance(ctx, { studentName, studentGroup, mainTeacher, topic }) {
  const now = DateTime.now().setZone(env.appTimezone || "Asia/Tashkent");
  const date = now.toFormat("yyyy-MM-dd");
  const time = now.toFormat("HH:mm");

  try {
    // Only check mark records - call_extra/keep records are NOT counted as added students
    const existingMark = await CoddyAttendance.findOne({
      studentName: { $regex: new RegExp(`^${studentName}$`, "i") },
      date,
      requestType: "mark"
    });

    if (existingMark) {
      await ctx.reply(`❌ "${studentName}" bugun allaqachon belgilangan.`, mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const teacherName = ctx.state?.worker?.fullName || ctx.from.first_name || ctx.from.username || "Unknown";
    const requesterRole = String(ctx.state?.worker?.role || "unknown").toLowerCase();

    // Check if there is a pending call request for this student today (Kutilmoqda)
    // Unconfirmed records may not have `date` set, so also match by createdAt
    const todayStart = now.startOf("day").toJSDate();
    const todayEnd = now.endOf("day").toJSDate();
    const pendingCall = await CoddyAttendance.findOne({
      studentName: { $regex: new RegExp(`^${studentName}$`, "i") },
      requestType: { $in: ["call_extra", "keep"] },
      status: "Kutilmoqda",
      $or: [{ date }, { createdAt: { $gte: todayStart, $lte: todayEnd } }]
    });

    // Also check web/group calls so bot "add" can reconcile them like bot calls.
    let pendingWebCall = null;
    if (!pendingCall) {
      const matchedStudents = await Student.find({
        fullName: { $regex: new RegExp(`^${studentName}$`, "i") }
      })
        .populate("groupId", "name")
        .lean();

      const matchedStudentIds = matchedStudents
        .filter((row) => canonicalGroupName(row?.groupId?.name || "") === canonicalGroupName(studentGroup))
        .map((row) => row._id);

      if (matchedStudentIds.length > 0) {
        pendingWebCall = await Attendance.findOne({
          studentId: { $in: matchedStudentIds },
          date: { $gte: todayStart, $lte: todayEnd },
          callStatus: "chaqirilgan",
          attendanceStatus: null
        }).sort({ createdAt: -1 });
      }
    }

    if (pendingCall) {
      // Resolve: student arrived after being called - update the call record to Keldi
      pendingCall.status = "Keldi";
      if (!pendingCall.date) {
        pendingCall.date = date;
        pendingCall.time = time;
      }
      await pendingCall.save();

      // Also create a mark record so this arrival appears in So'nggi faollik (barcha)
      await CoddyAttendance.create({
        teacherId: ctx.from.id,
        teacherName,
        studentName,
        studentGroup,
        mainTeacher,
        topic,
        date,
        time,
        status: "Keldi",
        requesterRole,
        requestType: "mark",
        callConfirmed: true
      });

      await ctx.reply(
        [
          "✅ Chaqirilgan o'quvchi keldi:",
          `O'quvchi: ${studentName}`,
          `Guruh: ${studentGroup}`,
          `Asosiy ustoz: ${mainTeacher}`,
          `Mavzu: ${topic}`,
          `Vaqt: ${date} ${time}`
        ].join("\n"),
        mainKeyboard(ctx)
      );

      // Notify the teacher who initiated the call request
      if (pendingCall.teacherId && pendingCall.teacherId !== ctx.from.id) {
        try {
          await ctx.telegram.sendMessage(
            pendingCall.teacherId,
            [
              "✅ O'quvchingiz keldi!",
              `O'quvchi: ${studentName}`,
              `Guruh: ${pendingCall.studentGroup || studentGroup}`,
              `Sana: ${date} ${time}`
            ].join("\n")
          );
        } catch (error) {
          console.error(`Failed to notify call requester ${pendingCall.teacherId}:`, error.message);
        }
      }

      const notifyText = [
        "✅ Chaqirilgan o'quvchi keldi",
        `Support: ${teacherName}`,
        `O'quvchi: ${studentName}`,
        `Guruh: ${studentGroup}`,
        `Asosiy ustoz: ${mainTeacher}`,
        `Mavzu: ${topic}`,
        `Sana: ${date} ${time}`
      ].join("\n");

      for (const adminId of env.coddyAdminIds) {
        try {
          await ctx.telegram.sendMessage(adminId, notifyText);
        } catch (error) {
          console.error(`Failed to notify admin ${adminId}:`, error.message);
        }
      }
    } else if (pendingWebCall) {
      pendingWebCall.attendanceStatus = "keldi";
      pendingWebCall.arrivalConfirmedAt = now.toJSDate();
      pendingWebCall.botIntegration = true;
      await pendingWebCall.save();

      const calledRecord = await CalledStudent.findOne({
        studentId: pendingWebCall.studentId,
        date: { $gte: todayStart, $lte: todayEnd }
      }).sort({ createdAt: -1 });

      if (calledRecord) {
        calledRecord.lastStatus = "keldi";
        if (Array.isArray(calledRecord.calls) && calledRecord.calls.length > 0) {
          let updated = false;
          for (let i = calledRecord.calls.length - 1; i >= 0; i -= 1) {
            if (calledRecord.calls[i].status === "pending") {
              calledRecord.calls[i].status = "keldi";
              calledRecord.calls[i].resolvedAt = now.toJSDate();
              updated = true;
              break;
            }
          }
          if (!updated) {
            calledRecord.calls[calledRecord.calls.length - 1].status = "keldi";
            calledRecord.calls[calledRecord.calls.length - 1].resolvedAt = now.toJSDate();
          }
        }
        await calledRecord.save();
      }

      await CoddyAttendance.create({
        teacherId: ctx.from.id,
        teacherName,
        studentName,
        studentGroup,
        mainTeacher,
        topic,
        date,
        time,
        status: "Keldi",
        requesterRole,
        requestType: "mark",
        callConfirmed: true,
        // Web Attendance yozuvi allaqachon bor - bu faqat ko'rinish uchun yaratilgan.
        // Analytics da ikki marta hisoblanmaslik uchun webSync: true.
        webSync: true
      });

      await ctx.reply(
        [
          "✅ Chaqirilgan o'quvchi keldi:",
          `O'quvchi: ${studentName}`,
          `Guruh: ${studentGroup}`,
          `Asosiy ustoz: ${mainTeacher}`,
          `Mavzu: ${topic}`,
          `Vaqt: ${date} ${time}`
        ].join("\n"),
        mainKeyboard(ctx)
      );

      const notifyText = [
        "✅ Chaqirilgan o'quvchi keldi",
        `Support: ${teacherName}`,
        `O'quvchi: ${studentName}`,
        `Guruh: ${studentGroup}`,
        `Asosiy ustoz: ${mainTeacher}`,
        `Mavzu: ${topic}`,
        `Sana: ${date} ${time}`
      ].join("\n");

      for (const adminId of env.coddyAdminIds) {
        try {
          await ctx.telegram.sendMessage(adminId, notifyText);
        } catch (error) {
          console.error(`Failed to notify admin ${adminId}:`, error.message);
        }
      }
    } else {
      // No pending call - normal oquvchi_qoshish: create a new mark record
      await CoddyAttendance.create({
        teacherId: ctx.from.id,
        teacherName,
        studentName,
        studentGroup,
        mainTeacher,
        topic,
        date,
        time,
        status: "Keldi",
        requesterRole,
        requestType: "mark",
        callConfirmed: true
      });

      await ctx.reply(
        [
          "✅ Yozuv saqlandi:",
          `O'quvchi: ${studentName}`,
          `Guruh: ${studentGroup}`,
          `Asosiy ustoz: ${mainTeacher}`,
          `Mavzu: ${topic}`,
          `Vaqt: ${date} ${time}`
        ].join("\n"),
        mainKeyboard(ctx)
      );

      const notifyText = [
        "📌 Yangi bot yozuv",
        `Support: ${teacherName}`,
        `O'quvchi: ${studentName}`,
        `Guruh: ${studentGroup}`,
        `Asosiy ustoz: ${mainTeacher}`,
        `Mavzu: ${topic}`,
        `Sana: ${date} ${time}`
      ].join("\n");

      for (const adminId of env.coddyAdminIds) {
        try {
          await ctx.telegram.sendMessage(adminId, notifyText);
        } catch (error) {
          console.error(`Failed to notify admin ${adminId}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error("attendance scene save error:", error);
    await ctx.reply("Saqlashda xatolik yuz berdi.", mainKeyboard(ctx));
  }

  return ctx.scene.leave();
}

const attendanceScene = new WizardScene(
  "coddy_attendance_wizard",

  (ctx) => {
    ctx.wizard.state.mode = "group_input";
    ctx.reply("Guruh nomini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },

  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const text = String(ctx.message?.text || "").trim();
    const state = ctx.wizard.state;

    if (state.mode === "group_not_found_choice") {
      if (text === MANUAL_BTN) {
        state.mode = "manual_student_name";
        state.groupFound = false;
        state.studentGroup = normalizeGroupName(state.rawGroupInput || "");
        await ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
        return ctx.wizard.next();
      }

      if (text === RETRY_BTN) {
        state.mode = "group_input";
        return ctx.reply("Guruh nomini qayta kiriting:", cancelKeyboard);
      }

      return ctx.reply("Tanlang: O'zim yozaman yoki Qayta yozaman.");
    }

    if (state.mode === "group_select") {
      if (text === RETRY_BTN) {
        state.mode = "group_input";
        return ctx.reply("Guruh nomini qayta kiriting:", cancelKeyboard);
      }
      if (text === MANUAL_BTN) {
        state.mode = "manual_student_name";
        state.groupFound = false;
        state.studentGroup = normalizeGroupName(state.rawGroupInput || "");
        await ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
        return ctx.wizard.next();
      }
      const selectedGroup = (state.matchedGroups || []).find((row) => groupLabel(row) === text);
      if (!selectedGroup) {
        return ctx.reply("Guruhni ro'yxatdan tanlang.");
      }

      await selectGroupAndAskStudent(ctx, selectedGroup);
      return ctx.wizard.next();
    }

    if (!text) {
      return ctx.reply("Guruh nomini kiriting.");
    }

    state.rawGroupInput = text;

    let allGroups = [];
    try {
      allGroups = await Group.find({}).lean();
    } catch {
      // ignore
    }

    const canonicalInput = canonicalGroupName(text);
    const matchedGroups = allGroups.filter((row) => canonicalGroupName(row.name) === canonicalInput);

    if (!matchedGroups.length) {
      const similarGroups = allGroups.filter((row) => {
        const groupCanonical = canonicalGroupName(row.name);
        return groupCanonical.includes(canonicalInput) || canonicalInput.includes(groupCanonical);
      });

      if (similarGroups.length) {
        state.mode = "group_select";
        state.matchedGroups = similarGroups;
        const buttons = similarGroups.map((row) => [groupLabel(row)]);
        buttons.push([RETRY_BTN]);
        buttons.push([MANUAL_BTN]);
        buttons.push([CANCEL_BTN]);

        return ctx.reply(
          [
            `❌ "${normalizeGroupName(text)}" aniq guruh topilmadi.`,
            "Shunday guruhlar topildi:",
            "Keraklisini tanlang:"
          ].join("\n"),
          Markup.keyboard(buttons).resize()
        );
      }

      state.mode = "group_not_found_choice";
      return ctx.reply(
        `❌ Guruh topilmadi (${normalizeGroupName(text)}). O'zim yozamanmi?`,
        Markup.keyboard([[MANUAL_BTN], [RETRY_BTN], [CANCEL_BTN]]).resize()
      );
    }

    if (matchedGroups.length === 1) {
      await selectGroupAndAskStudent(ctx, matchedGroups[0]);
      return ctx.wizard.next();
    }

    state.mode = "group_select";
    state.matchedGroups = matchedGroups;

    const buttons = matchedGroups.map((row) => [groupLabel(row)]);
    buttons.push([CANCEL_BTN]);

    return ctx.reply(
      "Bir nechta guruh topildi. Keraklisini tanlang:",
      Markup.keyboard(buttons).resize()
    );
  },

  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const text = String(ctx.message?.text || "").trim();
    const state = ctx.wizard.state;

    if (state.mode === "group_students") {
      if (text === MANUAL_BTN) {
        state.mode = "group_manual_student";
        return ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
      }

      const selected = (state.students || []).find((row) => row.fullName === text);
      if (!selected) {
        return ctx.reply("O'quvchini ro'yxatdan tanlang yoki O'zim yozaman ni bosing.");
      }

      state.studentName = selected.fullName;
      state.awaitingTeacher = false;
      state.awaitingTopic = true;
      await ctx.reply("O'tilgan mavzuni kiriting:", cancelKeyboard);
      return ctx.wizard.next();
    }

    if (state.mode === "group_no_students" || state.mode === "group_manual_student") {
      if (!text) return ctx.reply("O'quvchi ism familiyasini kiriting.");

      state.studentName = text;
      state.awaitingTeacher = false;
      state.awaitingTopic = true;
      await ctx.reply("O'tilgan mavzuni kiriting:", cancelKeyboard);
      return ctx.wizard.next();
    }

    if (state.mode === "manual_student_name") {
      if (!text) return ctx.reply("O'quvchi ism familiyasini kiriting.");

      state.studentName = text;
      state.awaitingTeacher = true;
      state.awaitingTopic = false;
      await ctx.reply("Asosiy ustoz ismini kiriting:", cancelKeyboard);
      return ctx.wizard.next();
    }

    return ctx.reply("Qaytadan boshlang: guruhni kiriting.");
  },

  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const text = String(ctx.message?.text || "").trim();
    const state = ctx.wizard.state;

    if (state.awaitingTeacher) {
      if (!text) return ctx.reply("Ustoz ismini kiriting.");

      let mainTeacher = text;
      try {
        mainTeacher = await resolveMentorDisplayName(text);
      } catch (error) {
        console.error("mentor resolve error:", error.message);
      }
      state.mainTeacher = mainTeacher;

      if (mainTeacher !== text) {
        await ctx.reply(`Asosiy ustoz moslandi: ${mainTeacher}`);
      }

      state.awaitingTeacher = false;
      state.awaitingTopic = true;
      return ctx.reply("O'tilgan mavzuni kiriting:", cancelKeyboard);
    }

    if (!state.awaitingTopic) {
      state.awaitingTopic = true;
      return ctx.reply("O'tilgan mavzuni kiriting:", cancelKeyboard);
    }

    const topic = text;
    if (!topic) {
      return ctx.reply("Mavzu kiriting.");
    }

    return saveAttendance(ctx, {
      studentName: state.studentName,
      studentGroup: state.studentGroup,
      mainTeacher: state.mainTeacher || "Noma'lum",
      topic
    });
  }
);

attendanceScene.hears(CANCEL_BTN, (ctx) => {
  ctx.reply("Bekor qilindi", mainKeyboard(ctx));
  return ctx.scene.leave();
});

module.exports = attendanceScene;
