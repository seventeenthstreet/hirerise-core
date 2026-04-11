const sovereignRouting = require(
  "../infrastructure/routing/sovereignRoutingMesh.service"
);
const globalPolicyMesh = require(
  "../infrastructure/policy/globalPolicyArbitrationMesh.service"
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

    // Patch 18 → policy arbitration veto BEFORE Patch 17 routing
    const policyApprovedRegions =
      globalPolicyMesh.arbitrateBeforeRouting({
        tenantId,
        candidateRegions: allowedRegions,
        requestType: req.method === "GET" ? "read" : "write",
        isFailover: false,
        isReplication: false,
      });

    const routingCandidates =
      policyApprovedRegions.length > 0
        ? policyApprovedRegions.map((r) => r.region)
        : allowedRegions;

    req.executionRegion =
      sovereignRouting.routeRegion(routingCandidates);

    req.tenantId = tenantId;
    req.policyApprovedRegions = routingCandidates;

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  tenantRegionMiddleware,
};