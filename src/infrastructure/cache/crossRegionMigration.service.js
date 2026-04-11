'use strict';

const logger = require('../../utils/logger');
const cache = require('./analyticsCache.service');
const locality = require('./regionLocalityForecast.service');
const lineageReplication = require('./lineageRegionReplication.service');
const warmPrefetch = require('./warmStatePrefetch.service');

const DEFAULT_TOP_N = Number(process.env.CROSS_REGION_TOP_N || 10);
const CURRENT_REGION = process.env.CLOUD_RUN_REGION || 'primary';

function getMigrationCandidates(topN = DEFAULT_TOP_N) {
  try {
    const tenants = cache.getTopHotTenants?.(50) || [];
    const scored = [];

    for (const tenantId of tenants) {
      const drifts =
        locality.forecastRegionDrift?.(
          tenantId,
          CURRENT_REGION
        ) || [];

      if (!drifts.length) continue;

      scored.push({
        tenantId,
        ...drifts[0],
      });
    }

    return scored
      .sort((a, b) => b.driftScore - a.driftScore)
      .slice(0, topN);
  } catch (error) {
    logger.warn(
      `[Patch16] Migration candidate fallback mode: ${error.message}`
    );
    return [];
  }
}

async function migrateTenantWarmState(candidate) {
  if (!candidate?.tenantId || !candidate?.targetRegion) {
    return false;
  }

  try {
    const snapshot =
      cache.getTenantSnapshot?.(candidate.tenantId) || null;

    if (snapshot) {
      lineageReplication.replicateLineageSnapshot?.(
        candidate.tenantId,
        candidate.targetRegion,
        snapshot
      );
    }

    const migrated = await warmPrefetch.prefetchTenant?.(
      candidate.tenantId,
      candidate.targetRegion
    );

    if (!migrated) {
      logger.warn(
        `[Patch16] Warm migration degraded for ${candidate.tenantId} -> ${candidate.targetRegion}`
      );
      return false;
    }

    logger.info(
      `[Patch16] Warm migrated ${candidate.tenantId} -> ${candidate.targetRegion}`
    );

    return true;
  } catch (error) {
    logger.error('[Patch16] cross-region migration failed', {
      tenantId: candidate.tenantId,
      targetRegion: candidate.targetRegion,
      error: error.message,
    });

    return false;
  }
}

async function runCrossRegionMigrationCycle() {
  try {
    const candidates = getMigrationCandidates();

    if (!candidates.length) {
      logger.info('[Patch16] No migration candidates');
      return;
    }

    await Promise.allSettled(
      candidates.map((candidate) =>
        migrateTenantWarmState(candidate)
      )
    );
  } catch (error) {
    logger.error(
      `[Patch16] Migration cycle failed: ${error.message}`
    );
  }
}

module.exports = {
  getMigrationCandidates,
  migrateTenantWarmState,
  runCrossRegionMigrationCycle,
};