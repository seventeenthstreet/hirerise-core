'use strict';

/**
 * aiCostGuard.middleware.js
 *
 * Per-user AI cost enforcement — hard daily budget cutoff.
 *
 * WHY:
 *   Credit counts (aiCreditsRemaining) control how many operations a user
 *   can run per billing cycle. But they don't protect against a single user
 *   running extremely token-heavy calls that cost $5+ in one day while only
 *   consuming 1 credit. Cost monitoring needs a second, independent gate.
 *
 * WHAT IT DOES:
 *   Checks the user's AI spend today against PER_USER_DAILY_LIMIT_USD.
 *   If the limit is exceeded, the request is blocked with 429.
 *   The daily cost is tracked in Redis (key: ai:cost:daily:{userId}:{YYYY-MM-DD}).
 *   After every successful AI call, recordAiCost() updates the counter.
 *
 * WHAT IT DOES NOT DO:
 *   - Does not replace creditGuard (credits are still deducted as normal)
 *   - Does not block free users from running their 5 free calls
 *   - Does not track cross-month spend (cost tracker in Firestore handles that)
 *
 * LIMITS:
 *   free:       $0.10/day  (AI_COST_LIMIT_FREE_USD)
 *   pro:        $2.00/day  (AI_COST_LIMIT_PRO_USD)
 *   elite:      $10.00/day (AI_COST_LIMIT_ELITE_USD)
 *   enterprise: $10.00/day (AI_COST_LIMIT_ENTERPRISE_USD)
 *
 * GRACEFUL DEGRADATION:
 *   If Redis is unavailable, the guard fails OPEN (allows the request).
 *   This is intentional — a Redis outage should not block paying users.
 *   The Firestore cost tracker still records the spend for post-hoc review.
 *
 * USAGE in routes:
 *   const { aiCostGuard, recordAiCost } = require('../../middleware/aiCostGuard.middleware');
 *
 *   // In route stack (after authenticate, before creditGuard):
 *   router.post('/', authenticate, aiCostGuard, creditGuard(...), handler);
 *
 *   // After successful AI call (fire-and-forget):
 *   recordAiCost(userId, tier, estimatedCostUSD).catch(() => {});
 *
 * @module middleware/aiCostGuard.middleware
 */

const logger = require('../utils/logger');

// ─── Daily limits per tier (USD) ──────────────────────────────────────────────

const DAILY_LIMITS_USD = {
  free:       parseFloat(process.env.AI_COST_LIMIT_FREE_USD       || '0.10'),
  pro:        parseFloat(process.env.AI_COST_LIMIT_PRO_USD        || '2.00'),
  elite:      parseFloat(process.env.AI_COST_LIMIT_ELITE_USD      || '10.00'),
  enterprise: parseFloat(process.env.AI_COST_LIMIT_ENTERPRISE_USD || '10.00'),
};

const DEFAULT_LIMIT_USD = DAILY_LIMITS_USD.free;

// Redis key TTL — slightly over 24h to account for timezone drift
const KEY_TTL_S = 25 * 3600;

// ─── Redis client ──────────────────────────────────────────────────────────────

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try {
    const mgr = require('../core/cache/cache.manager');
    const client = mgr.getClient();
    if (client?.client?.get) _redis = client.client;
  } catch { /* Redis unavailable */ }
  return _redis;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC
}

function costKey(userId) {
  return `ai:cost:daily:${userId}:${todayStr()}`;
}

function limitForTier(tier) {
  const t = String(tier || 'free').toLowerCase();
  return DAILY_LIMITS_USD[t] ?? DEFAULT_LIMIT_USD;
}

// ─── Core operations ───────────────────────────────────────────────────────────

/**
 * getDailySpend(userId)
 *
 * Returns the user's total AI spend today in USD.
 * Returns 0 if Redis is unavailable or key doesn't exist.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getDailySpend(userId) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const raw = await redis.get(costKey(userId));
    return raw ? parseFloat(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * recordAiCost(userId, tier, costUSD)
 *
 * Atomically increments the user's daily AI spend counter.
 * Call this AFTER a successful AI call, fire-and-forget.
 *
 * @param {string} userId
 * @param {string} tier
 * @param {number} costUSD
 */
async function recordAiCost(userId, tier, costUSD) {
  if (!costUSD || costUSD <= 0) return;
  const redis = getRedis();
  if (!redis) return;

  try {
    const key = costKey(userId);
    // INCRBYFLOAT is atomic in Redis
    await redis.incrbyfloat(key, costUSD);
    // Refresh TTL on every write — key expires at end of day window
    await redis.expire(key, KEY_TTL_S);

    logger.debug('[AICostGuard] Recorded AI cost', { userId, costUSD, tier });
  } catch (err) {
    logger.warn('[AICostGuard] Failed to record AI cost', { userId, costUSD, error: err.message });
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

/**
 * aiCostGuard(req, res, next)
 *
 * Express middleware. Checks daily spend against tier limit.
 * Blocks with 429 if over limit; passes through if under or Redis unavailable.
 *
 * Requires: authenticate middleware to have set req.user
 */
async function aiCostGuard(req, res, next) {
  const userId = req.user?.uid;
  if (!userId) {
    // authenticate must run first
    logger.error('[AICostGuard] req.user missing — authenticate must run before aiCostGuard');
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  const redis = getRedis();
  if (!redis) {
    // Fail open — Redis unavailable, don't block paying users
    logger.debug('[AICostGuard] Redis unavailable — failing open');
    return next();
  }

  try {
    const tier  = req.user.normalizedTier || req.user.plan || 'free';
    const limit = limitForTier(tier);
    const spent = await getDailySpend(userId);

    if (spent >= limit) {
      logger.warn('[AICostGuard] Daily AI cost limit reached', {
        userId, tier, spent: spent.toFixed(4), limit,
      });
      return res.status(429).json({
        success: false,
        error: {
          code:    'DAILY_AI_COST_LIMIT_EXCEEDED',
          message: `Daily AI usage limit reached. Your limit resets at midnight UTC.`,
        },
        detail: {
          dailySpentUSD:  +spent.toFixed(4),
          dailyLimitUSD:  limit,
          resetsAt:       `${todayStr()}T23:59:59Z`,
        },
      });
    }

    // Attach limit context to req for post-call cost recording
    req._aiCostContext = { userId, tier, limit, spent };
    return next();

  } catch (err) {
    // Fail open on unexpected error — never block AI calls due to cost guard failure
    logger.error('[AICostGuard] Unexpected error — failing open', { userId, error: err.message });
    return next();
  }
}

/**
 * aiCostGuardFactory({ tierOverride })
 *
 * Factory version for routes where tier is determined differently.
 * tierOverride: static string to use instead of req.user.normalizedTier
 */
function aiCostGuardFactory({ tierOverride } = {}) {
  return async function aiCostGuardCustom(req, res, next) {
    if (tierOverride) {
      if (req.user) req.user._tierForCostGuard = tierOverride;
    }
    return aiCostGuard(req, res, next);
  };
}

module.exports = {
  aiCostGuard,
  aiCostGuardFactory,
  recordAiCost,
  getDailySpend,
  limitForTier,
  DAILY_LIMITS_USD,
};








