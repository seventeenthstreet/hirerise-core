'use strict';

/**
 * src/services/billing/Billing.service.js
 *
 * Patch 32: Final production-hardened billing runtime
 * - SQL tier authority
 * - deterministic expiry batching
 * - strict RPC validation
 * - legacy DTO drift removed
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const TABLE_SUBSCRIPTIONS = 'subscriptions';
const EXPIRE_BATCH_SIZE = 100;
const DEFAULT_PROVIDER = 'stripe';

function requireSubscriptionParams(userId, subscriptionId) {
  if (!userId || !subscriptionId) {
    throw new AppError(
      'userId and subscriptionId are required',
      400,
      { userId, subscriptionId },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

function normalizeRpcRow(data) {
  if (!data) return {};
  if (Array.isArray(data)) return data[0] || {};
  return data;
}

async function safeRpc(name, payload, context = {}) {
  const { data, error } = await supabase.rpc(name, payload);

  if (error) {
    logger.error('[Billing] RPC failed', {
      rpc: name,
      ...context,
      code: error.code,
      error: error.message,
    });
    throw error;
  }

  return normalizeRpcRow(data);
}

async function activateSubscription({
  userId,
  planAmount,
  subscriptionId,
  provider,
  externalEventId,
  currency = 'INR',
}) {
  requireSubscriptionParams(userId, subscriptionId);

  const normalizedPlanAmount = Number(planAmount);

  if (!Number.isFinite(normalizedPlanAmount)) {
    throw new AppError(
      'Invalid planAmount',
      400,
      { planAmount },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const result = await safeRpc(
    'activate_subscription_tx',
    {
      p_user_id: userId,
      p_plan_amount: normalizedPlanAmount,
      p_plan_currency: currency,
      p_subscription_id: subscriptionId,
      p_provider: provider || DEFAULT_PROVIDER,
      p_external_event_id:
        externalEventId ?? subscriptionId,
      p_idempotency_key: `activate:${subscriptionId}`,
      p_now: new Date().toISOString(),
    },
    { userId, subscriptionId }
  );

  if (!result?.out_user_id) {
    throw new AppError(
      'Subscription activation returned invalid payload',
      500,
      { userId, subscriptionId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return {
    skipped: Boolean(result.out_skipped),
    userId: result.out_user_id,
    tier: result.out_tier,
    credits_balance: result.out_credits_balance,
    credits_used: result.out_credits_used,
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
  requireSubscriptionParams(userId, subscriptionId);

  const result = await safeRpc(
    'cancel_subscription_tx',
    {
      p_user_id: userId,
      p_subscription_id: subscriptionId,
      p_provider: provider || DEFAULT_PROVIDER,
      p_reason: reason,
      p_external_event_id:
        externalEventId ?? subscriptionId,
      p_idempotency_key: `cancel:${subscriptionId}`,
      p_now: new Date().toISOString(),
    },
    { userId, subscriptionId, reason }
  );

  return {
    skipped: Boolean(result.out_skipped),
    userId,
    newTier: result.out_tier || 'free',
  };
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
      .from(TABLE_SUBSCRIPTIONS)
      .select(
        'user_id, subscription_id, provider, expires_at'
      )
      .eq('subscription_status', 'active')
      .lte('expires_at', now)
      .order('expires_at', { ascending: true })
      .limit(EXPIRE_BATCH_SIZE);

    if (error) throw error;
    if (!data?.length) break;

    const results = await Promise.allSettled(
      data.map((row) =>
        cancelSubscription({
          userId: row.user_id,
          subscriptionId:
            row.subscription_id ??
            `expired:${row.user_id}`,
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

  logger.info('[Billing] Expiry batch completed', {
    processed,
    failed,
  });

  return { processed, failed };
}

async function getSubscriptionStatus(userId) {
  const result = await safeRpc(
    'get_subscription_status',
    { p_user_id: userId },
    { userId }
  );

  return {
    userId,
    tier: result.tier || 'free',
    status:
      result.subscription_status ||
      result.status ||
      'inactive',
    planAmount: result.plan_amount,
    planCurrency: result.plan_currency,
    provider: result.provider,
    activatedAt: result.activated_at,
    expiresAt: result.expires_at,
    autoRenew: result.auto_renew,
    credits_balance: result.credits_balance || 0,
    credits_used: result.credits_used || 0,
  };
}

module.exports = Object.freeze({
  activateSubscription,
  cancelSubscription,
  refundSubscription,
  expireOverdueSubscriptions,
  getSubscriptionStatus,
});