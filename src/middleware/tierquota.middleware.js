'use strict';

/**
 * tierQuota.middleware.js (Production Optimized)
 */

const { supabase } = require('../config/supabase'); // ✅ KEEP
const { AppError, ErrorCodes } = require('./errorHandler');
const { normalizeTier } = require('./requireTier.middleware');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const TIER_MONTHLY_QUOTAS = Object.freeze({
  free: {
    fullAnalysis:     3,
    generateCV:       1,
    jobMatchAnalysis: 5,
    jobSpecificCV:    1,
    careerReport:     1,
    salaryBenchmark:  10,
    default:          10,
  },
  pro: { default: null },
  enterprise: { default: null },
  premium: { default: null },
});

const QUOTA_DOC_TTL_DAYS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId ||
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id']
  );
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getQuotaLimit(tier, feature) {
  const conf = TIER_MONTHLY_QUOTAS[tier] ?? TIER_MONTHLY_QUOTAS.free;
  return feature in conf ? conf[feature] : conf.default ?? 10;
}

function ttlISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

function tierQuota(feature) {
  return async function (req, res, next) {
    const requestId = getRequestId(req);

    const userId = req.user?.uid;
    const tier   = normalizeTier(req.user?.plan);

    if (!userId) {
      return next(new AppError(
        'Authentication required',
        401,
        {},
        ErrorCodes.UNAUTHORIZED
      ));
    }

    const limit = getQuotaLimit(tier, feature);

    // Unlimited tiers
    if (limit === null) return next();

    const monthKey = currentMonthKey();

    try {
      const { data, error } = await supabase
        .from('user_quota')
        .select('count')
        .eq('user_id', userId)
        .eq('month_key', monthKey)
        .eq('feature', feature)
        .maybeSingle();

      if (error) throw error;

      const current = data?.count ?? 0;

      // ── LIMIT CHECK ───────────────────────────────────
      if (current >= limit) {
        logger.warn('[Quota] Limit exceeded', {
          requestId,
          correlationId: req.correlationId,
          userId,
          feature,
          tier,
          limit,
          used: current,
        });

        return res.status(429).json({
          success: false,
          errorCode: 'QUOTA_EXCEEDED',
          quotaExhausted: true,
          upgradeUrl: process.env.UPGRADE_URL ?? '/pricing',
          details: { feature, limit, used: current },
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      // ── SAFE INCREMENT (POST-SUCCESS) ─────────────────
      res.on('finish', async () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            await supabase.rpc('increment_user_quota', {
              p_user_id: userId,
              p_month_key: monthKey,
              p_feature: feature,
              p_increment: 1,
              p_expires_at: ttlISO(QUOTA_DOC_TTL_DAYS),
            });
          } catch (err) {
            logger.error('[Quota] Increment failed', {
              requestId,
              userId,
              feature,
              error: err.message,
            });
          }
        }
      });

      return next();

    } catch (err) {
      logger.error('[Quota] Check failed', {
        requestId,
        userId,
        feature,
        error: err.message,
      });

      return res.status(503).json({
        success: false,
        errorCode: 'QUOTA_SERVICE_UNAVAILABLE',
        message: 'Quota service unavailable',
        retryAfter: 30,
        requestId,
        timestamp: new Date().toISOString(),
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getUserQuotaUsage(userId) {
  const monthKey = currentMonthKey();

  try {
    const { data, error } = await supabase
      .from('user_quota')
      .select('feature, count')
      .eq('user_id', userId)
      .eq('month_key', monthKey);

    if (error) throw error;

    return (data || []).reduce((acc, r) => {
      acc[r.feature] = r.count;
      return acc;
    }, {});
  } catch (err) {
    logger.error('[Quota] Fetch failed', { userId, error: err.message });
    return {};
  }
}

async function getRemainingQuota(userId, tierRaw) {
  const tier = normalizeTier(tierRaw);

  const limit = getQuotaLimit(tier, 'default');
  if (limit === null) return null;

  const usage = await getUserQuotaUsage(userId);
  const conf = TIER_MONTHLY_QUOTAS[tier] ?? TIER_MONTHLY_QUOTAS.free;

  const result = {};

  for (const [feat, max] of Object.entries(conf)) {
    if (feat === 'default' || max === null) continue;
    result[feat] = Math.max(0, max - (usage[feat] ?? 0));
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  tierQuota,
  getUserQuotaUsage,
  getRemainingQuota,
  TIER_MONTHLY_QUOTAS,
};