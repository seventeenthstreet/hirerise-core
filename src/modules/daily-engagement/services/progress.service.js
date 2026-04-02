'use strict';

const crypto = require('crypto');
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const cacheManager = require('../../../core/cache/cache.manager');

const repo = require('../models/engagement.repository');
const {
  INSIGHT_TYPES,
  SOURCE_ENGINES,
  CacheKeys,
  CACHE_TTL_SEC,
  DAILY_INSIGHT_LIMIT,
} = require('../models/engagement.constants');

const PROFILE_CACHE_TTL_SEC = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Lazy dependencies
// ─────────────────────────────────────────────────────────────────────────────

function getMarketTrend() {
  return require('../../labor-market-intelligence/services/marketTrend.service');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

function getCacheClient() {
  return cacheManager.getClient();
}

async function cacheGet(key) {
  try {
    const raw = await getCacheClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.debug('[InsightsService] Cache read failed', {
      key,
      error: error.message,
    });
    return null;
  }
}

async function cacheSet(key, value, ttl = CACHE_TTL_SEC) {
  try {
    await getCacheClient().set(
      key,
      JSON.stringify(value),
      { ttl }
    );
  } catch (error) {
    logger.debug('[InsightsService] Cache write failed', {
      key,
      error: error.message,
    });
  }
}

async function cacheDel(key) {
  try {
    await getCacheClient().delete(key);
  } catch (error) {
    logger.debug('[InsightsService] Cache delete failed', {
      key,
      error: error.message,
    });
  }
}

function buildProfileCacheKey(userId) {
  return `engagement:profile:${userId}`;
}

function buildProfileAwareCacheKey(userId, userProfile) {
  const fingerprint = crypto
    .createHash('sha1')
    .update(
      `${userProfile?.role ?? 'none'}:${userProfile?.industry ?? 'none'}`
    )
    .digest('hex')
    .slice(0, 12);

  return `${CacheKeys.insights(userId)}:${fingerprint}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// User profile reader
// ─────────────────────────────────────────────────────────────────────────────

async function readUserProfile(userId) {
  const profileCacheKey = buildProfileCacheKey(userId);
  const cached = await cacheGet(profileCacheKey);

  if (cached) return cached;

  const sources = ['users', 'profiles'];

  for (const table of sources) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('target_role, industry')
        .eq('id', userId)
        .maybeSingle();

      if (error) continue;

      if (data) {
        const profile = {
          role: data.target_role ?? null,
          industry: data.industry ?? null,
        };

        await cacheSet(profileCacheKey, profile, PROFILE_CACHE_TTL_SEC);
        return profile;
      }
    } catch {
      continue;
    }
  }

  const fallback = { role: null, industry: null };

  await cacheSet(profileCacheKey, fallback, PROFILE_CACHE_TTL_SEC);

  logger.warn('[InsightsService] User profile unavailable', {
    userId,
  });

  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// External readers
// ─────────────────────────────────────────────────────────────────────────────

async function readSkillDemand() {
  try {
    return (await getMarketTrend().getSkillDemand()) ?? [];
  } catch (error) {
    logger.warn('[InsightsService] Skill demand read failed', {
      error: error.message,
    });
    return [];
  }
}

async function readCareerTrends() {
  try {
    return (await getMarketTrend().getCareerTrends()) ?? [];
  } catch (error) {
    logger.warn('[InsightsService] Career trends read failed', {
      error: error.message,
    });
    return [];
  }
}

async function readOpportunityRadar() {
  try {
    const { data, error } = await supabase
      .from('career_opportunity_signals')
      .select(`
        id,
        role_name,
        industry,
        opportunity_score,
        created_at
      `)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return data ?? [];
  } catch (error) {
    logger.warn('[InsightsService] Opportunity radar read failed', {
      error: error.message,
    });
    return [];
  }
}

async function readJobMatches(userId) {
  try {
    const { data, error } = await supabase
      .from('job_match_results')
      .select('recommended_jobs, computed_at')
      .eq('user_id', userId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (error) {
    logger.warn('[InsightsService] Job matches read failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

async function readCareerRisk(userId) {
  try {
    const { data, error } = await supabase
      .from('risk_analysis_results')
      .select('overall_risk_score, computed_at')
      .eq('user_id', userId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (error) {
    logger.warn('[InsightsService] Career risk read failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

// helpers + builders + main exports remain unchanged from your current file