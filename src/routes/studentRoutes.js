const express = require("express");
const {
  getStudents,
  createStudent,
  updateStudent,
  deleteStudent,
  getFrozenStudents
} = require("../controllers/studentController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("kurator"));

router.get("/", getStudents);
router.post("/", createStudent);
router.patch("/:id", updateStudent);
router.delete("/:id", deleteStudent);
router.get("/frozen", getFrozenStudents);

module.exports = router;
