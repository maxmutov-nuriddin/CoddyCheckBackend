const express = require("express");
const { login, register, getMe, updateProfile, changePassword, deleteAccount, forgotPassword, resetPassword, getCommentPresets, updateCommentPresets } = require("../controllers/authController");
const authMiddleware = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

router.get("/me", authMiddleware, getMe);
router.patch("/profile", authMiddleware, updateProfile);
router.patch("/password", authMiddleware, changePassword);
router.delete("/account", authMiddleware, deleteAccount);

router.get("/comment-presets", authMiddleware, getCommentPresets);
router.put("/comment-presets", authMiddleware, updateCommentPresets);

module.exports = router;
