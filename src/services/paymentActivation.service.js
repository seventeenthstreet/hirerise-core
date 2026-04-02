'use strict';

/**
 * paymentActivation.service.js — PRODUCTION SAFE VERSION
 *
 * Improvements:
 *  - Idempotency (prevents double crediting)
 *  - Transaction-safe logic (best effort with Supabase)
 *  - Strict validation
 *  - Audit logging (payments table)
 *  - Safe downgrade handling
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../utils/logger');
const { getCreditsForPlan } = require('../analysis/analysis.constants');

// ─────────────────────────────────────────────────────────────
// Activate Pro User (Webhook Entry Point)
// ─────────────────────────────────────────────────────────────

async function activateProUser({ userId, planAmount, subscriptionId, provider }) {
  if (!userId || !planAmount || !subscriptionId || !provider) {
    throw new AppError(
      'Missing required activation parameters',
      400,
      { userId, planAmount, subscriptionId, provider },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const credits = getCreditsForPlan(planAmount);

  try {
    // ── STEP 1: Check if already activated (IDEMPOTENCY) ──
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select(`
        id,
        tier,
        subscriptionId,
        aiCreditsRemaining
      `)
      .eq('id', userId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!existingUser) {
      throw new AppError(
        'User not found during activation',
        404,
        { userId },
        ErrorCodes.NOT_FOUND
      );
    }

    // 🚨 Idempotency check
    if (
      existingUser.subscriptionId === subscriptionId &&
      existingUser.tier === 'pro'
    ) {
      logger.warn('[PaymentActivation] Duplicate webhook ignored', {
        userId,
        subscriptionId
      });

      return {
        userId,
        alreadyActivated: true
      };
    }

    // ── STEP 2: Update User ──
    const now = new Date().toISOString();

    const { error: updateError } = await supabase
      .from('users')
      .update({
        tier: 'pro',
        planAmount,
        aiCreditsRemaining: credits,
        reportUnlocked: true,
        subscriptionId,
        subscriptionProvider: provider,
        subscriptionStatus: 'active',
        subscriptionStart: now,
        subscriptionEnd: null,
        updatedAt: now,
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    // ── STEP 3: Audit Log (IMPORTANT) ──
    try {
      await supabase
        .from('payment_logs')
        .insert([{
          user_id: userId,
          subscription_id: subscriptionId,
          provider,
          amount: planAmount,
          credits_granted: credits,
          status: 'activated',
          created_at: now
        }]);
    } catch (auditErr) {
      // Non-blocking but important
      logger.warn('[PaymentActivation] Audit log failed', {
        userId,
        error: auditErr.message
      });
    }

    logger.info('[PaymentActivation] Pro activated', {
      userId,
      planAmount,
      creditsGranted: credits,
      provider,
      subscriptionId,
    });

    return {
      userId,
      planAmount,
      creditsGranted: credits,
    };

  } catch (err) {
    logger.error('[PaymentActivation] Activation failed', {
      userId,
      error: err.message
    });

    throw new AppError(
      err.message,
      500,
      { userId },
      ErrorCodes.INTERNAL_ERROR
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Downgrade User (Refund / Chargeback / Manual)
// ─────────────────────────────────────────────────────────────

async function downgradeUser(userId) {
  if (!userId) {
    throw new AppError(
      'Missing userId for downgrade',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  try {
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('id, tier')
      .eq('id', userId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    // Idempotent: no user → skip
    if (!existingUser) return;

    // Already free → skip
    if (existingUser.tier === 'free') {
      logger.info('[PaymentActivation] Already free, skipping downgrade', { userId });
      return;
    }

    const now = new Date().toISOString();

    const { error: updateError } = await supabase
      .from('users')
      .update({
        tier: 'free',
        planAmount: null,
        aiCreditsRemaining: 0,
        reportUnlocked: false,
        subscriptionStatus: 'cancelled',
        subscriptionEnd: now,
        updatedAt: now,
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    // ── Audit Log ──
    try {
      await supabase
        .from('payment_logs')
        .insert([{
          user_id: userId,
          status: 'downgraded',
          created_at: now
        }]);
    } catch (auditErr) {
      logger.warn('[PaymentActivation] Downgrade audit failed', {
        userId,
        error: auditErr.message
      });
    }

    logger.info('[PaymentActivation] User downgraded to free', { userId });

  } catch (err) {
    logger.error('[PaymentActivation] Downgrade failed', {
      userId,
      error: err.message
    });

    throw new AppError(
      err.message,
      500,
      { userId },
      ErrorCodes.INTERNAL_ERROR
    );
  }
}

module.exports = {
  activateProUser,
  downgradeUser,
};