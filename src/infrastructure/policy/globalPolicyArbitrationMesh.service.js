const logger = require("../../utils/logger");

const policyState = {
  tenantPolicies: new Map(),
  regionPolicies: new Map(),
  emergencyMode: false,
  initialized: false,
};

function defaultRegionPolicy(region) {
  return {
    region,
    geoCompliance: true,
    legalFailoverTargets: [],
    replicationAllowedRegions: [],
    residencyStrict: false,
    costWeight: 1,
    disasterRecoveryEligible: true,
    failoverPriority: 100,
    updatedAt: Date.now(),
  };
}

function defaultTenantPolicy(tenantId) {
  return {
    tenantId,
    allowedRegions: [],
    blockedRegions: [],
    residencyRegion: null,
    legalEntities: [],
    allowCrossRegionReplication: false,
    sovereignLock: false,
    maxRegionalCostWeight: 10,
    emergencyOverride: false,
    overridePriority: 0,
    updatedAt: Date.now(),
  };
}

function initializeGlobalPolicyMesh({
  regions = [],
  bootstrapPolicies = {},
} = {}) {
  for (const region of regions) {
    policyState.regionPolicies.set(
      region,
      bootstrapPolicies[region] || defaultRegionPolicy(region)
    );
  }

  policyState.initialized = true;

  logger.info(
    `[PolicyMesh] initialized with ${regions.length} regional policies`
  );
}

function upsertTenantPolicy(tenantId, partialPolicy = {}) {
  const current =
    policyState.tenantPolicies.get(tenantId) ||
    defaultTenantPolicy(tenantId);

  const next = {
    ...current,
    ...partialPolicy,
    tenantId,
    updatedAt: Date.now(),
  };

  policyState.tenantPolicies.set(tenantId, next);
  return next;
}

function upsertRegionPolicy(region, partialPolicy = {}) {
  const current =
    policyState.regionPolicies.get(region) ||
    defaultRegionPolicy(region);

  const next = {
    ...current,
    ...partialPolicy,
    region,
    updatedAt: Date.now(),
  };

  policyState.regionPolicies.set(region, next);
  return next;
}

function getTenantPolicy(tenantId) {
  return (
    policyState.tenantPolicies.get(tenantId) ||
    defaultTenantPolicy(tenantId)
  );
}

function getRegionPolicy(region) {
  return (
    policyState.regionPolicies.get(region) ||
    defaultRegionPolicy(region)
  );
}

function veto(reason) {
  return {
    allowed: false,
    reason,
    priorityBoost: -100000,
  };
}

function evaluateRegionEligibility({
  tenantId,
  targetRegion,
  requestType = "read",
  isFailover = false,
  isReplication = false,
  estimatedCostWeight = 1,
}) {
  const tenantPolicy = getTenantPolicy(tenantId);
  const regionPolicy = getRegionPolicy(targetRegion);

  if (!regionPolicy.geoCompliance) {
    return veto("geo_compliance_block");
  }

  if (
    tenantPolicy.allowedRegions.length > 0 &&
    !tenantPolicy.allowedRegions.includes(targetRegion)
  ) {
    return veto("tenant_region_not_allowed");
  }

  if (tenantPolicy.blockedRegions.includes(targetRegion)) {
    return veto("tenant_region_blocked");
  }

  if (
    tenantPolicy.sovereignLock &&
    tenantPolicy.residencyRegion &&
    tenantPolicy.residencyRegion !== targetRegion
  ) {
    return veto("sovereign_lock_violation");
  }

  if (
    tenantPolicy.residencyRegion &&
    requestType === "write" &&
    tenantPolicy.residencyRegion !== targetRegion
  ) {
    return veto("data_residency_write_violation");
  }

  if (isReplication) {
    if (!tenantPolicy.allowCrossRegionReplication) {
      return veto("tenant_replication_disallowed");
    }

    if (
      regionPolicy.replicationAllowedRegions.length > 0 &&
      !regionPolicy.replicationAllowedRegions.includes(targetRegion)
    ) {
      return veto("region_replication_illegal");
    }
  }

  if (isFailover && !regionPolicy.disasterRecoveryEligible) {
    return veto("dr_region_not_eligible");
  }

  if (
    estimatedCostWeight > tenantPolicy.maxRegionalCostWeight &&
    !tenantPolicy.emergencyOverride
  ) {
    return veto("cost_governance_block");
  }

  return {
    allowed: true,
    reason: "allowed",
    priorityBoost:
      regionPolicy.failoverPriority + tenantPolicy.overridePriority,
  };
}

function arbitrateBeforeRouting({
  tenantId,
  candidateRegions = [],
  requestType,
  isFailover,
  isReplication,
}) {
  const decisions = [];

  for (const region of candidateRegions) {
    const decision = evaluateRegionEligibility({
      tenantId,
      targetRegion: region,
      requestType,
      isFailover,
      isReplication,
    });

    if (decision.allowed) {
      decisions.push({ region, ...decision });
    }
  }

  return decisions.sort((a, b) => b.priorityBoost - a.priorityBoost);
}

function setEmergencyPolicyMode(enabled = true) {
  policyState.emergencyMode = enabled;
  logger.warn(`[PolicyMesh] emergency mode=${enabled}`);
}

function getPolicyMeshSnapshot() {
  return {
    initialized: policyState.initialized,
    emergencyMode: policyState.emergencyMode,
    tenantPolicies: policyState.tenantPolicies.size,
    regionPolicies: policyState.regionPolicies.size,
  };
}

function shutdownGlobalPolicyMesh() {
  logger.info("[PolicyMesh] shutdown preservation markers flushed");
}

module.exports = {
  initializeGlobalPolicyMesh,
  upsertTenantPolicy,
  upsertRegionPolicy,
  getTenantPolicy,
  getRegionPolicy,
  evaluateRegionEligibility,
  arbitrateBeforeRouting,
  setEmergencyPolicyMode,
  getPolicyMeshSnapshot,
  shutdownGlobalPolicyMesh,
};