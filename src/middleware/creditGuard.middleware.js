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
 * Normalize RPC result shape across:
 * - object row
 * - array row
 * - nullable payloads
 */
function normalizeCreditRpcResult(data) {
  if (!data) {
    return {
      success: false,
      remaining: 0,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;

  return {
    success: Boolean(
      row?.success ??
      row?.allowed ??
      row?.consumed
    ),
    remaining: Number(
      row?.remaining ??
      row?.remaining_credits ??
      row?.balance ??
      0
    ),
  };
}

/**
 * Atomic consume via SQL RPC
 */
async function checkAndDeductCredits(userId, cost) {
  const normalizedCost = Number(cost);

  if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) {
    throw new Error(`Invalid credit cost: ${cost}`);
  }

  const { data, error } = await supabase.rpc('consume_ai_credits', {
    p_user_id: userId,
    p_cost: Math.trunc(normalizedCost),
  });

  if (error) {
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

      const result = await checkAndDeductCredits(userId, cost);

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