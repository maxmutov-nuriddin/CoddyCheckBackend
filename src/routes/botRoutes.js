const express = require("express");
const { getBotCalls } = require("../controllers/attendanceController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("kurator"));

// GET /api/bot/calls — Bot integratsiyasi: only oquvchi_chaqirish (call_extra, keep)
router.get("/calls", getBotCalls);

module.exports = router;
