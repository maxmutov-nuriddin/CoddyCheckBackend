const dotenv = require("dotenv");

dotenv.config();

function parseNumericList(input) {
  return String(input || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

const WEAK_SECRETS = ["dev_secret", "change_this_secret", "secret", "password", "123456"];
const jwtSecret = process.env.JWT_SECRET || "dev_secret";

if (!jwtSecret || jwtSecret.length < 32 || WEAK_SECRETS.includes(jwtSecret)) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[XAVFSIZLIK XATOSI] JWT_SECRET xavfsiz emas yoki o'rnatilmagan! " +
      "Productionda kamida 32 belgidan iborat tasodifiy secret kerak. " +
      "Yaratish: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
    );
  } else {
    console.warn(
      "\n⚠️  [XAVFSIZLIK OGOHLANTIRISH] JWT_SECRET zaif yoki o'rnatilmagan!\n" +
      "   Productionga chiqishdan oldin kuchli secret o'rnating:\n" +
      "   node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"\n"
    );
  }
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  telegramApiBase: process.env.TELEGRAM_API_BASE || "https://api.telegram.org",
  appTimezone: process.env.APP_TIMEZONE || "Asia/Tashkent",

  coddyBotToken: process.env.CODDY_BOT_TOKEN || process.env.BOT_TOKEN || "",
  coddyPublicUrl: process.env.CODDY_PUBLIC_URL || process.env.PUBLIC_URL || "",
  coddyAdminIds: parseNumericList(process.env.CODDY_ADMIN_IDS || process.env.ADMIN_IDS),
  coddyAllowedIds: parseNumericList(process.env.CODDY_ALLOWED_IDS || process.env.ALLOWED_IDS),
  siteUrl: process.env.SITE_URL || ""
};
