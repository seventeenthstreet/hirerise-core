function tenantRegionMiddleware(req, _res, next) {
  try {
    req.tenantId =
      req.user?.tenantId ||
      req.headers["x-tenant-id"] ||
      "global";

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  tenantRegionMiddleware,
};