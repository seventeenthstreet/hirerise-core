const sovereignRouting = require(
  "../infrastructure/routing/sovereignRoutingMesh.service"
);

function tenantRegionMiddleware(req, _res, next) {
  try {
    const tenantId =
      req.user?.tenantId ||
      req.headers["x-tenant-id"] ||
      "global";

    const allowedRegions =
      req.user?.allowedRegions || [
        "ap-south-1",
        "me-central-1",
        "eu-west-1",
      ];

    req.executionRegion = sovereignRouting.routeRegion(
      allowedRegions
    );

    req.tenantId = tenantId;

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  tenantRegionMiddleware,
};