'use strict';

/**
 * radar.service.js (PRODUCTION OPTIMIZED)
 *
 * ✅ Uses Supabase RPC (match_skills)
 * ✅ Removes heavy Node computation
 * ✅ Adds Redis caching layer
 * ✅ Fast (<150ms target)
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = 'radar:skills:';

/**
 * Get Radar Skills (Optimized)
 * @param {string} userId
 */
async function getRadarSkills(userId) {
  const cacheKey = `${CACHE_PREFIX}${userId}`;

  try {
    // 🔥 STEP 3 — Check Cache First
    const cached = await cacheManager.get(cacheKey);
    if (cached) {
      logger.info('[Radar] cache hit', { userId });
      return JSON.parse(cached);
    }

    logger.info('[Radar] cache miss → calling RPC', { userId });

    // 🔥 STEP 1 & 2 — Call Supabase RPC (thin layer)
    const { data, error } = await supabase.rpc('match_skills', {
      input_user_id: userId
    });

    if (error) {
      logger.error('[Radar] RPC error', { userId, error: error.message });
      throw new Error(error.message);
    }

    // 🔥 Cache result
    await cacheManager.set(
      cacheKey,
      JSON.stringify(data),
      CACHE_TTL
    );

    return data;

  } catch (err) {
    logger.error('[Radar] failed', {
      userId,
      error: err.message
    });
    throw err;
  }
}

module.exports = {
  getRadarSkills
};