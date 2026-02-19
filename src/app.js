const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
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

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

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
app.use("/api/attendance", attendanceRoutes);
app.use("/api/workers", workerRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/bot", botRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
