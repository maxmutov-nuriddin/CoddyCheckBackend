const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const Attendance = require("../../models/Attendance");
const Student = require("../../models/Student");
const CalledStudent = require("../../models/CalledStudent");
const { getWorkerMainKeyboard } = require("../keyboards");
const { resolveMentorDisplayName } = require("../utils/mentorNameResolver");
const { normalizeGroupName, canonicalGroupName } = require("../utils/normalizeGroupName");

const { WizardScene } = Scenes;

const cancelKeyboard = Markup.keyboard([["❌ Bekor qilish"]]).resize();

function mainKeyboard(ctx) {
  return Markup.keyboard(getWorkerMainKeyboard(ctx.state?.worker?.role)).resize();
}

const attendanceScene = new WizardScene(
  "coddy_attendance_wizard",
  (ctx) => {
    ctx.reply("O'quvchi ismini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const studentName = String(ctx.message?.text || "").trim();
    if (!studentName) {
      return ctx.reply("Ism kiriting.");
    }

    ctx.wizard.state.studentName = studentName;
    ctx.reply("Guruh nomini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const studentGroup = String(ctx.message?.text || "").trim();
    if (!studentGroup) {
      return ctx.reply("Guruh kiriting.");
    }

    ctx.wizard.state.studentGroup = normalizeGroupName(studentGroup);
    ctx.reply("Asosiy ustoz ismini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const mainTeacherInput = String(ctx.message?.text || "").trim();
    if (!mainTeacherInput) {
      return ctx.reply("Ustoz ismini kiriting.");
    }

    let mainTeacher = mainTeacherInput;
    try {
      mainTeacher = await resolveMentorDisplayName(mainTeacherInput);
    } catch (error) {
      console.error("mentor resolve error:", error.message);
    }
    ctx.wizard.state.mainTeacher = mainTeacher;

    if (mainTeacher !== mainTeacherInput) {
      await ctx.reply(`Asosiy ustoz moslandi: ${mainTeacher}`);
    }

    ctx.reply("Mavzu/izoh kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", mainKeyboard(ctx));
      return ctx.scene.leave();
    }

    const topic = String(ctx.message?.text || "").trim();
    if (!topic) {
      return ctx.reply("Mavzu kiriting.");
    }

    const { studentName, studentGroup, mainTeacher } = ctx.wizard.state;
    const now = DateTime.now().setZone(env.appTimezone || "Asia/Tashkent");
    const date = now.toFormat("yyyy-MM-dd");
    const time = now.toFormat("HH:mm");

    try {
      // Only check mark records — call_extra/keep records are NOT counted as added students
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
        $or: [
          { date },
          { createdAt: { $gte: todayStart, $lte: todayEnd } }
        ]
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
        // Resolve: student arrived after being called — update the call record to Keldi
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
        // No pending call — normal oquvchi_qoshish: create a new mark record
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
);

attendanceScene.hears("❌ Bekor qilish", (ctx) => {
  ctx.reply("Bekor qilindi", mainKeyboard(ctx));
  return ctx.scene.leave();
});

module.exports = attendanceScene;



