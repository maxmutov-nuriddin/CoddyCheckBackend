function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    message: `Route not found: ${req.originalUrl}`
  });
}

function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500;
  const payload = {
    success: false,
    message: err.message || "Internal server error"
  };

  if (err.details) {
    payload.details = err.details;
  }

  // Stack trace faqat server logiga yoziladi, clientga YUBORILMAYDI
  if (err.stack) {
    console.error("[ErrorHandler]", err.stack);
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  notFoundHandler,
  errorHandler
};
