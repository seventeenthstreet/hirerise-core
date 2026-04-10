'use strict';

/**
 * src/middleware/tierQuota.middleware.js
 *
 * Wave 1 hardened quota enforcement middleware
 */

const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('./errorHandler');
const { normalizeTier } = require('./requireTier.middleware');
const logger = require('../utils/logger');

const TIER_MONTHLY_QUOTAS = Object.freeze({
  free: {
    fullAnalysis: 3,
    generateCV: 1,
    jobMatchAnalysis: 5,
    jobSpecificCV: 1,
    careerReport: 1,
    salaryBenchmark: 10,
    default: 10,
  },
  pro: { default: null },
  enterprise: { default: null },
  premium: { default: null },
});

const QUOTA_DOC_TTL_DAYS = 60;

function getRequestId(req) {
  return (
    req.correlationId ||
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    null
  );
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, '0')}`;
}

function getQuotaLimit(tier, feature) {
  const conf = TIER_MONTHLY_QUOTAS[tier] ?? TIER_MONTHLY_QUOTAS.free;
  return feature in conf ? conf[feature] : conf.default ?? 10;
}

function ttlISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Drift-safe quota increment RPC
 */
async function incrementQuotaUsage({
  userId,
  monthKey,
  feature,
  increment = 1,
}) {
  const { data, error } = await supabase.rpc('increment_user_quota', {
    p_user_id: userId,
    p_month_key: monthKey,
    p_feature: feature,
    p_increment: increment,
    p_expires_at: ttlISO(QUOTA_DOC_TTL_DAYS),
  });

  if (error) {
    error.context = {
      rpc: 'increment_user_quota',
      userId,
      monthKey,
      feature,
    };
    throw error;
  }

  return data;
}

function tierQuota(feature) {
  return async function tierQuotaMiddleware(req, res, next) {
    const requestId = getRequestId(req);
    const userId = req.user?.uid;
    const tier = normalizeTier(req.user?.plan);

    if (!userId) {
      return next(
        new AppError(
          'Authentication required',
          401,
          {},
          ErrorCodes.UNAUTHORIZED
        )
      );
    }

    const limit = getQuotaLimit(tier, feature);

    if (limit === null) {
      return next();
    }

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

      const current = Number(data?.count ?? 0);

      if (current >= limit) {
        logger.warn('[Quota] Limit exceeded', {
          requestId,
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

      let incremented = false;

      res.once('finish', async () => {
        if (incremented) return;
        incremented = true;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            await incrementQuotaUsage({
              userId,
              monthKey,
              feature,
            });
          } catch (err) {
            logger.error('[Quota] Increment RPC failed', {
              requestId,
              userId,
              feature,
              error: err.message,
              code: err.code,
              details: err.details,
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

async function getUserQuotaUsage(userId) {
  const monthKey = currentMonthKey();

  try {
    const { data, error } = await supabase
      .from('user_quota')
      .select('feature, count')
      .eq('user_id', userId)
      .eq('month_key', monthKey);

    if (error) throw error;

    return (data || []).reduce((acc, row) => {
      acc[row.feature] = Number(row.count ?? 0);
      return acc;
    }, {});
  } catch (err) {
    logger.error('[Quota] Fetch failed', {
      userId,
      error: err.message,
    });
    return {};
  }
}

async function getRemainingQuota(userId, tierRaw) {
  const tier = normalizeTier(tierRaw);
  const limit = getQuotaLimit(tier, 'default');

  if (limit === null) {
    return null;
  }

  const usage = await getUserQuotaUsage(userId);
  const conf = TIER_MONTHLY_QUOTAS[tier] ?? TIER_MONTHLY_QUOTAS.free;

  const result = {};

  for (const [feature, max] of Object.entries(conf)) {
    if (feature === 'default' || max == null) continue;
    result[feature] = Math.max(0, max - (usage[feature] ?? 0));
  }

  return result;
}

module.exports = {
  tierQuota,
  getUserQuotaUsage,
  getRemainingQuota,
  TIER_MONTHLY_QUOTAS,
};