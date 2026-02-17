const ApiError = require("../utils/ApiError");

function allowRoles(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, "User not authenticated"));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, "Forbidden for this role"));
    }

    return next();
  };
}

module.exports = allowRoles;
