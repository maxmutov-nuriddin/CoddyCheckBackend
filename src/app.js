const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const authRoutes = require("./routes/authRoutes");
const studentRoutes = require("./routes/studentRoutes");
const attendanceRoutes = require("./routes/attendanceRoutes");
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

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
