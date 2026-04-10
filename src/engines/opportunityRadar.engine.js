'use strict';

/**
 * Opportunity Radar Engine (Wave 1 Drift Hardened)
 *
 * Flow:
 *   1. Try Redis cache
 *   2. Try precomputed DB result
 *   3. Fallback to RPC
 *   4. Cache normalized result
 *   5. Async refresh if stale
 *
 * Wave 1 hardening:
 *   - RPC drift-safe normalization
 *   - schema-cache / missing RPC fallback envelope
 *   - DB row shape drift tolerance
 *   - stale refresh dedupe safety
 *   - cache corruption protection
 */

const crypto = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const CACHE_TTL = 1800;
const STALE_TTL = 1800;
const RADAR_RPC = 'get_opportunity_radar';

const cache = cacheManager?.getClient?.();
const inFlightRefreshes = new Set();

async function getRadarVersion() {
  if (!cache) return 'v1';

  try {
    const version = await cache.get('radar:version');
    return version || 'v1';
  } catch {
    return 'v1';
  }
}

async function buildCacheKey(userId, opts) {
  const version = await getRadarVersion();

  const hash = crypto
    .createHash('md5')
    .update(JSON.stringify(opts || {}))
    .digest('hex')
    .slice(0, 8);

  return `radar:${version}:${userId}:${hash}`;
}

async function getOpportunityRadar(userId, opts = {}) {
  const normalizedOpts = normalizeOptions(opts);

  const cacheKey = await buildCacheKey(userId, normalizedOpts);

  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        try {
          return normalizeRadarPayload(JSON.parse(cached));
        } catch {
          logger.warn('[Radar] cache parse failed', { userId });
        }
      }
    } catch (err) {
      logger.warn('[Radar] cache read failed', {
        userId,
        err: err.message,
      });
    }
  }

  try {
    const { data, error } = await supabase
      .from('user_opportunity_radar')
      .select('data, updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data?.data) {
      const payload = normalizeRadarPayload(data.data);
      const updatedAt = data.updated_at
        ? new Date(data.updated_at).getTime()
        : 0;

      const isStale =
        !updatedAt || Date.now() - updatedAt > STALE_TTL * 1000;

      if (isStale) {
        refreshRadarAsync(userId, normalizedOpts);
      }

      await writeCacheSafe(cacheKey, payload, userId);
      return payload;
    }
  } catch (err) {
    logger.warn('[Radar] precomputed fetch failed', {
      userId,
      err: err.message,
    });
  }

  const fresh = await computeRadarRPC(userId, normalizedOpts);
  await writeCacheSafe(cacheKey, fresh, userId);
  return fresh;
}

async function computeRadarRPC(userId, opts) {
  try {
    const { data, error } = await supabase.rpc(RADAR_RPC, {
      p_user_id: userId,
      p_top_n: opts.topN,
      p_min_opportunity_score: opts.minOpportunityScore,
      p_min_match_score: opts.minMatchScore,
    });

    if (error) throw error;
    return normalizeRadarPayload(data);
  } catch (err) {
    logger.error('[Radar] RPC failed', {
      userId,
      rpc: RADAR_RPC,
      code: err.code,
      err: err.message,
    });

    return emptyRadar('RADAR_RPC_FAILED');
  }
}

function refreshRadarAsync(userId, opts = {}) {
  const key = `${userId}:${JSON.stringify(opts)}`;
  if (inFlightRefreshes.has(key)) return;

  inFlightRefreshes.add(key);

  setImmediate(async () => {
    try {
      await computeRadarRPC(userId, normalizeOptions(opts));
    } catch (err) {
      logger.warn('[Radar] async refresh failed', {
        userId,
        err: err.message,
      });
    } finally {
      inFlightRefreshes.delete(key);
    }
  });
}

async function invalidateOpportunityRadar(userId) {
  if (!cache) return;

  try {
    const version = await getRadarVersion();
    const pattern = `radar:${version}:${userId}:*`;

    let cursor = '0';
    const keys = [];

    do {
      const result = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    if (keys.length) {
      await cache.del(keys);
    }
  } catch (err) {
    logger.warn('[Radar] invalidation failed', {
      userId,
      err: err.message,
    });
  }
}

async function bumpRadarVersion() {
  if (!cache) return;

  try {
    await cache.set('radar:version', `v${Date.now()}`);
  } catch (err) {
    logger.warn('[Radar] version bump failed', {
      err: err.message,
    });
  }
}

function normalizeOptions(opts = {}) {
  return {
    topN: safeNumber(opts.topN, 10),
    minOpportunityScore: safeNumber(opts.minOpportunityScore, 40),
    minMatchScore: safeNumber(opts.minMatchScore, 0),
  };
}

function normalizeRadarPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      emerging_opportunities: payload,
      user_skills: 0,
      generated_at: new Date().toISOString(),
      vector_used: false,
    };
  }

  if (!payload || typeof payload !== 'object') {
    return emptyRadar();
  }

  return {
    emerging_opportunities: Array.isArray(payload.emerging_opportunities)
      ? payload.emerging_opportunities
      : [],
    user_skills: safeNumber(payload.user_skills, 0),
    generated_at: payload.generated_at || new Date().toISOString(),
    vector_used: Boolean(payload.vector_used),
    ...(payload.error ? { error: payload.error } : {}),
  };
}

function emptyRadar(errorCode) {
  return {
    emerging_opportunities: [],
    user_skills: 0,
    generated_at: new Date().toISOString(),
    vector_used: false,
    ...(errorCode ? { error: errorCode } : {}),
  };
}

async function writeCacheSafe(cacheKey, payload, userId) {
  if (!cache) return;

  try {
    await cache.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL);
  } catch (err) {
    logger.warn('[Radar] cache write failed', {
      userId,
      err: err.message,
    });
  }
}

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  getOpportunityRadar,
  invalidateOpportunityRadar,
  bumpRadarVersion,
};