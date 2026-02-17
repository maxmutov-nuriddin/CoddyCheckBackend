const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const { getWorkerMainKeyboard } = require("../keyboards");
const { resolveMentorDisplayName } = require("../utils/mentorNameResolver");

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

    ctx.wizard.state.studentGroup = studentGroup;
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
      const existing = await CoddyAttendance.findOne({
        studentName: { $regex: new RegExp(`^${studentName}$`, "i") },
        date
      });

      if (existing) {
        await ctx.reply(`❌ "${studentName}" bugun allaqachon belgilangan.`, mainKeyboard(ctx));
        return ctx.scene.leave();
      }

      const teacherName = ctx.state?.worker?.fullName || ctx.from.first_name || ctx.from.username || "Unknown";

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
        requestType: "mark"
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
