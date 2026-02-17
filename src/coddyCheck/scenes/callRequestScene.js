const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const { getWorkerMainKeyboard } = require("../keyboards");

const { WizardScene } = Scenes;

const requestKeyboard = Markup.keyboard([
  ["➕ Qo'shimchaga chaqirish"],
  ["📌 Qoldirmoqchi"],
  ["❌ Bekor qilish"]
]).resize();

const cancelKeyboard = Markup.keyboard([["❌ Bekor qilish"]]).resize();

function requestTypeFromText(text) {
  if (text === "➕ Qo'shimchaga chaqirish") return "call_extra";
  if (text === "📌 Qoldirmoqchi") return "keep";
  return "";
}

function requestTypeLabel(type) {
  if (type === "call_extra") return "Qo'shimchaga chaqirish";
  if (type === "keep") return "Qoldirmoqchi";
  return "So'rov";
}

function roleLabel(role) {
  if (role === "mentor_ta") return "Mentor + TA";
  if (role === "mentor") return "Mentor";
  if (role === "ta") return "TA";
  return "Xodim";
}

function mainKeyboard(ctx) {
  return Markup.keyboard(getWorkerMainKeyboard(ctx.state?.worker?.role)).resize();
}

function cancelAndExit(ctx) {
  ctx.reply("Bekor qilindi", mainKeyboard(ctx));
  return ctx.scene.leave();
}

const callRequestScene = new WizardScene(
  "coddy_call_request_wizard",
  (ctx) => {
    ctx.reply("So'rov turini tanlang:", requestKeyboard);
    return ctx.wizard.next();
  },
  (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      return cancelAndExit(ctx);
    }

    const requestType = requestTypeFromText(String(ctx.message?.text || "").trim());
    if (!requestType) {
      return ctx.reply("Iltimos, tugmalardan birini tanlang.", requestKeyboard);
    }

    ctx.wizard.state.requestType = requestType;
    ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      return cancelAndExit(ctx);
    }

    const studentName = String(ctx.message?.text || "").trim();
    if (!studentName) {
      return ctx.reply("Ism familiyani kiriting.");
    }

    ctx.wizard.state.studentName = studentName;
    ctx.reply("Guruhini kiriting:", cancelKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message?.text === "❌ Bekor qilish") {
      return cancelAndExit(ctx);
    }

    const studentGroup = String(ctx.message?.text || "").trim();
    if (!studentGroup) {
      return ctx.reply("Guruhini kiriting.");
    }

    const requestType = ctx.wizard.state.requestType;
    const studentName = ctx.wizard.state.studentName;

    const workerName =
      ctx.state?.worker?.fullName || ctx.from.first_name || ctx.from.username || "Unknown";
    const workerRoleRaw = String(ctx.state?.worker?.role || "unknown").toLowerCase();
    const workerRole = roleLabel(workerRoleRaw);

    const now = DateTime.now().setZone(env.appTimezone || "Asia/Tashkent");
    const date = now.toFormat("yyyy-MM-dd");
    const time = now.toFormat("HH:mm");
    const requestLabel = requestTypeLabel(requestType);

    try {
      await CoddyAttendance.create({
        teacherId: ctx.from.id,
        teacherName: workerName,
        studentName,
        studentGroup,
        mainTeacher: workerName,
        topic: `So'rov: ${requestLabel}`,
        date,
        time,
        status: "Kutilmoqda",
        requesterRole: workerRoleRaw,
        requestType
      });

      await ctx.reply(
        [
          "✅ So'rov yuborildi:",
          `Turi: ${requestLabel}`,
          `O'quvchi: ${studentName}`,
          `Guruh: ${studentGroup}`,
          `Vaqt: ${date} ${time}`
        ].join("\n"),
        mainKeyboard(ctx)
      );

      const notifyText = [
        "📣 Botdan yangi chaqirish so'rovi",
        `Kim: ${workerName} (${workerRole})`,
        `Turi: ${requestLabel}`,
        `O'quvchi: ${studentName}`,
        `Guruh: ${studentGroup}`,
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
      console.error("call request save error:", error);
      await ctx.reply("So'rovni saqlashda xatolik yuz berdi.", mainKeyboard(ctx));
    }

    return ctx.scene.leave();
  }
);

callRequestScene.hears("❌ Bekor qilish", (ctx) => cancelAndExit(ctx));

module.exports = callRequestScene;
