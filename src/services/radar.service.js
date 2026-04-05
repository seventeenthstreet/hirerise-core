'use strict';

/**
 * @file src/services/radar.service.js
 * @description
 * Radar skill matching service.
 *
 * Architecture:
 * - Supabase RPC first
 * - Redis durable short TTL cache
 * - stale-safe null handling
 * - thin service layer
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');

const cache = cacheManager.getClient();

const CACHE_TTL_SECONDS = 300;
const CACHE_PREFIX = 'radar:skills:';
const RPC_NAME = 'match_skills';

function buildCacheKey(userId) {
  return `${CACHE_PREFIX}${userId}`;
}

async function getCachedRadar(cacheKey) {
  try {
    const cached = await cache.get(cacheKey);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    logger.warn('[Radar] Cache read failed', {
      cacheKey,
      error: error.message,
    });
    return null;
  }
}

async function setCachedRadar(cacheKey, payload) {
  try {
    await cache.set(
      cacheKey,
      JSON.stringify(payload),
      CACHE_TTL_SECONDS
    );
  } catch (error) {
    logger.warn('[Radar] Cache write failed', {
      cacheKey,
      error: error.message,
    });
  }
}

async function getRadarSkills(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const cacheKey = buildCacheKey(userId);

  try {
    const cached = await getCachedRadar(cacheKey);
    if (cached) {
      logger.info('[Radar] Cache hit', { userId });
      return cached;
    }

    logger.info('[Radar] Cache miss → RPC lookup', {
      userId,
      rpc: RPC_NAME,
    });

    const { data, error } = await supabase.rpc(RPC_NAME, {
      input_user_id: userId,
    });

    if (error) {
      logger.error('[Radar] RPC failed', {
        userId,
        rpc: RPC_NAME,
        error: error.message,
      });

      throw new Error(error.message);
    }

    const safeData = Array.isArray(data) ? data : [];

    await setCachedRadar(cacheKey, safeData);

    return safeData;
  } catch (error) {
    logger.error('[Radar] Service failed', {
      userId,
      error: error.message,
    });

    throw error;
  }
}

module.exports = {
  getRadarSkills,
};