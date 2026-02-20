const jwt = require("jsonwebtoken");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const env = require("../config/env");

// ── In-memory user cache for read-only (GET) requests ─────────────────
// GET requests dominate (dashboard auto-refreshes every 30s per staff member).
// Non-GET requests (PATCH /password, PATCH /profile, DELETE /account)
// always bypass cache and receive a live Mongoose document
// with .save() and .comparePassword() methods intact.
// TTL = 30s — matches the dashboard refresh interval exactly.
const _userCache = new Map(); // userId → { user: lean object, expiresAt }
const CACHE_TTL_MS = 30_000;

// Prevent unbounded growth — prune expired entries when cache exceeds 100 entries
// (far more than any realistic number of concurrent staff)
function pruneCache() {
  if (_userCache.size < 100) return;
  const now = Date.now();
  for (const [key, val] of _userCache) {
    if (val.expiresAt <= now) _userCache.delete(key);
  }
}

async function authMiddleware(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new ApiError(401, "Authorization token is required"));
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const userId = String(payload.userId);

    // ── Fast path: cached lean object for GET requests ─────────────────
    // .lean() returns plain JS object — sufficient for all GET handlers
    // which only read req.user._id, req.user.role, req.user.fullName etc.
    if (req.method === "GET") {
      const cached = _userCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        req.user = cached.user;
        return next();
      }

      const user = await User.findById(userId).lean();
      if (!user || !user.isActive) {
        return next(new ApiError(401, "User not found or inactive"));
      }

      pruneCache();
      _userCache.set(userId, { user, expiresAt: Date.now() + CACHE_TTL_MS });
      req.user = user;
      return next();
    }

    // ── Full Mongoose document for mutating requests ────────────────────
    // POST/PATCH/DELETE controllers may call:
    //   req.user.comparePassword(pw)  — instance method
    //   req.user.password = newPw; req.user.save()  — mutation + persist
    const user = await User.findById(userId);
    if (!user || !user.isActive) {
      return next(new ApiError(401, "User not found or inactive"));
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(new ApiError(401, "Invalid or expired token"));
  }
}

module.exports = authMiddleware;
