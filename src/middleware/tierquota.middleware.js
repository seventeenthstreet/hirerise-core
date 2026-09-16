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
  // PAYG Entitlement Architecture audit — `elite` was previously absent
  // from this table entirely, causing `TIER_MONTHLY_QUOTAS['elite'] ??
  // TIER_MONTHLY_QUOTAS.free` to silently fall back to the FREE tier's
  // numeric caps (fullAnalysis: 3/mo, generateCV: 1/mo, etc.) for a tier
  // that is DB-enforced as paid (`users_tier_check` allows only
  // 'free'/'pro'/'elite' — 'elite' is one of only three canonical,
  // DB-level-valid values for users.tier) and treated as paid everywhere
  // else in the codebase (requireTier.middleware.js's KNOWN_TIERS,
  // requirePaidPlan.middleware.js's PAID_TIERS).
  //
  // A prior, narrower audit of this specific gap concluded "BLOCKED",
  // because aiRateLimitByPlan (100/day), aiCostGuard ($10/day), and
  // aiUsage.service.js's separate "System A" (500/month) each give
  // `elite` a different, system-specific finite number with no consistent
  // cross-system value to borrow — inferring `null` purely from "elite is
  // a paid tier" would have been unsupported.
  //
  // The subsequent PAYG Entitlement Architecture audit found the missing
  // piece: creditGuard.middleware.js — the actual monetization
  // enforcement for paid usage — treats every non-free tier identically
  // (`if (tier === 'free') return next();`; every other tier, including
  // elite, is charged per-operation from its credit balance with no
  // per-tier branching at all). Under the now-explicit PAYG product
  // direction ("pay per use", not "N per calendar month"), a per-feature
  // monthly counter is not a meaningful control for ANY tier that already
  // pays per operation via credits — and the officially locked Usage/
  // Credits contract already documents this table (System B) as
  // "currently only meaningfully limiting the free tier". `pro` and
  // `enterprise` already reflect exactly this — `default: null` — in this
  // very table. This entry brings `elite` in line with its sibling paying
  // tiers here, closing the config gap rather than inventing a new value:
  // it reuses the identical `null` sentinel already established for pro/
  // enterprise, changes nothing about credits, billing, rate limiting, or
  // AI cost protection (all of which remain the actual, unmodified
  // enforcement for elite users), and only removes an accidental
  // free-tier-equivalent cap that never reflected any real intent.
  elite: { default: null },
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
  if (feature in conf) {
    return conf[feature];
  }

  // AUDIT FIX (Tier Quota Fallback Semantics pass): `default` is always an
  // explicit configuration value in every currently-defined tier — an
  // explicit `null` here is this codebase's established "unmetered"
  // convention, not a signal to fall back to a numeric default. Evidence:
  //   - the two other null-checks in this same file both treat
  //     limit === null as "no quota enforcement" (tierQuotaMiddleware's
  //     early `return next()`, and getRemainingQuota's early `return null`);
  //   - analysis.constants.js's getRemainingUses() docs/tests describe
  //     this exact "TIER_MONTHLY_QUOTAS's default: null" value as the
  //     codebase's existing unmetered convention;
  //   - aiRateLimitByPlan.middleware.js uses the identical convention for
  //     the sibling per-plan AI rate limit (`enterprise: null, // unlimited`).
  //
  // Previously this was `conf.default ?? 10`, which — because `??` treats
  // an explicit `null` the same as a missing value — silently converted
  // pro/enterprise/premium's deliberate `default: null` (unmetered) into a
  // hard 10/month cap for every feature not given its own explicit
  // override in that tier (i.e. every feature today, since none of those
  // three tiers list any explicit per-feature overrides). `'default' in
  // conf` distinguishes "explicitly configured as null" from "never
  // configured at all" — only the latter still falls back to the
  // conservative default of 10. Every currently-defined tier explicitly
  // sets `default`, so that fallback path is a defensive guard against a
  // future malformed tier config, not a change in behavior today.
  return 'default' in conf ? conf.default : 10;
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
          error: {
            code: 'TIER_INSUFFICIENT',
            message: 'Monthly quota exhausted.',
            details: {
              feature,
              limit,
              used: current,
              quotaExhausted: true,
              upgradeUrl: process.env.UPGRADE_URL ?? '/pricing',
            },
          },
          meta: {
            requestId,
            timestamp: new Date().toISOString(),
            retryAfter: 0,
          },
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
        error: {
          code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
          message: 'Quota service unavailable. Please retry shortly.',
        },
        meta: {
          requestId,
          timestamp: new Date().toISOString(),
          retryAfter: 30,
        },
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