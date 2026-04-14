'use strict';

/**
 * @file src/services/paymentActivation.service.js
 * @description
 * Patch 44 hardened billing activation service.
 *
 * Guarantees:
 * - exact-once activation per subscription
 * - deterministic payment log authority
 * - retry-safe webhook replay
 * - downgrade replay safety
 */

const { supabase } = require('../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const {
  getCreditsForPlan,
} = require('../analysis/analysis.constants');
const {
  authoritativeUpsert,
} = require('../lib/db/authoritativeMutation');

const USERS_TABLE = 'users';
const PAYMENT_LOGS_TABLE = 'payment_logs';

async function hasActivationAlreadyProcessed(subscriptionId) {
  const { data, error } = await supabase
    .from(PAYMENT_LOGS_TABLE)
    .select('id')
    .eq('subscription_id', subscriptionId)
    .eq('status', 'activated')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new AppError(
      error.message,
      500,
      { subscriptionId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return Boolean(data);
}

async function activateProUser({
  userId,
  planAmount,
  subscriptionId,
  provider,
}) {
  if (!userId || !planAmount || !subscriptionId || !provider) {
    throw new AppError(
      'Missing required activation parameters',
      400,
      { userId, planAmount, subscriptionId, provider },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const credits = getCreditsForPlan(planAmount);
  const now = new Date().toISOString();

  try {
    const alreadyProcessed =
      await hasActivationAlreadyProcessed(
        subscriptionId
      );

    if (alreadyProcessed) {
      logger.warn(
        '[PaymentActivation] Duplicate webhook ignored',
        {
          userId,
          subscriptionId,
        }
      );

      return {
        userId,
        alreadyActivated: true,
      };
    }

    const { data: existingUser, error: userError } =
      await supabase
        .from(USERS_TABLE)
        .select('id, tier')
        .eq('id', userId)
        .maybeSingle();

    if (userError) throw userError;

    if (!existingUser) {
      throw new AppError(
        'User not found during activation',
        404,
        { userId },
        ErrorCodes.NOT_FOUND
      );
    }

    const { error: updateError } = await supabase
      .from(USERS_TABLE)
      .update({
        tier: 'pro',
        plan_amount: planAmount,
        ai_credits_remaining: credits,
        report_unlocked: true,
        subscription_id: subscriptionId,
        subscription_provider: provider,
        subscription_status: 'active',
        subscription_start: now,
        subscription_end: null,
        updated_at: now,
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    await authoritativeUpsert({
      table: PAYMENT_LOGS_TABLE,
      payload: {
        subscription_id: subscriptionId,
        user_id: userId,
        provider,
        amount: planAmount,
        credits_granted: credits,
        status: 'activated',
        created_at: now,
      },
      conflictKey: 'subscription_id',
      requestKey: subscriptionId,
    });

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
  } catch (error) {
    logger.error('[PaymentActivation] Activation failed', {
      userId,
      error: error.message,
    });

    throw new AppError(
      error.message,
      500,
      { userId, subscriptionId },
      ErrorCodes.INTERNAL_ERROR
    );
  }
}

async function downgradeUser(userId) {
  if (!userId) {
    throw new AppError(
      'Missing userId for downgrade',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const now = new Date().toISOString();

  try {
    const { data: existingUser, error: fetchError } =
      await supabase
        .from(USERS_TABLE)
        .select('id, tier')
        .eq('id', userId)
        .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existingUser) return;

    if (existingUser.tier === 'free') {
      logger.info(
        '[PaymentActivation] Already free, downgrade skipped',
        { userId }
      );
      return;
    }

    const { error: updateError } = await supabase
      .from(USERS_TABLE)
      .update({
        tier: 'free',
        plan_amount: null,
        ai_credits_remaining: 0,
        report_unlocked: false,
        subscription_status: 'cancelled',
        subscription_end: now,
        subscription_id: null,
        subscription_provider: null,
        updated_at: now,
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    await authoritativeUpsert({
      table: PAYMENT_LOGS_TABLE,
      payload: {
        subscription_id: `downgrade:${userId}:${now}`,
        user_id: userId,
        status: 'downgraded',
        created_at: now,
      },
      conflictKey: 'subscription_id',
      requestKey: userId,
    });

    logger.info('[PaymentActivation] User downgraded', {
      userId,
    });
  } catch (error) {
    logger.error('[PaymentActivation] Downgrade failed', {
      userId,
      error: error.message,
    });

    throw new AppError(
      error.message,
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