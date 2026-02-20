const env = require("../config/env");
const User = require("../models/User");
const CoddyTeacher = require("./models/CoddyTeacher");
const { getWorkerMainKeyboard, adminMainKeyboard } = require("./keyboards");

let coddyBot = null;
let coddyMode = "disabled";

function isAdmin(ctx) {
  if (env.coddyAdminIds.includes(Number(ctx.from?.id))) return true;
  return ctx.state?.worker?.role === "kurator";
}

function canUseCallRequest(ctx) {
  const role = String(ctx.state?.worker?.role || "").toLowerCase();
  return role === "mentor" || role === "mentor_ta";
}

async function findBotUserByTelegramId(telegramId) {
  const normalized = String(telegramId || "").trim();
  if (!normalized) return null;

  return User.findOne({
    telegramId: normalized,
    isActive: true,
    role: { $in: ["kurator", "mentor", "ta", "mentor_ta"] }
  });
}

async function userAllowed(ctx) {
  const telegramId = Number(ctx.from?.id);
  if (!telegramId) return { allowed: false, worker: null };

  // DB-based: check registered users first (curator, mentor, ta, mentor_ta)
  const user = await findBotUserByTelegramId(telegramId);
  if (user) {
    return { allowed: true, worker: user };
  }

  // Env-based fallback for emergency access without DB record
  if (env.coddyAdminIds.includes(telegramId)) {
    return { allowed: true, worker: null };
  }

  return { allowed: false, worker: null };
}

function getMainKeyboard(ctx) {
  if (isAdmin(ctx)) {
    return adminMainKeyboard;
  }

  return getWorkerMainKeyboard(ctx.state?.worker?.role);
}

async function handleStart(ctx) {
  const { id, first_name: firstName, username = "" } = ctx.from;
  const displayName = ctx.state?.worker?.fullName || firstName || username || "Teacher";

  await CoddyTeacher.findOneAndUpdate(
    { telegramId: id },
    { name: displayName, username },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return ctx.reply(`Xush kelibsiz, ${displayName}!`, {
    reply_markup: {
      keyboard: getMainKeyboard(ctx),
      resize_keyboard: true
    }
  });
}

async function startCoddyCheckBot() {
  if (!env.coddyBotToken || env.coddyBotToken === "disabled") {
    console.log("Coddy bot skipped: CODDY_BOT_TOKEN is missing or disabled");
    return null;
  }

  let Telegraf;
  let Scenes;
  let session;

  try {
    ({ Telegraf, Scenes, session } = require("telegraf"));
  } catch (error) {
    console.error("Coddy bot skipped: telegraf dependency not found.");
    console.error("Run: npm install telegraf luxon");
    return null;
  }

  const teacherController = require("./controllers/teacherController");
  const adminController = require("./controllers/adminController");
  const startCoddyDailyReport = require("./jobs/dailyReport");

  const attendanceScene = require("./scenes/attendanceScene");
  const callRequestScene = require("./scenes/callRequestScene");
  const reportScene = require("./scenes/reportScene");
  const settingsScene = require("./scenes/settingsScene");
  const searchScene = require("./scenes/searchScene");
  const editScene = require("./scenes/editScene");

  coddyBot = new Telegraf(env.coddyBotToken);

  const stage = new Scenes.Stage([
    attendanceScene,
    callRequestScene,
    reportScene,
    settingsScene,
    searchScene,
    editScene
  ]);
  coddyBot.use(session());

  coddyBot.use(async (ctx, next) => {
    try {
      if (!ctx.from) return next();

      const { allowed, worker } = await userAllowed(ctx);
      if (!allowed) {
        return ctx.reply("Sizda botdan foydalanish huquqi yo'q.");
      }

      ctx.state.worker = worker || null;
      return next();
    } catch (error) {
      console.error("Bot middleware error:", error);
      return ctx.reply("Botda texnik xatolik yuz berdi.").catch(() => { });
    }
  });

  coddyBot.use(stage.middleware());

  coddyBot.catch((err, ctx) => {
    console.error(`Telegraf error for update ${ctx.update?.update_id}:`, err);
  });

  coddyBot.start(async (ctx) => {
    try {
      await handleStart(ctx);
    } catch (error) {
      console.error("handleStart error:", error);
      await ctx.reply("Start buyrug'ida xatolik yuz berdi.").catch(() => { });
    }
  });

  coddyBot.hears("📣 O'quvchi chaqirish", (ctx) => {
    if (!canUseCallRequest(ctx)) {
      return ctx.reply("Bu tugma faqat Mentor va Mentor+TA uchun.");
    }
    return ctx.scene.enter("coddy_call_request_wizard");
  });

  coddyBot.hears("➕ O'quvchi qo'shish", (ctx) => ctx.scene.enter("coddy_attendance_wizard"));
  coddyBot.hears("⚙️ Sozlamalar", (ctx) => ctx.scene.enter("coddy_settings_scene"));
  coddyBot.hears("ℹ️ Yordam", (ctx) =>
    ctx.reply(
      "Mentor uchun: '📣 O'quvchi chaqirish' tugmasi mavjud.\n" +
      "Assistent (TA) uchun: '➕ O'quvchi qo'shish' tugmasi mavjud."
    )
  );

  coddyBot.hears("📊 Hisobot", (ctx) => {
    if (!isAdmin(ctx)) return;
    return adminController.startReportFlow(ctx);
  });

  coddyBot.hears("🔍 Qidiruv", (ctx) => {
    if (!isAdmin(ctx)) return;
    return ctx.scene.enter("coddy_search_scene");
  });

  coddyBot.hears("🔙 Orqaga", (ctx) =>
    ctx.reply("Asosiy menyu", {
      reply_markup: {
        keyboard: getMainKeyboard(ctx),
        resize_keyboard: true
      }
    })
  );

  coddyBot.action(/^coddy_delete_mark_(.+)$/, teacherController.deleteMark);
  coddyBot.action(/^coddy_edit_mark_(.+)$/, teacherController.editMark);

  startCoddyDailyReport(coddyBot);

  try {
    if (env.nodeEnv === "production" && env.coddyPublicUrl) {
      const webhookUrl = `${env.coddyPublicUrl}/api/telegram/coddy`;
      await coddyBot.telegram.deleteWebhook({ drop_pending_updates: true });
      await coddyBot.telegram.setWebhook(webhookUrl);
      coddyMode = "webhook";
      console.log(`Coddy bot started in webhook mode: ${webhookUrl}`);
    } else {
      await coddyBot.telegram.deleteWebhook({ drop_pending_updates: true });
      await coddyBot.launch();
      coddyMode = "polling";
      console.log("Coddy bot started in polling mode");
    }
  } catch (error) {
    coddyBot = null;
    coddyMode = "failed";
    console.error("Failed to start Coddy bot:", error.message);
    return null;
  }

  return coddyBot;
}

async function handleCoddyWebhook(req, res) {
  if (!coddyBot) {
    return res.status(503).json({ success: false, message: "Coddy bot is not running" });
  }

  try {
    await coddyBot.handleUpdate(req.body, res);
  } catch (error) {
    console.error("Coddy webhook error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Coddy webhook failed" });
    }
  }

  return undefined;
}

function stopCoddyCheckBot(signal = "stop") {
  if (!coddyBot) return;
  coddyBot.stop(signal);
}

function getCoddyBotStatus() {
  return {
    enabled: Boolean(coddyBot),
    mode: coddyMode
  };
}

function getBotInstance() {
  return coddyBot;
}

module.exports = {
  startCoddyCheckBot,
  stopCoddyCheckBot,
  handleCoddyWebhook,
  getCoddyBotStatus,
  getBotInstance
};
