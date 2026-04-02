'use strict';

/**
 * Opportunity Radar Engine (Precompute + RPC + Smart Cache)
 *
 * Flow:
 *   1. Try Redis cache
 *   2. Try precomputed DB result
 *   3. Fallback to RPC
 *   4. Cache result
 *   5. Async refresh if stale
 */

const crypto = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const CACHE_TTL = 1800; // 30 mins
const STALE_TTL = 1800; // 30 mins (for DB freshness)

const cache = cacheManager?.getClient?.();

// ─────────────────────────────────────────────
// VERSIONING (GLOBAL INVALIDATION)
// ─────────────────────────────────────────────

async function getRadarVersion() {
  if (!cache) return 'v1';

  try {
    const version = await cache.get('radar:version');
    return version || 'v1';
  } catch {
    return 'v1';
  }
}

// ─────────────────────────────────────────────
// CACHE KEY
// ─────────────────────────────────────────────

async function buildCacheKey(userId, opts) {
  const version = await getRadarVersion();

  const hash = crypto
    .createHash('md5')
    .update(JSON.stringify(opts))
    .digest('hex')
    .slice(0, 8);

  return `radar:${version}:${userId}:${hash}`;
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

async function getOpportunityRadar(userId, opts = {}) {
  const {
    topN = 10,
    minOpportunityScore = 40,
    minMatchScore = 0
  } = opts;

  const cacheKey = await buildCacheKey(userId, {
    topN,
    minOpportunityScore,
    minMatchScore
  });

  // ─────────────────────────────────────────
  // 1️⃣ REDIS CACHE
  // ─────────────────────────────────────────
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn('[Radar] cache read failed', { err: err.message });
    }
  }

  // ─────────────────────────────────────────
  // 2️⃣ PRECOMPUTED DB
  // ─────────────────────────────────────────
  let dbData = null;

  try {
    const { data } = await supabase
      .from('user_opportunity_radar')
      .select('data, updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (data?.data) {
      dbData = data;

      // 🔥 async refresh if stale (non-blocking)
      const isStale =
        Date.now() - new Date(data.updated_at).getTime() > STALE_TTL * 1000;

      if (isStale) {
        refreshRadarAsync(userId);
      }

      // cache it
      if (cache) {
        await cache.set(cacheKey, JSON.stringify(data.data), 'EX', CACHE_TTL);
      }

      return data.data;
    }

  } catch (err) {
    logger.warn('[Radar] precomputed fetch failed', {
      userId,
      err: err.message
    });
  }

  // ─────────────────────────────────────────
  // 3️⃣ FALLBACK → RPC
  // ─────────────────────────────────────────
  const fresh = await computeRadarRPC(userId, {
    topN,
    minOpportunityScore,
    minMatchScore
  });

  // cache it
  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(fresh), 'EX', CACHE_TTL);
    } catch (err) {
      logger.warn('[Radar] cache write failed', { err: err.message });
    }
  }

  return fresh;
}

// ─────────────────────────────────────────────
// RPC COMPUTE
// ─────────────────────────────────────────────

async function computeRadarRPC(userId, opts) {
  try {
    const { data, error } = await supabase.rpc(
      'get_opportunity_radar',
      {
        p_user_id: userId,
        p_top_n: opts.topN,
        p_min_opportunity_score: opts.minOpportunityScore,
        p_min_match_score: opts.minMatchScore
      }
    );

    if (error) throw error;

    return data;

  } catch (err) {
    logger.error('[Radar] RPC failed', {
      userId,
      err: err.message
    });

    return {
      emerging_opportunities: [],
      user_skills: 0,
      generated_at: new Date().toISOString(),
      vector_used: false,
      error: 'RADAR_RPC_FAILED'
    };
  }
}

// ─────────────────────────────────────────────
// ASYNC REFRESH (STALE-WHILE-REVALIDATE)
// ─────────────────────────────────────────────

async function refreshRadarAsync(userId) {
  setImmediate(async () => {
    try {
      await supabase.rpc('precompute_opportunity_radar', {
        p_user_id: userId
      });
    } catch (err) {
      logger.warn('[Radar] async refresh failed', {
        userId,
        err: err.message
      });
    }
  });
}

// ─────────────────────────────────────────────
// USER-LEVEL INVALIDATION
// ─────────────────────────────────────────────

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
      err: err.message
    });
  }
}

// ─────────────────────────────────────────────
// GLOBAL INVALIDATION (VERSION BUMP)
// ─────────────────────────────────────────────

async function bumpRadarVersion() {
  if (!cache) return;

  try {
    await cache.set('radar:version', `v${Date.now()}`);
  } catch (err) {
    logger.warn('[Radar] version bump failed', {
      err: err.message
    });
  }
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  getOpportunityRadar,
  invalidateOpportunityRadar,
  bumpRadarVersion
};