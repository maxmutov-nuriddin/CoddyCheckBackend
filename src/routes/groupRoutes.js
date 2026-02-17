const express = require("express");
const { getGroups, createGroup, deleteGroup } = require("../controllers/groupController");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getGroups);
router.post("/", allowRoles("kurator"), createGroup);
router.delete("/:id", allowRoles("kurator"), deleteGroup);

module.exports = router;
