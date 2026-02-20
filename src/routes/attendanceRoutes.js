const express = require("express");
const {
  manualAttendance,
  queueTaNotification,
  confirmBotCallRequest,
  callStudent,
  confirmArrival,
  updateStatus,
  recallStudent,
  getCalledList,
  getDailyReport,
  getResults,
  getRecentActivity,
  telegramWebhook,
  deleteActivity,
  createCalledStudent,
  getCalledStudents,
  deleteCalledStudent
} = require("../controllers/attendanceController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.post("/bot/webhook", telegramWebhook);

router.use(authMiddleware);
router.use(allowRoles("kurator"));

router.post("/manual", manualAttendance);
router.post("/ta-notify", queueTaNotification);
router.patch("/bot-request/:id/confirm", confirmBotCallRequest);
router.post("/call", callStudent);
router.patch("/:id/arrival-confirm", confirmArrival);
router.patch("/:id/status", updateStatus);
router.post("/:id/recall", recallStudent);
router.get("/called", getCalledList);
router.get("/report", getDailyReport);
router.get("/results", getResults);
router.get("/recent-activity", getRecentActivity);
router.delete("/activity/:id", deleteActivity);
router.post("/called-students", createCalledStudent);
router.get("/called-students", getCalledStudents);
router.delete("/called-students/:id", deleteCalledStudent);

module.exports = router;
