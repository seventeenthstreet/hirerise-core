'use strict';

const logger = require('../../utils/logger');
const cache = require('./analyticsCache.service');
const predictiveHeat = require('./predictiveHeat.service');
const snapshotWorker = require('../workers/cacheSnapshot.worker');

const DEFAULT_TOP_N = Number(process.env.WARM_PREFETCH_TOP_N || 12);
const REFRESH_INTERVAL_MS = Number(
  process.env.WARM_PREFETCH_REFRESH_MS || 120000
);

let worker = null;
const fallbackHotset = new Map();
let hydratedSnapshot = null;

function safeNow() {
  return Date.now();
}

function computeWarmScore(telemetry = {}) {
  const replayDrift = telemetry.replayDrift || 0;
  const heatScore = telemetry.heatScore || 0;
  const lineageScore = telemetry.lineageFusionScore || 0;

  const recencyBoost = telemetry.lastSeen
    ? Math.max(0, 1 - (safeNow() - telemetry.lastSeen) / 900000)
    : 0;

  return (
    replayDrift * 0.35 +
    heatScore * 0.35 +
    lineageScore * 0.2 +
    recencyBoost * 0.1
  );
}

async function hydrateBootSnapshot() {
  try {
    hydratedSnapshot = global.__CACHE_LINEAGE_SNAPSHOT__ || null;

    if (!hydratedSnapshot?.hotTenants) {
      logger.info('[WarmStatePrefetch] No lineage hotset snapshot found');
      return [];
    }

    for (const [tenantId, meta] of Object.entries(
      hydratedSnapshot.hotTenants
    )) {
      fallbackHotset.set(tenantId, {
        ...meta,
        hydratedAt: safeNow(),
      });
    }

    logger.info(
      `[WarmStatePrefetch] Hydrated ${fallbackHotset.size} tenants from lineage snapshot`
    );

    return [...fallbackHotset.keys()];
  } catch (err) {
    logger.warn(
      `[WarmStatePrefetch] Snapshot hydration fallback mode: ${err.message}`
    );
    return [];
  }
}

async function rankHotTenants() {
  const ranked = [];

  for (const [tenantId, meta] of fallbackHotset.entries()) {
    ranked.push({
      tenantId,
      score: computeWarmScore(meta),
    });
  }

  ranked.sort((a, b) => b.score - a.score);

  return ranked.slice(0, DEFAULT_TOP_N);
}

async function prefetchTenantState(tenantId, targetRegion = 'primary') {
  try {
    if (predictiveHeat.prefetchTenantHeatWindow) {
      await predictiveHeat.prefetchTenantHeatWindow(tenantId);
    }

    if (cache.prewarmTenantNamespace) {
      await cache.prewarmTenantNamespace(tenantId);
    }

    const existing = fallbackHotset.get(tenantId) || {};

    fallbackHotset.set(tenantId, {
      ...existing,
      lastPrefetched: safeNow(),
      targetRegion,
    });

    logger.info(
      `[WarmStatePrefetch] Prefetched warm state for tenant ${tenantId} -> ${targetRegion}`
    );

    return true;
  } catch (err) {
    logger.warn(
      `[WarmStatePrefetch] Prefetch degraded for ${tenantId} -> ${targetRegion}: ${err.message}`
    );
    return false;
  }
}

/**
 * Patch 16 compatibility layer
 * Used by cross-region migration mesh
 */
async function prefetchTenant(tenantId, targetRegion = 'primary') {
  return prefetchTenantState(tenantId, targetRegion);
}

async function runPrefetchCycle() {
  const topTenants = await rankHotTenants();

  if (!topTenants.length) {
    logger.info('[WarmStatePrefetch] No ranked tenants for prefetch');
    return;
  }

  await Promise.allSettled(
    topTenants.map(({ tenantId }) => prefetchTenantState(tenantId))
  );
}

function startWarmStatePrefetchWorker() {
  if (worker) return;

  worker = setInterval(async () => {
    try {
      await runPrefetchCycle();
    } catch (err) {
      logger.error(
        `[WarmStatePrefetch] Worker cycle failed: ${err.message}`
      );
    }
  }, REFRESH_INTERVAL_MS);

  logger.info('[WarmStatePrefetch] Worker started');
}

function stopWarmStatePrefetchWorker() {
  if (!worker) return;

  clearInterval(worker);
  worker = null;

  logger.info('[WarmStatePrefetch] Worker stopped');
}

function observeTenantActivity(tenantId, telemetry = {}) {
  const existing = fallbackHotset.get(tenantId) || {};

  fallbackHotset.set(tenantId, {
    ...existing,
    ...telemetry,
    lastSeen: safeNow(),
  });
}

async function preserveHotsetSnapshot() {
  try {
    const hotTenants = Object.fromEntries(fallbackHotset.entries());

    global.__CACHE_LINEAGE_SNAPSHOT__ = {
      ...(global.__CACHE_LINEAGE_SNAPSHOT__ || {}),
      hotTenants,
      patch: 'wave3-patch16-cross-region-migration',
      preservedAt: new Date().toISOString(),
    };

    if (snapshotWorker.preserveShutdownSnapshot) {
      await snapshotWorker.preserveShutdownSnapshot();
    }

    logger.info(
      `[WarmStatePrefetch] Preserved ${fallbackHotset.size} hot tenants`
    );
  } catch (err) {
    logger.warn(
      `[WarmStatePrefetch] Snapshot preservation fallback: ${err.message}`
    );
  }
}

module.exports = {
  hydrateBootSnapshot,
  rankHotTenants,
  runPrefetchCycle,
  startWarmStatePrefetchWorker,
  stopWarmStatePrefetchWorker,
  observeTenantActivity,
  preserveHotsetSnapshot,
  prefetchTenant,
  prefetchTenantState,
};