const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const { teacherMainKeyboard } = require("../keyboards");

const { WizardScene } = Scenes;

const cancelKeyboard = Markup.keyboard([["❌ Bekor qilish"]]).resize();

const attendanceScene = new WizardScene(
  "coddy_attendance_wizard",
  (ctx) => {
    ctx.reply("O'quvchi ismini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", Markup.keyboard(teacherMainKeyboard).resize());
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
      ctx.reply("Bekor qilindi", Markup.keyboard(teacherMainKeyboard).resize());
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
  (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", Markup.keyboard(teacherMainKeyboard).resize());
      return ctx.scene.leave();
    }

    const mainTeacher = String(ctx.message?.text || "").trim();
    if (!mainTeacher) {
      return ctx.reply("Ustoz ismini kiriting.");
    }

    ctx.wizard.state.mainTeacher = mainTeacher;
    ctx.reply("Mavzu/izoh kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      ctx.reply("Bekor qilindi", Markup.keyboard(teacherMainKeyboard).resize());
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
        await ctx.reply(`❌ "${studentName}" bugun allaqachon belgilangan.`, Markup.keyboard(teacherMainKeyboard).resize());
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
        time
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
        Markup.keyboard(teacherMainKeyboard).resize()
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
      await ctx.reply("Saqlashda xatolik yuz berdi.", Markup.keyboard(teacherMainKeyboard).resize());
    }

    return ctx.scene.leave();
  }
);

attendanceScene.hears("❌ Bekor qilish", (ctx) => {
  ctx.reply("Bekor qilindi", Markup.keyboard(teacherMainKeyboard).resize());
  return ctx.scene.leave();
});

module.exports = attendanceScene;

