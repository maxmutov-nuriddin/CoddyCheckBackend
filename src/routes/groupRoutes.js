const express = require("express");
const { getGroups, createGroup, deleteGroup, updateGroup, bulkAddStudents } = require("../controllers/groupController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getGroups);
router.post("/", allowRoles("kurator"), createGroup);
router.post("/:id/bulk-add", allowRoles("kurator"), bulkAddStudents);
router.delete("/:id", allowRoles("kurator"), deleteGroup);
router.put("/:id", allowRoles("kurator"), updateGroup);

module.exports = router;
