const { Scenes, Markup } = require("telegraf");
const CoddyTeacher = require("../models/CoddyTeacher");
const CoddyAttendance = require("../models/CoddyAttendance");
const User = require("../../models/User");
const { teacherMainKeyboard } = require("../keyboards");

const { WizardScene } = Scenes;

const settingsScene = new WizardScene(
  "coddy_settings_scene",
  (ctx) => {
    ctx.reply(
      "⚙️ Sozlamalar",
      Markup.keyboard([["✏️ Ismni o'zgartirish"], ["🔙 Orqaga"]])
        .oneTime()
        .resize()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const text = ctx.message?.text;

    if (text === "🔙 Orqaga") {
      await ctx.reply("Asosiy menyu", Markup.keyboard(teacherMainKeyboard).resize());
      return ctx.scene.leave();
    }

    if (text === "✏️ Ismni o'zgartirish") {
      ctx.wizard.state.waitingForName = true;
      return ctx.reply("Yangi ismingizni kiriting:");
    }

    if (!ctx.wizard.state.waitingForName) {
      return ctx.reply("Menyudan tanlang.");
    }

    const newName = String(text || "").trim();
    if (!newName) {
      return ctx.reply("Ism bo'sh bo'lmasligi kerak.");
    }

    try {
      const userId = ctx.from.id;

      await CoddyTeacher.findOneAndUpdate({ telegramId: userId }, { name: newName }, { upsert: true, new: true });
      await CoddyAttendance.updateMany({ teacherId: userId }, { teacherName: newName });
      await User.updateMany(
        { telegramId: String(userId), role: { $in: ["mentor", "ta", "mentor_ta"] } },
        { fullName: newName }
      );

      await ctx.reply(`✅ Ism yangilandi: ${newName}`, Markup.keyboard(teacherMainKeyboard).resize());
    } catch (error) {
      console.error("settings scene error:", error);
      await ctx.reply("Ismni yangilashda xatolik.", Markup.keyboard(teacherMainKeyboard).resize());
    }

    return ctx.scene.leave();
  }
);

module.exports = settingsScene;
