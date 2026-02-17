const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const allowRoles = require("../middlewares/roleMiddleware");
const {
  listWorkers,
  createWorker,
  updateWorker,
  deactivateWorker
} = require("../controllers/workerController");

const router = express.Router();

router.use(authMiddleware);
router.use(allowRoles("kurator"));

router.get("/", listWorkers);
router.post("/", createWorker);
router.patch("/:id", updateWorker);
router.delete("/:id", deactivateWorker);

module.exports = router;
