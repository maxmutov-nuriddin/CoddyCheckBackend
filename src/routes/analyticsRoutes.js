const express = require("express");
const { getAnalytics } = require("../controllers/analyticsController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("kurator"));

// GET /api/analytics
router.get("/", getAnalytics);

module.exports = router;
