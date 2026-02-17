const { Scenes, Markup } = require("telegraf");
const CoddyAttendance = require("../models/CoddyAttendance");
const { adminMainKeyboard } = require("../keyboards");

const { WizardScene } = Scenes;

const reportScene = new WizardScene(
  "coddy_report_scene",
  async (ctx) => {
    try {
      const teachers = await CoddyAttendance.distinct("teacherName");
      if (!teachers.length) {
        await ctx.reply("Hisobot uchun ma'lumot yo'q.", Markup.keyboard(adminMainKeyboard).resize());
        return ctx.scene.leave();
      }

      const buttons = teachers.sort((a, b) => a.localeCompare(b)).map((name) => [`👨‍🏫 ${name}`]);
      buttons.unshift(["👥 Barcha support"]);
      buttons.push(["🔙 Bekor qilish"]);

      ctx.reply("Support tanlang:", Markup.keyboard(buttons).oneTime().resize());
      return ctx.wizard.next();
    } catch (error) {
      console.error("report scene step1:", error);
      await ctx.reply("Supportlarni olishda xatolik.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const text = ctx.message?.text;

    if (text === "🔙 Bekor qilish") {
      await ctx.reply("Bekor qilindi.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }

    ctx.wizard.state.selectedTeacher = text;

    try {
      const query = {};
      if (text !== "👥 Barcha support") {
        query.teacherName = text.replace("👨‍🏫 ", "");
      }

      const groups = await CoddyAttendance.distinct("studentGroup", query);
      if (!groups.length) {
        await ctx.reply("Tanlangan support uchun guruh topilmadi.", Markup.keyboard(adminMainKeyboard).resize());
        return ctx.scene.leave();
      }

      const buttons = groups.sort((a, b) => a.localeCompare(b)).map((name) => [`🏫 ${name}`]);
      buttons.unshift(["🌐 Barcha guruh"]);
      buttons.push(["🔙 Bekor qilish"]);

      ctx.reply("Guruh tanlang:", Markup.keyboard(buttons).oneTime().resize());
      return ctx.wizard.next();
    } catch (error) {
      console.error("report scene step2:", error);
      await ctx.reply("Guruhlarni olishda xatolik.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const text = ctx.message?.text;

    if (text === "🔙 Bekor qilish") {
      await ctx.reply("Bekor qilindi.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }

    ctx.wizard.state.selectedGroup = text;

    try {
      const query = {};
      const selectedTeacher = ctx.wizard.state.selectedTeacher;

      if (selectedTeacher !== "👥 Barcha support") {
        query.teacherName = selectedTeacher.replace("👨‍🏫 ", "");
      }

      if (text !== "🌐 Barcha guruh") {
        query.studentGroup = text.replace("🏫 ", "");
      }

      const dates = await CoddyAttendance.distinct("date", query);
      if (!dates.length) {
        await ctx.reply("Tanlangan filter bo'yicha sana topilmadi.", Markup.keyboard(adminMainKeyboard).resize());
        return ctx.scene.leave();
      }

      const buttons = dates.sort((a, b) => b.localeCompare(a)).slice(0, 20).map((date) => [date]);
      buttons.unshift(["📅 Barcha sanalar"]);
      buttons.push(["🔙 Bekor qilish"]);

      ctx.reply("Sana tanlang:", Markup.keyboard(buttons).oneTime().resize());
      return ctx.wizard.next();
    } catch (error) {
      console.error("report scene step3:", error);
      await ctx.reply("Sanalarni olishda xatolik.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const selectedDate = ctx.message?.text;

    if (selectedDate === "🔙 Bekor qilish") {
      await ctx.reply("Bekor qilindi.", Markup.keyboard(adminMainKeyboard).resize());
      return ctx.scene.leave();
    }

    const selectedTeacher = ctx.wizard.state.selectedTeacher;
    const selectedGroup = ctx.wizard.state.selectedGroup;

    const query = {};

    if (selectedTeacher !== "👥 Barcha support") {
      query.teacherName = selectedTeacher.replace("👨‍🏫 ", "");
    }

    if (selectedGroup !== "🌐 Barcha guruh") {
      query.studentGroup = selectedGroup.replace("🏫 ", "");
    }

    if (selectedDate !== "📅 Barcha sanalar") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
        await ctx.reply("Sana format xato.", Markup.keyboard(adminMainKeyboard).resize());
        return ctx.scene.leave();
      }
      query.date = selectedDate;
    }

    try {
      const rows = await CoddyAttendance.find(query).sort({ teacherName: 1, studentGroup: 1, date: -1, time: 1 });

      if (!rows.length) {
        await ctx.reply("Yozuv topilmadi.", Markup.keyboard(adminMainKeyboard).resize());
        return ctx.scene.leave();
      }

      let report = "📊 Hisobot\n\n";
      let currentGroup = null;

      rows.forEach((row) => {
        if (currentGroup !== row.studentGroup) {
          currentGroup = row.studentGroup;
          report += `━━━━━━━━━━\n🏫 GURUH: ${row.studentGroup}\n━━━━━━━━━━\n\n`;
        }

        report += `🕒 ${row.date} ${row.time}\n`;
        report += `👤 O'quvchi: ${row.studentName}\n`;
        report += `📚 Mavzu: ${row.topic}\n`;
        report += `✌️ Support: ${row.teacherName}\n`;
        report += `👨‍🏫 Asosiy ustoz: ${row.mainTeacher}\n\n`;
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
      console.error("report scene step4:", error);
      await ctx.reply("Hisobot yaratishda xatolik.", Markup.keyboard(adminMainKeyboard).resize());
    }

    return ctx.scene.leave();
  }
);

module.exports = reportScene;
