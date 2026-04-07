const ApiError = require("../utils/ApiError");

function supportMiddleware(req, _res, next) {
  if (!req.user || req.user.role !== "support") {
    return next(new ApiError(403, "Faqat support uchun ruxsat berilgan"));
  }
  return next();
}

module.exports = supportMiddleware;
