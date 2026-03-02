const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");
const {
  listWorkers,
  createWorker,
  updateWorker,
  deleteWorker,
  notifyWorker
} = require("../controllers/workerController");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("kurator"));

router.get("/", listWorkers);
router.post("/", createWorker);
router.patch("/:id", updateWorker);
router.delete("/:id", deleteWorker);
router.post("/:id/notify", notifyWorker);

module.exports = router;
