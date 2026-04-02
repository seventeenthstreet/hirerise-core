'use strict';

/**
 * creditGuard.middleware.js (Supabase Production Version)
 */

const { supabase } = require('../config/supabase'); // ✅ REQUIRED
const { AppError, ErrorCodes } = require('./errorHandler');
const { CREDIT_COSTS, isValidOperation } = require('../modules/analysis/analysis.constants');
const { normalizeTier } = require('./requireTier.middleware');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// ATOMIC CREDIT CHECK + DEDUCT (RPC)
// ─────────────────────────────────────────────────────────────────────────────

async function checkAndDeductCredits(userId, cost) {
  const { data, error } = await supabase.rpc('consume_ai_credits', {
    p_user_id: userId,
    p_cost: cost,
  });

  if (error) throw error;

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

function creditGuard(operationType) {
  return async function (req, res, next) {
    try {
      const userId = req.user?.uid;

      if (!userId) {
        return next(new AppError(
          'Unauthorized',
          401,
          {},
          ErrorCodes.UNAUTHORIZED
        ));
      }

      if (!isValidOperation(operationType)) {
        return next(new AppError(
          `Unknown operation: ${operationType}`,
          400,
          {},
          ErrorCodes.VALIDATION_ERROR
        ));
      }

      const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);

      // Free users handled elsewhere
      if (tier === 'free') return next();

      const cost = CREDIT_COSTS[operationType];

      // 🔥 Atomic DB operation
      const result = await checkAndDeductCredits(userId, cost);

      if (!result?.success) {
        return next(new AppError(
          'Insufficient AI credits',
          402,
          {
            creditsRequired: cost,
            creditsAvailable: result?.remaining ?? 0,
            operationType,
          },
          ErrorCodes.PAYMENT_REQUIRED
        ));
      }

      // Attach metadata
      req.creditCost = cost;
      req.creditsRemaining = result.remaining;

      return next();

    } catch (err) {
      logger.error('[CreditGuard] Failed', {
        error: err.message,
        userId: req.user?.uid,
      });

      return next(new AppError(
        'Credit validation failed',
        500,
        {},
        ErrorCodes.INTERNAL_SERVER_ERROR
      ));
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NO-OP (for compatibility with your existing flow)
// ─────────────────────────────────────────────────────────────────────────────

async function confirmCreditReservation() {
  // No-op (handled atomically in DB)
}

async function releaseCreditReservationFromReq() {
  // No-op (no reservation system anymore)
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  creditGuard,
  confirmCreditReservation,
  releaseCreditReservationFromReq,
};