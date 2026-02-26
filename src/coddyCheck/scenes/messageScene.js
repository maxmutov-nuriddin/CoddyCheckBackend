const { Scenes, Markup } = require("telegraf");
const User = require("../../models/User");
const { getWorkerMainKeyboard } = require("../keyboards");

const CANCEL_BTN = "❌ Bekor qilish";

function roleLabel(role) {
  if (role === "mentor_ta") return "Mentor+TA";
  if (role === "mentor") return "Mentor";
  if (role === "ta") return "TA";
  return "Xodim";
}

function mainKb(ctx) {
  return Markup.keyboard(getWorkerMainKeyboard(ctx.state?.worker?.role)).resize();
}

const messageScene = new Scenes.WizardScene(
  "coddy_message_scene",

  // Step 0 — xabar yozishni so'rash
  async (ctx) => {
    await ctx.reply(
      "Kuratorga xabaringizni yozing:",
      Markup.keyboard([[CANCEL_BTN]]).resize()
    );
    return ctx.wizard.next();
  },

  // Step 1 — kuratorlarga yuborish
  async (ctx) => {
    const text = String(ctx.message?.text || "").trim();

    if (text === CANCEL_BTN) {
      await ctx.reply("Bekor qilindi.", mainKb(ctx));
      return ctx.scene.leave();
    }

    if (!text) {
      await ctx.reply("Xabar matni bo'sh bo'lmasligi kerak.");
      return;
    }

    const senderName = ctx.state?.worker?.fullName || ctx.from.first_name || "Xodim";
    const senderRole = roleLabel(ctx.state?.worker?.role);
    const senderTgId = ctx.from.id;

    // Kuratorlarni DBdan olib, faqat telegramId kerak — yengil so'rov
    let kurators = [];
    try {
      kurators = await User.find({ role: "kurator", isActive: true })
        .select("telegramId")
        .lean();
    } catch (err) {
      console.error("messageScene: kurator query error:", err.message);
    }

    const notifyText = `👤 ${senderName} (${senderRole})\n\n📨 ${text}`;
    const replyBtn = Markup.inlineKeyboard([
      Markup.button.callback("💬 Javob yozish", `kr:${senderTgId}`)
    ]);

    let sent = 0;
    for (const kur of kurators) {
      if (!kur.telegramId) continue;
      try {
        await ctx.telegram.sendMessage(kur.telegramId, notifyText, replyBtn);
        sent++;
      } catch (err) {
        console.error(`messageScene: kurator ${kur.telegramId} ga yuborishda xato:`, err.message);
      }
    }

    if (sent === 0) {
      await ctx.reply("Faol kurator topilmadi.", mainKb(ctx));
    } else {
      await ctx.reply("Xabaringiz kuratorga yuborildi.", mainKb(ctx));
    }

    return ctx.scene.leave();
  }
);

messageScene.hears(CANCEL_BTN, async (ctx) => {
  await ctx.reply("Bekor qilindi.", mainKb(ctx));
  return ctx.scene.leave();
});

module.exports = messageScene;
