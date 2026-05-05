const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");
const {
  getMyGroups,
  getMyStudents,
  getDashboard,
  updateStudentStatus
} = require("../controllers/mentorController");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("mentor", "mentor_ta"));

router.get("/dashboard", getDashboard);
router.get("/groups", getMyGroups);
router.get("/students", getMyStudents);
router.patch("/students/:id/status", updateStudentStatus);

module.exports = router;
