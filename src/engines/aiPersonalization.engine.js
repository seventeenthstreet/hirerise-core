'use strict';

/**
 * Personalization Engine (Supabase + AI Vector Integrated)
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');
const { getUserVector, updateUserVector } = require('../services/userVector.service'); // ✅ NEW

const CACHE_TTL_SECONDS = 600;

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const P_WEIGHTS = Object.freeze({
  behavior_signals: 0.40,
  skill_alignment: 0.30,
  opportunity_score: 0.20,
  market_demand: 0.10
});

const EVENT_WEIGHTS = Object.freeze({
  job_apply: 5.0,
  job_click: 2.0,
  job_save: 2.5,
  opportunity_click: 2.0,
  career_path_view: 1.8,
  skill_view: 1.5,
  skill_search: 1.5,
  course_view: 1.3,
  learning_path_start: 2.0,
  role_explore: 1.5,
  advice_read: 1.0,
  dashboard_module_usage: 0.5,
  salary_check: 1.2
});

const cache = cacheManager?.getClient?.() || null;

// ─────────────────────────────────────────────────────────────
// PROFILE LOADER (SUPABASE)
// ─────────────────────────────────────────────────────────────

async function loadUserProfile(userId) {
  if (!userId) throw new Error('userId is required');

  try {
    const [profileRes, progressRes] = await Promise.all([
      supabase
        .from('userProfiles')
        .select('skills, targetRole, currentJobTitle, industry, experienceYears, yearsExperience')
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from('onboardingProgress')
        .select('skills')
        .eq('id', userId)
        .maybeSingle()
    ]);

    if (profileRes.error) throw profileRes.error;
    if (progressRes.error) throw progressRes.error;

    const profile = profileRes.data || {};
    const progress = progressRes.data || {};

    const rawSkills =
      (Array.isArray(profile.skills) && profile.skills) ||
      (Array.isArray(progress.skills) && progress.skills) ||
      [];

    const cleanedSkills = rawSkills
      .map(s => (typeof s === 'string' ? s : s?.name))
      .filter(Boolean);

    // 🔥 NEW: ensure user vector exists
    try {
      await updateUserVector(userId, cleanedSkills);
    } catch (err) {
      logger.warn('[Personalization] vector update skipped', {
        userId,
        error: err.message
      });
    }

    return {
      skills: cleanedSkills,
      targetRole: profile.targetRole || profile.currentJobTitle || null,
      industry: profile.industry || null,
      yearsExperience:
        profile.experienceYears ?? profile.yearsExperience ?? 0
    };
  } catch (err) {
    logger.error('[PersonalizationEngine] loadUserProfile failed', {
      userId,
      error: err?.message || err
    });

    return {
      skills: [],
      targetRole: null,
      industry: null,
      yearsExperience: 0
    };
  }
}

// ─────────────────────────────────────────────────────────────
// UPSERT PROFILE
// ─────────────────────────────────────────────────────────────

async function upsertPersonalizationProfile(userId, profile) {
  if (!userId) throw new Error('userId is required');

  try {
    // 🔥 NEW: attach vector (optional for analytics / future ML)
    let userVector = null;
    try {
      userVector = await getUserVector(userId, profile.skills || []);
    } catch (_) {}

    const payload = {
      user_id: userId,
      ...profile,
      user_vector: userVector, // ✅ NEW FIELD (optional column)
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('user_personalization_profile')
      .upsert(payload, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;

    // Cache invalidation
    if (cache) {
      try {
        await Promise.all([
          cache.del(`personalization:profile:${userId}`),
          cache.del(`personalization:recommendations:${userId}`)
        ]);
      } catch (cacheErr) {
        logger.warn('[Cache] Invalidation failed', {
          error: cacheErr?.message || cacheErr
        });
      }
    }

    return data;
  } catch (err) {
    logger.error('[PersonalizationEngine] upsert failed', {
      userId,
      error: err?.message || err
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// EVENT TRACKING
// ─────────────────────────────────────────────────────────────

async function trackBehaviorEvent(userId, eventData = {}) {
  if (!userId) throw new Error('userId required');
  if (!eventData.event_type) throw new Error('event_type required');

  try {
    const { data, error } = await supabase
      .from('user_behavior_events')
      .insert({
        user_id: userId,
        event_type: eventData.event_type,
        entity_type: eventData.entity_type || null,
        entity_id: eventData.entity_id || null,
        entity_label: eventData.entity_label || null,
        metadata: eventData.metadata || {},
        session_id: eventData.session_id || null
      })
      .select('id')
      .single();

    if (error) throw error;

    return { id: data.id };
  } catch (err) {
    logger.error('[PersonalizationEngine] trackBehaviorEvent failed', {
      userId,
      error: err?.message || err
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// GET PROFILE (WITH CACHE)
// ─────────────────────────────────────────────────────────────

async function getPersonalizationProfile(userId) {
  if (!userId) throw new Error('userId is required');

  const cacheKey = `personalization:profile:${userId}`;

  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.warn('[Cache] Read failed', {
        error: err?.message || err
      });
    }
  }

  try {
    const { data, error } = await supabase
      .from('user_personalization_profile')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    if (data && cache) {
      try {
        await cache.set(
          cacheKey,
          JSON.stringify(data),
          'EX',
          CACHE_TTL_SECONDS
        );
      } catch (err) {
        logger.warn('[Cache] Write failed', {
          error: err?.message || err
        });
      }
    }

    return data || null;
  } catch (err) {
    logger.error('[PersonalizationEngine] getProfile failed', {
      userId,
      error: err?.message || err
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  loadUserProfile,
  upsertPersonalizationProfile,
  trackBehaviorEvent,
  getPersonalizationProfile,
  P_WEIGHTS,
  EVENT_WEIGHTS
};