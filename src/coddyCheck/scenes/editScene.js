const { Scenes, Markup } = require("telegraf");
const CoddyAttendance = require("../models/CoddyAttendance");
const { teacherMainKeyboard } = require("../keyboards");
const { normalizeGroupName } = require("../utils/normalizeGroupName");

const { WizardScene } = Scenes;

const editScene = new WizardScene(
  "coddy_edit_scene",
  async (ctx) => {
    const markId = ctx.wizard.state.markId;

    if (!markId) {
      await ctx.reply("Tahrirlash uchun yozuv topilmadi.", Markup.keyboard(teacherMainKeyboard).resize());
      return ctx.scene.leave();
    }

    const row = await CoddyAttendance.findById(markId);
    if (!row) {
      await ctx.reply("Yozuv topilmadi.", Markup.keyboard(teacherMainKeyboard).resize());
      return ctx.scene.leave();
    }

    ctx.wizard.state.record = row;

    const text = [
      "📝 Yozuvni tahrirlash:",
      `O'quvchi: ${row.studentName}`,
      `Guruh: ${row.studentGroup}`,
      `Asosiy ustoz: ${row.mainTeacher}`,
      `Mavzu: ${row.topic}`,
      "",
      "Qaysi maydonni o'zgartirasiz?"
    ].join("\n");

    await ctx.reply(
      text,
      Markup.keyboard([
        ["👤 O'quvchi", "🏫 Guruh"],
        ["👨‍🏫 Asosiy ustoz", "📚 Mavzu"],
        ["🔙 Bekor qilish"]
      ])
        .oneTime()
        .resize()
    );

    return ctx.wizard.next();
  },
  (ctx) => {
    const choice = ctx.message?.text;

    if (choice === "🔙 Bekor qilish") {
      ctx.reply("Bekor qilindi.", Markup.keyboard(teacherMainKeyboard).resize());
      return ctx.scene.leave();
    }

    const fieldMap = {
      "👤 O'quvchi": "studentName",
      "🏫 Guruh": "studentGroup",
      "👨‍🏫 Asosiy ustoz": "mainTeacher",
      "📚 Mavzu": "topic"
    };

    if (!fieldMap[choice]) {
      return ctx.reply("Maydonni menyudan tanlang.");
    }

    ctx.wizard.state.fieldToEdit = fieldMap[choice];
    ctx.wizard.state.fieldLabel = choice;

    ctx.reply("Yangi qiymatni kiriting:", Markup.keyboard([["🔙 Bekor qilish"]]).oneTime().resize());
    return ctx.wizard.next();
  },
  async (ctx) => {
    const value = ctx.message?.text;

    if (value === "🔙 Bekor qilish") {
      await ctx.reply("Bekor qilindi.", Markup.keyboard(teacherMainKeyboard).resize());
      return ctx.scene.leave();
    }

    if (!value || !String(value).trim()) {
      return ctx.reply("Yangi qiymat kiriting.");
    }

    const { markId, fieldToEdit, fieldLabel } = ctx.wizard.state;

    try {
      const trimmedValue = String(value).trim();
      const finalValue = fieldToEdit === "studentGroup" ? normalizeGroupName(trimmedValue) : trimmedValue;

      await CoddyAttendance.findByIdAndUpdate(markId, { [fieldToEdit]: finalValue });
      await ctx.reply(`✅ Yangilandi: ${fieldLabel} -> ${trimmedValue}`, Markup.keyboard(teacherMainKeyboard).resize());
    } catch (error) {
      console.error("edit scene error:", error);
      await ctx.reply("Saqlashda xatolik.", Markup.keyboard(teacherMainKeyboard).resize());
    }

    return ctx.scene.leave();
  }
);

module.exports = editScene;
