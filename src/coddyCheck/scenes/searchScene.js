const { Scenes, Markup } = require("telegraf");
const CoddyAttendance = require("../models/CoddyAttendance");
const { adminMainKeyboard } = require("../keyboards");

const { WizardScene } = Scenes;

const searchScene = new WizardScene(
  "coddy_search_scene",
  (ctx) => {
    ctx.reply("Qidiruv matnini kiriting (o'quvchi yoki guruh):", Markup.keyboard([["🔙 Bekor qilish"]]).oneTime().resize());
    return ctx.wizard.next();
  },
  async (ctx) => {
    const text = ctx.message?.text;

    if (text === "🔙 Bekor qilish") {
      await ctx.reply("Bekor qilindi.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }

    if (!text) {
      return ctx.reply("Qidiruv matni kiriting.");
    }

    if (text.length > 50) {
      await ctx.reply("Qidiruv matni juda uzun. Maksimal 50 belgi kiriting.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }

    try {
      const stripped = text.replace(/\s+/g, "");
      const pattern = stripped
        .split("")
        .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s*");

      const regex = new RegExp(pattern, "i");

      const rows = await CoddyAttendance.find({
        $or: [{ studentName: regex }, { studentGroup: regex }]
      })
        .sort({ date: -1, time: -1 })
        .limit(20);

      if (!rows.length) {
        await ctx.reply("Hech narsa topilmadi.", Markup.keyboard(adminMainKeyboard).resize());
        return ctx.scene.leave();
      }

      let report = `🔎 Qidiruv natijalari: "${text}"\n\n`;

      rows.forEach((row) => {
        report += `🕒 ${row.date} ${row.time}\n`;
        report += `👤 O'quvchi: ${row.studentName}\n`;
        report += `📚 Mavzu: ${row.topic}\n`;
        report += `🏫 Guruh: ${row.studentGroup}\n`;
        report += `✌️ Support: ${row.teacherName}\n`;
        report += `👨‍🏫 Asosiy ustoz: ${row.mainTeacher}\n`;
        report += `━━━━━━━━━━\n`;
      });

      if (report.length > 4000) {
        const chunks = report.match(/[\s\S]{1,4000}/g) || [];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      } else {
        await ctx.reply(report);
      }

      await ctx.reply("Tayyor.", Markup.keyboard(adminMainKeyboard).resize());
    } catch (error) {
      console.error("search scene error:", error);
      await ctx.reply("Qidiruvda xatolik.", Markup.keyboard(adminMainKeyboard).resize());
    }

    return ctx.scene.leave();
  }
);

module.exports = searchScene;
