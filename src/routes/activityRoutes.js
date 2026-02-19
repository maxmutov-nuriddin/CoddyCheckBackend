const express = require("express");
const { getAllActivity } = require("../controllers/attendanceController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("kurator"));

// GET /api/activity/all — So'nggi faollik (barcha): includes mark + web, excludes call_extra/keep
router.get("/all", getAllActivity);

module.exports = router;
