'use strict';

/**
 * src/middleware/creditGuard.middleware.js
 *
 * Wave 1 hardened RPC drift-safe AI credit guard
 */

const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('./errorHandler');
const {
  CREDIT_COSTS,
  isValidOperation,
} = require('../modules/analysis/analysis.constants');
const { normalizeTier } = require('./requireTier.middleware');
const logger = require('../utils/logger');

/**
 * Normalize the consume_ai_credits() return contract.
 *
 * Phase 4A defect fix: consume_ai_credits (see
 * supabase/migrations/000_initial_schema.sql and
 * 20260831000001_phase4_usage_credits_ledger.sql) is declared
 * `RETURNS integer` and, on every success path, does exactly one thing:
 * `RETURN v_remaining;` — a bare scalar. It has never returned an object
 * shaped `{ success, remaining, allowed, consumed, ... }`; that shape does
 * not exist anywhere in this RPC's actual SQL definition. Every failure
 * mode (insufficient credits, invalid amount, user not found, any other
 * DB error) is signalled exclusively via a raised exception — i.e. via
 * Supabase's `error`, not via a false-y field inside a successful `data`
 * payload — and checkAndDeductCredits() below only ever calls this
 * function once `error` is confirmed falsy. So by construction, whenever
 * normalizeCreditRpcResult() runs, the consumption has already
 * unconditionally succeeded, and `success` is therefore always `true`
 * here.
 *
 * OLD (broken) behavior: `if (!data) return { success: false, ... }`
 * followed by reading `row?.success` off of a bare number treated the
 * scalar as neither a number nor an object with a `success` field —
 * `row?.success` on a number is `undefined`, so `Boolean(undefined)` is
 * always `false`. Every real successful consumption (balance already
 * decremented, CONSUME ledger row already written by the RPC) was
 * therefore reported to the caller as `success: false`, and — because
 * the RPC returns `0` on a consumption that exactly exhausts the
 * balance — even the falsy-check on `data` itself (`!data`) additionally
 * mis-classified a legitimate "consumed down to exactly 0 remaining"
 * result as failure before ever reaching the object-shape logic.
 *
 * FIX: check `typeof data === 'number'` (and `typeof row === 'number'`
 * for the defensive array/object branches) rather than a truthiness or
 * `.success` check, so `0` is handled correctly and `success` reflects
 * reality: true whenever this function is reached at all.
 */
function normalizeCreditRpcResult(data) {
  if (typeof data === 'number') {
    return { success: true, remaining: data };
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row === 'number') {
    return { success: true, remaining: row };
  }

  if (row == null) {
    // Cannot happen with the current SQL contract (the success path
    // always `RETURN`s a value) — fail closed rather than silently
    // report a fabricated success for an unrecognized empty payload.
    return { success: false, remaining: 0 };
  }

  // Defensive fallback only, in case a future RPC revision wraps the
  // scalar in an object/row. Still success:true — we only ever reach
  // this function on the confirmed non-error path — reading `remaining`
  // from whichever field is present rather than assuming a `success`
  // flag this RPC has never actually returned.
  return {
    success: true,
    remaining: Number(
      row?.remaining ??
      row?.remaining_credits ??
      row?.balance ??
      0
    ),
  };
}

/**
 * Best-effort extraction of the "available=<n>" balance embedded in the
 * INSUFFICIENT_CREDITS exception message (see the RAISE EXCEPTION text in
 * consume_ai_credits). Returns null rather than a fabricated number if
 * the message doesn't match — this is a UX nicety for the 402 payload's
 * `creditsAvailable` field, not something anything downstream depends on
 * for correctness.
 */
function extractAvailableFromMessage(message) {
  const match = /available=(-?\d+)/.exec(String(message || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Atomic consume via SQL RPC
 */
async function checkAndDeductCredits(userId, cost, operationType) {
  const normalizedCost = Number(cost);

  if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) {
    throw new Error(`Invalid credit cost: ${cost}`);
  }

  const { data, error } = await supabase.rpc('consume_ai_credits', {
    p_user_id: userId,
    p_amount: Math.trunc(normalizedCost),
    p_source: operationType ?? null,
  });

  if (error) {
    const message = String(error.message || '');

    // consume_ai_credits signals insufficient balance / an invalid
    // amount via a raised exception (ERRCODE insufficient_resources /
    // invalid_parameter_value), not via a returned false-y payload —
    // these are business-logic outcomes, not infrastructure failures,
    // and must surface to the middleware as `{ success: false }` so its
    // existing `if (!result.success)` branch (402 "Insufficient AI
    // credits") is actually reachable, rather than propagating as a raw
    // error that falls through to the generic 500 handler below. This
    // mirrors the identical message-matching convention already used by
    // coverLetter.service.js and jobMatchPremium.service.js for this
    // same RPC.
    if (message.includes('INSUFFICIENT_CREDITS') || error.code === 'P0001') {
      return {
        success: false,
        remaining: extractAvailableFromMessage(message) ?? 0,
      };
    }

    if (message.includes('INVALID_AMOUNT')) {
      return { success: false, remaining: 0 };
    }

    // Any other RPC/database error remains a genuine infrastructure
    // failure — established error handling applies (propagate → outer
    // catch → 500), never silently converted into a successful
    // consumption or into a credits-based rejection.
    error.context = {
      rpc: 'consume_ai_credits',
      userId,
      cost: normalizedCost,
    };
    throw error;
  }

  return normalizeCreditRpcResult(data);
}

/**
 * Middleware factory
 */
function creditGuard(operationType) {
  return async function creditGuardMiddleware(req, res, next) {
    try {
      const userId = req.user?.uid;

      if (!userId) {
        return next(
          new AppError(
            'Unauthorized',
            401,
            {},
            ErrorCodes.UNAUTHORIZED
          )
        );
      }

      if (!isValidOperation(operationType)) {
        return next(
          new AppError(
            `Unknown operation: ${operationType}`,
            400,
            { operationType },
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);

      // free users bypass paid credit enforcement
      if (tier === 'free') {
        return next();
      }

      const rawCost = CREDIT_COSTS[operationType];
      const cost = Math.trunc(Number(rawCost));

      if (!Number.isFinite(cost) || cost <= 0) {
        logger.error('[CreditGuard] Invalid configured cost', {
          operationType,
          rawCost,
        });

        return next(
          new AppError(
            'Credit configuration invalid',
            500,
            { operationType },
            ErrorCodes.INTERNAL_SERVER_ERROR
          )
        );
      }

      const result = await checkAndDeductCredits(userId, cost, operationType);

      if (!result.success) {
        return next(
          new AppError(
            'Insufficient AI credits',
            402,
            {
              creditsRequired: cost,
              creditsAvailable: result.remaining,
              operationType,
            },
            ErrorCodes.PAYMENT_REQUIRED
          )
        );
      }

      // attach deterministic downstream metadata
      req.creditCost = cost;
      req.creditsRemaining = result.remaining;
      req.creditConsumption = {
        userId,
        operationType,
        consumed: cost,
        remaining: result.remaining,
      };

      return next();
    } catch (err) {
      logger.error('[CreditGuard] RPC consume_ai_credits failed', {
        error: err.message,
        code: err.code,
        details: err.details,
        userId: req.user?.uid,
        operationType,
      });

      return next(
        new AppError(
          'Credit validation failed',
          500,
          {
            operationType,
          },
          ErrorCodes.INTERNAL_SERVER_ERROR
        )
      );
    }
  };
}

/**
 * Compatibility no-op
 */
async function confirmCreditReservation() {
  return true;
}

/**
 * Compatibility no-op
 */
async function releaseCreditReservationFromReq() {
  return true;
}

module.exports = {
  creditGuard,
  confirmCreditReservation,
  releaseCreditReservationFromReq,
};