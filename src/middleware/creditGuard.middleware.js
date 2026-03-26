'use strict';

/**
 * creditGuard.middleware.js — Atomic Credit Reservation
 *
 * MIGRATION: Removed require('../config/supabase') and the FieldValue import
 * from supabase. All Supabase access now goes through config/supabase.
 *
 * Changes:
 *   loadBalance() cold path:
 *     OLD: db.collection('users').doc(userId).get() → doc.data().aiCreditsRemaining
 *     NEW: supabase.from('users').select('ai_credits_remaining').eq('id', userId).maybeSingle()
 *
 *   syncDeductionToFirestore() (now syncDeductionToDb()):
 *     OLD: db.collection('users').doc(userId).update({
 *            aiCreditsRemaining: FieldValue.increment(-cost),
 *            lastCreditDeductionAt: new Date()
 *          })
 *     NEW: supabase.from('users').update({
 *            ai_credits_remaining: supabase.rpc('decrement', { x: cost }),  ← via RPC
 *            last_credit_deduction_at: new Date().toISOString()
 *          }).eq('id', userId)
 *
 *     NOTE: Postgres doesn't support inline arithmetic in .update() via the
 *     PostgREST JS client directly. Use a lightweight SQL function:
 *
 *       CREATE OR REPLACE FUNCTION decrement_credits(user_id uuid, cost int)
 *       RETURNS void LANGUAGE sql AS $$
 *         UPDATE users
 *         SET ai_credits_remaining = GREATEST(0, ai_credits_remaining - cost),
 *             last_credit_deduction_at = NOW()
 *         WHERE id = user_id;
 *       $$;
 *
 *     Called here as: supabase.rpc('decrement_credits', { user_id: userId, cost })
 *
 * Schema note:
 *   aiCreditsRemaining    → ai_credits_remaining
 *   lastCreditDeductionAt → last_credit_deduction_at
 */

const supabase                          = require('../config/supabase');
const { AppError, ErrorCodes }          = require('./errorHandler');
const { CREDIT_COSTS, isValidOperation } = require('../modules/analysis/analysis.constants');
const { normalizeTier }                 = require('./requireTier.middleware');
const logger                            = require('../utils/logger');

// Lazy-load Redis to avoid circular deps at module init
let _redisClient = null;
function getRedis() {
  if (!_redisClient) {
    try {
      const cacheManager = require('../core/cache/cache.manager');
      const client = cacheManager.getClient();
      if (client && typeof client.multi === 'function') {
        _redisClient = client;
      }
    } catch {
      // Redis not available — will use Supabase fallback
    }
  }
  return _redisClient;
}

const CREDIT_KEY_PREFIX = 'credit:balance:';
const CREDIT_CACHE_TTL  = 300; // 5 minutes

/**
 * Load credit balance: Redis first, Supabase fallback.
 * Returns { balance, source } or null if user not found.
 */
async function loadBalance(userId) {
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(`${CREDIT_KEY_PREFIX}${userId}`);
      if (cached !== null) {
        return { balance: parseInt(cached, 10), source: 'redis' };
      }
    } catch (err) {
      logger.warn('[CreditGuard] Redis GET failed, falling back to Supabase', {
        userId, err: err.message,
      });
    }
  }

  // Supabase cold path
  const { data, error } = await supabase
    .from('users')
    .select('ai_credits_remaining')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[CreditGuard] Supabase balance lookup failed', { userId, error: error.message });
    return null;
  }
  if (!data) return null;

  const balance = data.ai_credits_remaining ?? 0;

  // Warm the Redis cache
  if (redis) {
    try {
      await redis.set(`${CREDIT_KEY_PREFIX}${userId}`, String(balance), 'EX', CREDIT_CACHE_TTL);
    } catch { /* non-fatal */ }
  }

  return { balance, source: 'supabase' };
}

/**
 * Atomically reserve credits using Redis MULTI/EXEC.
 * Returns { reserved: boolean, balanceBefore: number } or null if Redis unavailable.
 */
async function atomicReserve(userId, cost) {
  const redis = getRedis();
  if (!redis || typeof redis.watch !== 'function') return null;

  const key = `${CREDIT_KEY_PREFIX}${userId}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await redis.watch(key);

      const currentStr = await redis.get(key);
      const current = currentStr !== null ? parseInt(currentStr, 10) : null;

      if (current === null) {
        await redis.unwatch();
        return null; // Cache miss — fall back to Supabase path
      }

      if (current < cost) {
        await redis.unwatch();
        return { reserved: false, balanceBefore: current };
      }

      const pipeline = redis.multi();
      pipeline.get(key);
      pipeline.decrby(key, cost);
      pipeline.expire(key, CREDIT_CACHE_TTL);

      const result = await pipeline.exec();

      if (result === null) continue; // WATCH triggered, retry

      const [getResult, decrResult] = result;
      const balanceBefore = parseInt(getResult[1], 10);

      if (decrResult[1] < 0) {
        await redis.incrby(key, cost);
        return { reserved: false, balanceBefore };
      }

      return { reserved: true, balanceBefore };

    } catch (err) {
      logger.warn('[CreditGuard] Redis MULTI/EXEC failed', { userId, err: err.message, attempt });
      try { await redis.unwatch(); } catch { /* ignore */ }
    }
  }

  return null; // Redis failed — fall back to Supabase
}

/**
 * Restore credits reserved by atomicReserve (call on AI operation failure).
 */
async function releaseCreditReservation(userId, cost) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.incrby(`${CREDIT_KEY_PREFIX}${userId}`, cost);
    logger.info('[CreditGuard] Credits released back to balance', { userId, cost });
  } catch (err) {
    logger.error('[CreditGuard] Failed to release credits in Redis', {
      userId, cost, err: err.message,
    });
  }
}

/**
 * Sync a credit deduction to Supabase (fire-and-forget).
 * The Redis reservation already deducted — this keeps Supabase in sync.
 *
 * Requires the following Postgres function to exist:
 *   CREATE OR REPLACE FUNCTION decrement_credits(user_id uuid, cost int)
 *   RETURNS void LANGUAGE sql AS $$
 *     UPDATE users
 *     SET ai_credits_remaining = GREATEST(0, ai_credits_remaining - cost),
 *         last_credit_deduction_at = NOW()
 *     WHERE id = user_id;
 *   $$;
 */
async function syncDeductionToDb(userId, cost) {
  try {
    const { error } = await supabase.rpc('decrement_credits', {
      user_id: userId,
      cost,
    });
    if (error) throw error;
  } catch (err) {
    logger.error('[CreditGuard] Supabase credit sync failed — Redis and DB may be out of sync', {
      userId, cost, err: err.message,
    });
    // Non-fatal: Redis is source of truth until next cold load.
  }
}

// ─── Exported helpers for service layer ───────────────────────────────────────

async function confirmCreditReservation(req) {
  if (!req._creditReservation) return;
  const { userId, cost, source } = req._creditReservation;

  if (source === 'redis') {
    setImmediate(() => syncDeductionToDb(userId, cost));
  }
}

async function releaseCreditReservationFromReq(req) {
  if (!req._creditReservation) return;
  const { userId, cost, source } = req._creditReservation;
  if (source === 'redis') {
    await releaseCreditReservation(userId, cost);
  }
}

// ─── Main middleware factory ───────────────────────────────────────────────────

function creditGuard(operationType) {
  return async function (req, res, next) {
    try {
      const userId = req.user?.uid;
      if (!userId) {
        return next(new AppError('Unauthorized', 401, {}, ErrorCodes.UNAUTHORIZED));
      }

      if (!isValidOperation(operationType)) {
        return next(new AppError(`Unknown operation: ${operationType}`, 400, {}, ErrorCodes.VALIDATION_ERROR));
      }

      const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);

      // Free users bypass credit check entirely
      if (tier === 'free') return next();

      const cost = CREDIT_COSTS[operationType];

      // ── Phase 1: Atomic Redis reservation path ──────────────────────────
      const redisResult = await atomicReserve(userId, cost);

      if (redisResult !== null) {
        if (!redisResult.reserved) {
          return next(new AppError(
            'Insufficient AI credits. Please purchase a new plan to continue.',
            402,
            { creditsRequired: cost, creditsAvailable: redisResult.balanceBefore, operationType },
            ErrorCodes.PAYMENT_REQUIRED
          ));
        }

        req._creditReservation = { userId, cost, source: 'redis' };
        req.creditCost         = cost;
        req.creditsAvailable   = redisResult.balanceBefore;

        logger.debug('[CreditGuard] Credits atomically reserved via Redis', {
          userId, cost, balanceBefore: redisResult.balanceBefore,
        });

        return next();
      }

      // ── Fallback: Supabase path (Redis unavailable or cache miss) ───────
      logger.warn('[CreditGuard] Redis unavailable — using Supabase fallback', { userId });

      const balanceResult = await loadBalance(userId);
      if (!balanceResult) {
        return next(new AppError('User not found', 404, {}, ErrorCodes.NOT_FOUND));
      }

      if (balanceResult.balance < cost) {
        return next(new AppError(
          'Insufficient AI credits. Please purchase a new plan to continue.',
          402,
          { creditsRequired: cost, creditsAvailable: balanceResult.balance, operationType },
          ErrorCodes.PAYMENT_REQUIRED
        ));
      }

      req._creditReservation = { userId, cost, source: 'supabase' };
      req.creditCost         = cost;
      req.creditsAvailable   = balanceResult.balance;

      return next();

    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  creditGuard,
  confirmCreditReservation,
  releaseCreditReservationFromReq,
  // Export for testing
  _atomicReserve:              atomicReserve,
  _releaseCreditReservation:   releaseCreditReservation,
  _syncDeductionToDb:          syncDeductionToDb,
};








