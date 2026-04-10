'use strict';

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const PLAN_CONFIG = Object.freeze({
  499: { tier: 'pro', credits: 16, currency: 'INR', durationDays: 30 },
  699: { tier: 'pro', credits: 23, currency: 'INR', durationDays: 30 },
  999: { tier: 'pro', credits: 33, currency: 'INR', durationDays: 30 },
  9: { tier: 'pro', credits: 20, currency: 'USD', durationDays: 30 },
  29: { tier: 'enterprise', credits: 100, currency: 'USD', durationDays: 30 },
});

const EXPIRE_BATCH_SIZE = 100;

function getPlanConfig(amount) {
  const config = PLAN_CONFIG[amount];

  if (!config) {
    throw new AppError(
      `Unknown plan amount: ${amount}`,
      400,
      { amount },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return config;
}

function buildSubscriptionEvent({
  userId,
  eventType,
  provider,
  externalEventId,
  planAmount,
  currency,
  creditsGranted,
  previousTier,
  newTier,
  metadata,
  idempotencyKey,
  nowISO,
}) {
  return {
    user_id: userId,
    event_type: eventType,
    provider,
    external_event_id: externalEventId,
    plan_amount: planAmount,
    plan_currency: currency,
    credits_granted: creditsGranted,
    previous_tier: previousTier,
    new_tier: newTier,
    metadata,
    idempotency_key: idempotencyKey,
    created_at: nowISO,
  };
}

async function isEventAlreadyProcessed(idempotencyKey) {
  const { data, error } = await supabase
    .from('subscription_events')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1);

  if (error) throw error;
  return Boolean(data?.length);
}

async function activateSubscription({
  userId,
  planAmount,
  subscriptionId,
  provider,
  externalEventId,
  currency = 'INR',
}) {
  const idempotencyKey = `activate:${subscriptionId}`;
  const plan = getPlanConfig(planAmount);

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + plan.durationDays);

  const { data: userRow, error: userFetchError } = await supabase
    .from('users')
    .select('tier')
    .eq('id', userId)
    .maybeSingle();

  if (userFetchError) throw userFetchError;

  const previousTier = userRow?.tier ?? 'free';

  const { data, error } = await supabase.rpc(
    'activate_subscription_tx',
    {
      p_user_id: userId,
      p_tier: plan.tier,
      p_plan_amount: planAmount,
      p_plan_currency: currency,
      p_credits: plan.credits,
      p_subscription_id: subscriptionId,
      p_provider: provider,
      p_external_event_id:
        externalEventId ?? subscriptionId,
      p_previous_tier: previousTier,
      p_idempotency_key: idempotencyKey,
      p_now: now.toISOString(),
      p_expires_at: expiresAt.toISOString(),
    }
  );

  if (error) {
    if (
      error.code === '23505' ||
      error.message?.includes('DUPLICATE_EVENT')
    ) {
      logger.info('[Billing] Duplicate activation skipped', {
        subscriptionId,
        idempotencyKey,
      });

      return { skipped: true, reason: 'duplicate' };
    }

    if (error.message?.includes('USER_NOT_FOUND')) {
      throw new AppError(
        `User not found during activation: ${userId}`,
        404,
        { userId },
        ErrorCodes.NOT_FOUND
      );
    }

    logger.error('[Billing] activate_subscription_tx failed', {
      error: error.message,
      userId,
      subscriptionId,
    });

    throw error;
  }

  const result = Array.isArray(data) ? data[0] : data;

  if (!result?.out_user_id) {
    throw new AppError(
      'Subscription activation returned invalid payload',
      500,
      { userId, subscriptionId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return {
    skipped: false,
    userId: result.out_user_id,
    tier: result.out_tier,
    creditsGranted: plan.credits,
    expiresAt: result.out_expires_at,
  };
}

async function cancelSubscription({
  userId,
  subscriptionId,
  provider,
  reason = 'cancelled',
  externalEventId,
}) {
  const idempotencyKey = `cancel:${subscriptionId}`;

  if (await isEventAlreadyProcessed(idempotencyKey)) {
    return { skipped: true };
  }

  const nowISO = new Date().toISOString();

  const { data: userRow, error } = await supabase
    .from('users')
    .select('tier, plan_amount, plan_currency')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;

  const previousTier = userRow?.tier ?? 'pro';

  const eventRow = buildSubscriptionEvent({
    userId,
    eventType:
      reason === 'refund' ? 'refunded' : 'cancelled',
    provider,
    externalEventId: externalEventId ?? subscriptionId,
    planAmount: userRow?.plan_amount ?? null,
    currency: userRow?.plan_currency ?? 'INR',
    creditsGranted: 0,
    previousTier,
    newTier: 'free',
    metadata: { subscriptionId, reason },
    idempotencyKey,
    nowISO,
  });

  const [userUpdate, subscriptionUpdate, eventInsert] =
    await Promise.all([
      supabase
        .from('users')
        .update({
          tier: 'free',
          subscription_status: 'cancelled',
          ai_credits_remaining: 0,
          updated_at: nowISO,
        })
        .eq('id', userId),

      supabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
          tier: 'free',
          cancelled_at: nowISO,
          updated_at: nowISO,
        })
        .eq('user_id', userId),

      supabase
        .from('subscription_events')
        .insert([eventRow]),
    ]);

  if (userUpdate.error) throw userUpdate.error;
  if (subscriptionUpdate.error) throw subscriptionUpdate.error;
  if (eventInsert.error) throw eventInsert.error;

  return { skipped: false, userId, newTier: 'free' };
}

async function refundSubscription(params) {
  return cancelSubscription({
    ...params,
    reason: 'refund',
  });
}

async function expireOverdueSubscriptions() {
  let processed = 0;
  let failed = 0;

  while (true) {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('subscriptions')
      .select('user_id, subscription_id, provider')
      .eq('status', 'active')
      .lte('expires_at', now)
      .limit(EXPIRE_BATCH_SIZE);

    if (error) throw error;
    if (!data?.length) break;

    const results = await Promise.allSettled(
      data.map((row) =>
        cancelSubscription({
          userId: row.user_id,
          subscriptionId:
            row.subscription_id ?? 'expired',
          provider: row.provider ?? 'system',
          reason: 'expired',
          externalEventId: `expiry:${row.user_id}`,
        })
      )
    );

    processed += results.filter(
      (r) => r.status === 'fulfilled'
    ).length;

    failed += results.filter(
      (r) => r.status === 'rejected'
    ).length;

    if (data.length < EXPIRE_BATCH_SIZE) break;
  }

  return { processed, failed };
}

async function getSubscriptionStatus(userId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select(
      'tier,status,plan_amount,plan_currency,provider,activated_at,expires_at,auto_renew,ai_credits_allocated,ai_credits_remaining'
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      userId,
      tier: 'free',
      status: 'inactive',
      credits: { allocated: 0, remaining: 0 },
    };
  }

  return {
    userId,
    tier: data.tier,
    status: data.status,
    planAmount: data.plan_amount,
    planCurrency: data.plan_currency,
    provider: data.provider,
    activatedAt: data.activated_at,
    expiresAt: data.expires_at,
    autoRenew: data.auto_renew,
    credits: {
      allocated: data.ai_credits_allocated,
      remaining: data.ai_credits_remaining,
    },
  };
}

module.exports = {
  activateSubscription,
  cancelSubscription,
  refundSubscription,
  expireOverdueSubscriptions,
  getSubscriptionStatus,
  PLAN_CONFIG,
};