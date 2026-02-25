const { Scenes, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const env = require("../../config/env");
const CoddyAttendance = require("../models/CoddyAttendance");
const Group = require("../../models/Group");
const Student = require("../../models/Student");
const { getWorkerMainKeyboard } = require("../keyboards");
const { normalizeGroupName } = require("../utils/normalizeGroupName");

const { WizardScene } = Scenes;

const CANCEL_BTN = "❌ Bekor qilish";
const MANUAL_BTN = "✏️ O'zim kiritaman";
const FROZEN_STATUSES = ["frozen", "muzlatilgan", "qarzdor", "qaytadi"];

const cancelKeyboard = Markup.keyboard([[CANCEL_BTN]]).resize();

function roleLabel(role) {
  if (role === "mentor_ta") return "Mentor + TA";
  if (role === "mentor") return "Mentor";
  if (role === "ta") return "TA";
  return "Xodim";
}

function mainKeyboard(ctx) {
  return Markup.keyboard(getWorkerMainKeyboard(ctx.state?.worker?.role)).resize();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCompactText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function cancelAndExit(ctx) {
  ctx.reply("Bekor qilindi", mainKeyboard(ctx));
  return ctx.scene.leave();
}

async function askMandatoryComment(ctx) {
  await ctx.reply("Murojatingizni yozing:", cancelKeyboard);
}

async function saveAndNotify(ctx, studentName, rawGroupName, comment) {
  const normalizedGroup = normalizeGroupName(rawGroupName);
  const workerName =
    ctx.state?.worker?.fullName || ctx.from.first_name || ctx.from.username || "Unknown";
  const workerRoleRaw = String(ctx.state?.worker?.role || "unknown").toLowerCase();
  const workerRole = roleLabel(workerRoleRaw);
  const now = DateTime.now().setZone(env.appTimezone || "Asia/Tashkent");
  const date = now.toFormat("yyyy-MM-dd");
  const time = now.toFormat("HH:mm");
  const normalizedComment = normalizeCompactText(comment);

  if (!normalizedComment) {
    await ctx.reply("Murojat matni bo'sh bo'lmasligi kerak.");
    return;
  }

  const studentNameRegex = new RegExp(`^${escapeRegExp(studentName)}$`, "i");
  const groupNameRegex = new RegExp(`^${escapeRegExp(normalizedGroup)}$`, "i");

  try {
    const pendingRequest = await CoddyAttendance.findOne({
      studentName: studentNameRegex,
      studentGroup: groupNameRegex,
      requestType: "talk_request",
      status: "Kutilmoqda"
    })
      .sort({ createdAt: -1 })
      .lean();

    if (pendingRequest) {
      await ctx.reply(
        "Bu o'quvchi bo'yicha ochiq murojat allaqachon yuborilgan.",
        mainKeyboard(ctx)
      );
      return ctx.scene.leave();
    }

    await CoddyAttendance.create({
      teacherId: ctx.from.id,
      teacherName: workerName,
      studentName,
      studentGroup: normalizedGroup,
      mainTeacher: workerName,
      topic: normalizedComment,
      status: "Kutilmoqda",
      requesterRole: workerRoleRaw,
      callConfirmed: false,
      requestType: "talk_request",
      date,
      time
    });

    await ctx.reply(
      [
        "Murojat yuborildi:",
        `O'quvchi: ${studentName}`,
        `Guruh: ${rawGroupName}`,
        `Izoh: ${normalizedComment}`,
        `Vaqt: ${date} ${time}`
      ].join("\n"),
      mainKeyboard(ctx)
    );

    const notifyText = [
      "Botdan yangi murojat",
      `Kim: ${workerName} (${workerRole})`,
      `O'quvchi: ${studentName}`,
      `Guruh: ${rawGroupName}`,
      `Mentor izohi: ${normalizedComment}`,
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
    console.error("talk request save error:", error);
    await ctx.reply("Murojatni saqlashda xatolik yuz berdi.", mainKeyboard(ctx));
  }

  return ctx.scene.leave();
}

const talkRequestScene = new WizardScene(
  "coddy_talk_request_wizard",

  // Step 0 - Entry: show mentor groups or go full manual
  async (ctx) => {
    const workerName =
      ctx.state?.worker?.fullName || ctx.from.first_name || ctx.from.username || "";

    let groups = [];
    if (workerName) {
      try {
        groups = await Group.find({ mentor: workerName }).lean();
      } catch {
        // silent
      }
    }

    if (!groups.length) {
      ctx.wizard.state.flow = "manual";
      await ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
      ctx.wizard.next(); // 0->1
      ctx.wizard.next(); // 1->2
      return;
    }

    ctx.wizard.state.groups = groups;

    const groupButtons = [[MANUAL_BTN]];
    groups.forEach((g) => groupButtons.push([g.name + (g.days ? ` (${g.days})` : "")]));
    groupButtons.push([CANCEL_BTN]);

    await ctx.reply("Guruhni tanlang:", Markup.keyboard(groupButtons).resize());
    return ctx.wizard.next(); // 0->1
  },

  // Step 1 - Group selection
  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) return cancelAndExit(ctx);

    if (ctx.message?.text === MANUAL_BTN) {
      ctx.wizard.state.flow = "manual";
      await ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
      return ctx.wizard.next(); // 1->2
    }

    const selectedText = String(ctx.message?.text || "").trim();
    const groups = ctx.wizard.state.groups || [];
    const group = groups.find(
      (g) =>
        g.name + (g.days ? ` (${g.days})` : "") === selectedText ||
        g.name === selectedText
    );

    if (!group) {
      return ctx.reply("Guruhni ro'yxatdan tanlang.");
    }

    ctx.wizard.state.flow = "group";
    ctx.wizard.state.groupName = group.name;

    let students = [];
    try {
      students = await Student.find({
        groupId: group._id,
        isActive: true,
        frozenStatus: { $nin: FROZEN_STATUSES }
      })
        .sort({ fullName: 1 })
        .lean();
    } catch {
      // silent
    }

    ctx.wizard.state.students = students;

    if (!students.length) {
      ctx.wizard.state.flow = "group_manual";
      await ctx.reply(
        `${group.name} guruhida faol o'quvchi topilmadi.\nO'quvchi ismini kiriting:`,
        cancelKeyboard
      );
      return ctx.wizard.next(); // 1->2
    }

    const studentButtons = [[MANUAL_BTN]];
    students.forEach((s) => studentButtons.push([s.fullName]));
    studentButtons.push([CANCEL_BTN]);

    await ctx.reply(
      `${group.name} guruhidagi o'quvchilar:`,
      Markup.keyboard(studentButtons).resize()
    );
    return ctx.wizard.next(); // 1->2
  },

  // Step 2 - Student selection or manual student name
  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) return cancelAndExit(ctx);

    const text = String(ctx.message?.text || "").trim();
    const flow = ctx.wizard.state.flow;

    if (flow === "manual") {
      if (!text) return ctx.reply("Ism familiyani kiriting.");
      ctx.wizard.state.studentName = text;
      await ctx.reply("Guruhini kiriting:", cancelKeyboard);
      return ctx.wizard.next(); // 2->3
    }

    if (flow === "group_manual") {
      if (!text) return ctx.reply("O'quvchi ismini kiriting.");
      ctx.wizard.state.studentName = text;
      ctx.wizard.state.finalGroupName = ctx.wizard.state.groupName;
      await askMandatoryComment(ctx);
      ctx.wizard.next(); // 2->3
      return ctx.wizard.next(); // 3->4
    }

    if (flow === "group") {
      if (text === MANUAL_BTN) {
        ctx.wizard.state.flow = "group_manual";
        await ctx.reply("O'quvchi ism familiyasini kiriting:", cancelKeyboard);
        return;
      }

      if (!text) return ctx.reply("O'quvchini tanlang yoki ismini kiriting.");
      ctx.wizard.state.studentName = text;
      ctx.wizard.state.finalGroupName = ctx.wizard.state.groupName;
      await askMandatoryComment(ctx);
      ctx.wizard.next(); // 2->3
      return ctx.wizard.next(); // 3->4
    }
  },

  // Step 3 - Manual group name (manual flow only)
  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) return cancelAndExit(ctx);

    const flow = ctx.wizard.state.flow;
    if (flow !== "manual") {
      return; // skipped via double-next
    }

    const studentGroup = String(ctx.message?.text || "").trim();
    if (!studentGroup) return ctx.reply("Guruhini kiriting.");

    ctx.wizard.state.finalGroupName = studentGroup;
    await askMandatoryComment(ctx);
    return ctx.wizard.next(); // 3->4
  },

  // Step 4 - Mandatory comment and save
  async (ctx) => {
    if (ctx.message?.text === CANCEL_BTN) return cancelAndExit(ctx);

    const comment = normalizeCompactText(ctx.message?.text);
    if (!comment) {
      await ctx.reply("Murojat matnini kiriting.");
      return;
    }

    return saveAndNotify(
      ctx,
      ctx.wizard.state.studentName,
      ctx.wizard.state.finalGroupName,
      comment
    );
  }
);

talkRequestScene.hears(CANCEL_BTN, (ctx) => cancelAndExit(ctx));

module.exports = talkRequestScene;
