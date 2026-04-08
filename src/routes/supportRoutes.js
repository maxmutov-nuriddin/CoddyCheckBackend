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
} = require("../controllers/supportController");

const router = express.Router();

// All support routes require auth + support role
router.use(authMiddleware, supportMiddleware);

router.get("/requests", listRequests);
router.post("/requests/:id/approve", approveRequest);
router.post("/requests/:id/reject", rejectRequest);
router.get("/analytics", getAllKuratorsAnalytics);

router.get("/kurators", listKurators);
router.patch("/kurators/:id/toggle", toggleKuratorStatus);
router.patch("/kurators/:id/filials", updateKuratorFilials);
router.delete("/kurators/:id", deleteKurator);

module.exports = router;
