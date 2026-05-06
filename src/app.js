const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { loginBruteForce } = require("./middlewares/bruteForceMiddleware");
const authRoutes = require("./routes/authRoutes");
const studentRoutes = require("./routes/studentRoutes");
const attendanceRoutes = require("./routes/attendanceRoutes");
const workerRoutes = require("./routes/workerRoutes");
const groupRoutes = require("./routes/groupRoutes");
const activityRoutes = require("./routes/activityRoutes");
const botRoutes = require("./routes/botRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const supportRoutes = require("./routes/supportRoutes");
const mentorRoutes = require("./routes/mentorRoutes");
const { handleCoddyWebhook, getCoddyBotStatus } = require("./coddyCheck/bot");
const { errorHandler, notFoundHandler } = require("./middlewares/errorHandler");

const app = express();

// Proxy orqasida ishlaganda haqiqiy IP ni olish uchun
app.set("trust proxy", 1);

// ── Xavfsizlik headerlari ──────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  xssFilter: true,
  frameguard: { action: "deny" },
  hidePoweredBy: true,
}));

// ── CORS: faqat ruxsat etilgan originlar ──────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://coddycheck.netlify.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "http://localhost:4173",
];

app.use(cors({
  origin: (origin, callback) => {
    // origin yo'q bo'lsa (server-to-server yoki curl) — rad etish (production)
    if (!origin) {
      if (process.env.NODE_ENV === "production") {
        return callback(new Error("CORS: origin talab qilinadi"), false);
      }
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: ${origin} ruxsat etilmagan`), false);
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
  optionsSuccessStatus: 200,
}));

// ── Body hajmini cheklash (katta zaproslardan himoya) ─────────────────────
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false, limit: "50kb" }));

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Umumiy API rate limiter (DoS himoyasi) ────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 daqiqa
  max: 120, // 1 daqiqada max 120 ta request per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Juda ko'p so'rov yuborildi. Bir oz kuting." },
  skip: (req) => req.originalUrl === "/api/health",
});
app.use("/api", generalLimiter);

// ── Rate limiting (brute-force himoyasi) ──────────────────────────────────

// Login: IP asosida 2 failed → 3-chida 15 daqiqa blok (bruteForce middleware)
// + zapas: 15 daqiqada 20 ta request dan oshsa ham blok
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring." },
});

// Register: bir IP dan 5 daqiqada 3 ta so'rov
const registerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Juda ko'p ro'yxatdan o'tish urinishi. 5 daqiqadan so'ng urinib ko'ring." },
});

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Juda ko'p so'rov. 15 daqiqadan so'ng qayta urinib ko'ring." },
});

const resetLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Juda ko'p urinish. 5 daqiqadan so'ng qayta urinib ko'ring." },
});

// loginBruteForce birinchi (IP blok), loginRateLimiter zapas sifatida
app.use("/api/auth/login", loginBruteForce, loginRateLimiter);
app.use("/api/auth/register", registerLimiter);
app.use("/api/auth/forgot-password", forgotLimiter);
app.use("/api/auth/reset-password", resetLimiter);

// ── Routes ────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "Backend is running",
    coddyBot: getCoddyBotStatus()
  });
});

app.post("/api/telegram/coddy", handleCoddyWebhook);

app.use("/api/auth", authRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/workers", workerRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/bot", botRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/mentor", mentorRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
