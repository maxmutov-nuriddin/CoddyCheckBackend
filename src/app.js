const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./routes/authRoutes");
const studentRoutes = require("./routes/studentRoutes");
const attendanceRoutes = require("./routes/attendanceRoutes");
const workerRoutes = require("./routes/workerRoutes");
const groupRoutes = require("./routes/groupRoutes");
const activityRoutes = require("./routes/activityRoutes");
const botRoutes = require("./routes/botRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const { handleCoddyWebhook, getCoddyBotStatus } = require("./coddyCheck/bot");
const { errorHandler, notFoundHandler } = require("./middlewares/errorHandler");

const app = express();

// ── Xavfsizlik headerlari ──────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS: faqat ruxsat etilgan originlar ──────────────────────────────────
app.use(cors({
  origin: [
    "https://coddycheck.netlify.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4173",
  ],
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Rate limiting (brute-force himoyasi) ──────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 daqiqa
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring." },
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

app.use("/api/auth/login", loginLimiter);
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

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
