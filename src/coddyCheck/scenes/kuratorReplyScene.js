const { Scenes, Markup } = require("telegraf");

const CANCEL_BTN = "❌ Bekor qilish";

const adminKb = Markup.keyboard([["📊 Hisobot", "🔍 Qidiruv"]]).resize();

const kuratorReplyScene = new Scenes.WizardScene(
  "kurator_reply_scene",

  // Step 0 — javob yozishni so'rash (replyTo scene state dan keladi)
  async (ctx) => {
    const replyTo = ctx.scene.state?.replyTo;
    if (!replyTo) {
      await ctx.reply("Xato: kimga javob berish aniqlanmadi.", adminKb);
      return ctx.scene.leave();
    }

    ctx.wizard.state.replyTo = replyTo;

    await ctx.reply(
      "Javobingizni yozing:",
      Markup.keyboard([[CANCEL_BTN]]).resize()
    );
    return ctx.wizard.next();
  },

  // Step 1 — javobni xodimga yuborish
  async (ctx) => {
    const text = String(ctx.message?.text || "").trim();

    if (text === CANCEL_BTN) {
      await ctx.reply("Bekor qilindi.", adminKb);
      return ctx.scene.leave();
    }

    if (!text) {
      await ctx.reply("Javob matni bo'sh bo'lmasligi kerak.");
      return;
    }

    const replyTo = ctx.wizard.state.replyTo;
    const kurName = ctx.state?.worker?.fullName || ctx.from.first_name || "Kurator";

    try {
      await ctx.telegram.sendMessage(
        replyTo,
        `📩 Kuratordan javob (${kurName}):\n\n${text}`
      );
      await ctx.reply("Javob yuborildi.", adminKb);
    } catch (err) {
      console.error("kuratorReplyScene: javob yuborishda xato:", err.message);
      await ctx.reply("Javob yuborishda xatolik yuz berdi.", adminKb);
    }

    return ctx.scene.leave();
  }
);

kuratorReplyScene.hears(CANCEL_BTN, async (ctx) => {
  await ctx.reply("Bekor qilindi.", adminKb);
  return ctx.scene.leave();
});

module.exports = kuratorReplyScene;
