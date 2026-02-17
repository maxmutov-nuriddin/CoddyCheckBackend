const express = require("express");
const {
  manualAttendance,
  queueTaNotification,
  callStudent,
  confirmArrival,
  updateStatus,
  recallStudent,
  getCalledList,
  getDailyReport,
  getRecentActivity,
  telegramWebhook
} = require("../controllers/attendanceController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.post("/bot/webhook", telegramWebhook);

router.use(authMiddleware);
router.use(allowRoles("kurator"));

router.post("/manual", manualAttendance);
router.post("/ta-notify", queueTaNotification);
router.post("/call", callStudent);
router.patch("/:id/arrival-confirm", confirmArrival);
router.patch("/:id/status", updateStatus);
router.post("/:id/recall", recallStudent);
router.get("/called", getCalledList);
router.get("/report", getDailyReport);
router.get("/recent-activity", getRecentActivity);

module.exports = router;
