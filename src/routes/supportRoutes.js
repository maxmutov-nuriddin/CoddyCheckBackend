const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const supportMiddleware = require("../middlewares/supportMiddleware");
const {
  listRequests,
  approveRequest,
  rejectRequest,
  getAllKuratorsAnalytics,
  listKurators,
  toggleKuratorStatus,
  updateKuratorFilials,
  deleteKurator,
  broadcast,
  listMentors,
  resetMentorPassword,
} = require("../controllers/supportController");

const router = express.Router();

// All support routes require auth + support role
router.use(authMiddleware, supportMiddleware);

router.get("/requests", listRequests);
router.post("/requests/:id/approve", approveRequest);
router.post("/requests/:id/reject", rejectRequest);
router.get("/analytics", getAllKuratorsAnalytics);

router.post("/broadcast", broadcast);

router.get("/kurators", listKurators);
router.patch("/kurators/:id/toggle", toggleKuratorStatus);
router.patch("/kurators/:id/filials", updateKuratorFilials);
router.delete("/kurators/:id", deleteKurator);

router.get("/mentors", listMentors);
router.post("/mentors/:id/reset-password", resetMentorPassword);

module.exports = router;
