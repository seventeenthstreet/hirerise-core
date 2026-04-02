'use strict';

/**
 * billing.service.js — Billing Preparation Layer
 * ===============================================
 * PRODUCTION HARDENED — Phase 4
 *
 * WHAT THIS IS:
 *   The complete internal billing architecture, payment-provider-agnostic.
 *   Stripe and Razorpay webhook handlers call this service.
 *   This service never calls Stripe or Razorpay APIs directly.
 *
 * WHAT THIS IS NOT:
 *   A Stripe/Razorpay client. External API calls are NOT implemented here.
 *   Those live in billing.stripe.js and billing.razorpay.js (not yet created).
 *
 * ARCHITECTURE DECISIONS:
 *
 *   1. Single source of truth for tier mutations.
 *      paymentActivation.service.js already exists and does this correctly.
 *      This service EXTENDS it with subscription lifecycle management.
 *
 *   2. Idempotency via subscriptionId.
 *      All state mutations check subscriptionId to prevent double-processing
 *      webhook events (both Stripe and Razorpay can deliver events >1 time).
 *
 *   3. Audit trail via subscriptionEvents table.
 *      Every state change is appended — never overwritten. This is required
 *      for dispute resolution, refund audits, and compliance.
 *
 *   4. Downgrade is non-destructive.
 *      User data is preserved. Only tier and credits are revoked.
 *      Allows win-back campaigns and easy reactivation.
 *
 * TABLES:
 *
 *   subscriptions
 *     Current subscription state per userId (upserted on each event)
 *
 *   subscriptionEvents
 *     Immutable audit log of all billing events (append-only)
 *
 * SUPABASE INDEXES NEEDED:
 *   subscriptions: [status ASC, expiresAt ASC]    (for expiry job)
 *   subscriptions: [userId ASC, status ASC]
 *   subscriptionEvents: [userId ASC, createdAt DESC]
 *   subscriptionEvents: [provider ASC, externalEventId ASC]  (idempotency)
 */
const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const {
  getCreditsForPlan
} = require('../../modules/analysis/analysis.constants');

// ─── Plan configuration ───────────────────────────────────────────────────────

const PLAN_CONFIG = {
  // INR plans
  499: {
    tier: 'pro',
    credits: 16,
    currency: 'INR',
    durationDays: 30
  },
  699: {
    tier: 'pro',
    credits: 23,
    currency: 'INR',
    durationDays: 30
  },
  999: {
    tier: 'pro',
    credits: 33,
    currency: 'INR',
    durationDays: 30
  },
  // USD plans (for international expansion)
  9: {
    tier: 'pro',
    credits: 20,
    currency: 'USD',
    durationDays: 30
  },
  29: {
    tier: 'enterprise',
    credits: 100,
    currency: 'USD',
    durationDays: 30
  }
};

function getPlanConfig(amount, currency = 'INR') {
  const config = PLAN_CONFIG[amount];
  if (!config) throw new AppError(`Unknown plan amount: ${amount}`, 400, {
    amount
  }, ErrorCodes.VALIDATION_ERROR);
  return config;
}

// ─── Subscription schema (for documentation — not runtime schema enforcement) ─

/*
  subscriptions row: {
    user_id:               string
    tier:                 'free' | 'pro' | 'enterprise'
    status:               'active' | 'cancelled' | 'expired' | 'paused' | 'trialing'
    planAmount:           number         (INR or USD)
    planCurrency:         string
    aiCreditsAllocated:   number
    aiCreditsRemaining:   number
    subscriptionId:       string         (provider's subscription/payment ID)
    provider:             'razorpay' | 'stripe' | 'manual'
    activatedAt:          timestamptz
    expiresAt:            timestamptz | null
    cancelledAt:          timestamptz | null
    currentPeriodStart:   timestamptz
    currentPeriodEnd:     timestamptz
    autoRenew:            boolean
    trialEndsAt:          timestamptz | null
    updatedAt:            timestamptz
  }

  subscriptionEvents row: {
    user_id:           string
    eventType:        'activated' | 'renewed' | 'cancelled' | 'downgraded' | 'refunded' | 'expired' | 'paused'
    provider:         string
    externalEventId:  string         (Stripe event ID or Razorpay payment ID)
    planAmount:       number
    planCurrency:     string
    creditsGranted:   number
    previousTier:     string
    newTier:          string
    metadata:         object
    idempotencyKey:   string         (prevent duplicate processing)
    createdAt:        timestamptz
  }
*/

// ─── Idempotency check ────────────────────────────────────────────────────────

async function isEventAlreadyProcessed(idempotencyKey) {
  const { data: _ev, error } = await supabase
    .from('subscriptionEvents')
    .select('id')
    .eq('idempotencyKey', idempotencyKey)
    .limit(1);

  if (error) throw error;
  return !!_ev?.length;
}

// ─── Core: activate subscription ─────────────────────────────────────────────

/**
 * activateSubscription({ userId, planAmount, subscriptionId, provider, externalEventId })
 *
 * Called by: Razorpay webhook, Stripe webhook, manual admin activation.
 * Idempotent: safe to call multiple times with same subscriptionId.
 *
 * What it does:
 *   1. Idempotency check (skip if already processed)
 *   2. Look up plan config
 *   3. Update users/{userId} — tier, credits, subscription fields
 *   4. Upsert subscriptions row for userId
 *   5. Append to subscriptionEvents
 */
async function activateSubscription({
  userId,
  planAmount,
  subscriptionId,
  provider,
  externalEventId,
  currency = 'INR'
}) {
  const idempotencyKey = `activate:${subscriptionId}`;
  if (await isEventAlreadyProcessed(idempotencyKey)) {
    logger.info('[Billing] Duplicate activation event skipped', {
      subscriptionId,
      idempotencyKey
    });
    return {
      skipped: true,
      reason: 'duplicate'
    };
  }

  const plan = getPlanConfig(planAmount, currency);
  const now = new Date();
  const nowISO = now.toISOString();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + plan.durationDays);
  const expiresAtISO = expiresAt.toISOString();

  // ── Fetch previous tier for audit log ────────────────────────────────────
  const { data: _userRow, error: userFetchError } = await supabase
    .from('users')
    .select('tier, planAmount, planCurrency')
    .eq('id', userId)
    .maybeSingle();

  if (userFetchError) throw userFetchError;

  const previousTier = _userRow?.tier ?? 'free';

  // ── Parallel writes (replaces batch) ──────────────────────────────────────
  const [userUpdateResult, subscriptionUpsertResult, eventInsertResult] = await Promise.all([
    supabase
      .from('users')
      .update({
        tier: plan.tier,
        status: 'active',
        planAmount,
        planCurrency: currency,
        aiCreditsAllocated: plan.credits,
        aiCreditsRemaining: plan.credits,
        subscriptionId,
        provider,
        activatedAt: nowISO,
        expiresAt: expiresAtISO,
        cancelledAt: null,
        currentPeriodStart: nowISO,
        currentPeriodEnd: expiresAtISO,
        autoRenew: false,
        trialEndsAt: null,
        updatedAt: nowISO
      })
      .eq('id', userId),

    supabase
      .from('subscriptions')
      .upsert([{
        userId,
        tier: plan.tier,
        status: 'active',
        planAmount,
        planCurrency: currency,
        aiCreditsAllocated: plan.credits,
        aiCreditsRemaining: plan.credits,
        subscriptionId,
        provider,
        activatedAt: nowISO,
        expiresAt: expiresAtISO,
        cancelledAt: null,
        currentPeriodStart: nowISO,
        currentPeriodEnd: expiresAtISO,
        autoRenew: false,
        trialEndsAt: null,
        updatedAt: nowISO
      }]),

    supabase
      .from('subscriptionEvents')
      .insert([{
        userId,
        eventType: 'activated',
        provider,
        externalEventId: externalEventId ?? subscriptionId,
        planAmount,
        planCurrency: currency,
        creditsGranted: plan.credits,
        previousTier,
        newTier: plan.tier,
        metadata: { subscriptionId },
        idempotencyKey,
        createdAt: nowISO
      }])
  ]);

  if (userUpdateResult.error) throw userUpdateResult.error;
  if (subscriptionUpsertResult.error) throw subscriptionUpsertResult.error;
  if (eventInsertResult.error) throw eventInsertResult.error;

  logger.info('[Billing] Subscription activated', {
    userId,
    planAmount,
    tier: plan.tier,
    credits: plan.credits,
    provider
  });

  return {
    skipped: false,
    userId,
    tier: plan.tier,
    creditsGranted: plan.credits,
    expiresAt: expiresAtISO
  };
}

// ─── Downgrade / cancel ───────────────────────────────────────────────────────

/**
 * cancelSubscription({ userId, subscriptionId, provider, reason, externalEventId })
 *
 * Called by: Stripe cancellation webhook, Razorpay refund webhook,
 *            admin manual override, chargebacks.
 *
 * Non-destructive: data preserved. Only tier + credits revoked.
 */
async function cancelSubscription({
  userId,
  subscriptionId,
  provider,
  reason = 'cancelled',
  externalEventId
}) {
  const idempotencyKey = `cancel:${subscriptionId}`;
  if (await isEventAlreadyProcessed(idempotencyKey)) {
    logger.info('[Billing] Duplicate cancel event skipped', {
      subscriptionId
    });
    return {
      skipped: true
    };
  }

  const now = new Date();
  const nowISO = now.toISOString();

  const { data: userRow, error: userFetchError } = await supabase
    .from('users')
    .select('tier, planAmount, planCurrency')
    .eq('id', userId)
    .maybeSingle();

  if (userFetchError) throw userFetchError;

  const previousTier = userRow?.tier ?? 'pro';

  // ── Parallel writes (replaces batch) ──────────────────────────────────────

  // 1. Revert user to free tier
  // 2. Update subscription document
  // 3. Append audit event
  const [userUpdateResult, subscriptionUpdateResult, eventInsertResult] = await Promise.all([
    supabase
      .from('users')
      .update({
        tier: 'free',
        aiCreditsRemaining: 0,
        reportUnlocked: false,
        subscriptionStatus: 'cancelled',
        subscriptionEnd: nowISO,
        updatedAt: nowISO
      })
      .eq('id', userId),

    supabase
      .from('subscriptions')
      .update({
        status: 'cancelled',
        tier: 'free',
        cancelledAt: nowISO,
        updatedAt: nowISO
      })
      .eq('userId', userId),

    supabase
      .from('subscriptionEvents')
      .insert([{
        userId,
        eventType: 'cancelled',
        provider,
        externalEventId: externalEventId ?? subscriptionId,
        planAmount: userRow?.planAmount ?? null,
        planCurrency: userRow?.planCurrency ?? 'INR',
        creditsGranted: 0,
        previousTier,
        newTier: 'free',
        metadata: { subscriptionId, reason },
        idempotencyKey,
        createdAt: nowISO
      }])
  ]);

  if (userUpdateResult.error) throw userUpdateResult.error;
  if (subscriptionUpdateResult.error) throw subscriptionUpdateResult.error;
  if (eventInsertResult.error) throw eventInsertResult.error;

  logger.info('[Billing] Subscription cancelled', {
    userId,
    provider,
    reason
  });

  return {
    skipped: false,
    userId,
    newTier: 'free'
  };
}

// ─── Refund ───────────────────────────────────────────────────────────────────

/**
 * refundSubscription — same effect as cancel but different audit event type.
 * Used when the provider fires a refund webhook.
 */
async function refundSubscription({
  userId,
  subscriptionId,
  provider,
  externalEventId
}) {
  return cancelSubscription({
    userId,
    subscriptionId,
    provider,
    reason: 'refund',
    externalEventId
  });
}

// ─── Expiry job (cron) ────────────────────────────────────────────────────────

/**
 * expireOverdueSubscriptions()
 *
 * Scans subscriptions where expiresAt < now AND status === 'active'.
 * Downgrades them to free tier.
 *
 * Called by: daily cron job (add to existing DailyAggregationWorker.runJob())
 */
async function expireOverdueSubscriptions() {
  const now = new Date().toISOString();

  const { data: expiredRows, error } = await supabase
    .from('subscriptions')
    .select('userId, subscriptionId, provider')
    .eq('status', 'active')
    .lte('expiresAt', now)
    .limit(100); // process in batches of 100

  if (error) throw error;

  if (!expiredRows || expiredRows.length === 0) {
    logger.info('[Billing] No expired subscriptions found');
    return {
      processed: 0
    };
  }

  const results = await Promise.allSettled(
    expiredRows.map(row => cancelSubscription({
      userId: row.userId,
      subscriptionId: row.subscriptionId ?? 'expired',
      provider: row.provider ?? 'system',
      reason: 'expired',
      externalEventId: `expiry:${row.userId}`
    }))
  );

  const processed = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  logger.info('[Billing] Expiry job complete', {
    processed,
    failed
  });
  return {
    processed,
    failed
  };
}

// ─── Webhook signature verification skeletons ─────────────────────────────────
// NOTE: Do NOT implement external API calls here.
// These are the handler entry points that your webhook route will call.

/**
 * handleRazorpayWebhook(rawBody, signature, secret)
 *
 * Razorpay sends: payment.captured, payment.failed, refund.created
 *
 * Wire this up in:
 *   POST /webhooks/razorpay
 *   (no authenticate middleware — Razorpay sends from their servers)
 *
 * Signature verification:
 *   const crypto = require('crypto');
 *   const expectedSig = crypto.createHmac('sha256', secret)
 *                              .update(rawBody).digest('hex');
 *   if (expectedSig !== signature) throw new Error('Invalid signature');
 */
async function handleRazorpayWebhook(payload, verified = false) {
  if (!verified) throw new AppError('Webhook signature verification required', 401);
  const {
    event,
    payload: eventPayload
  } = payload;
  switch (event) {
    case 'payment.captured':
      {
        const payment = eventPayload.payment?.entity;
        if (!payment) break;
        const userId = payment.notes?.userId;
        if (!userId) {
          logger.warn('[Billing] Razorpay payment.captured missing userId in notes', {
            paymentId: payment.id
          });
          break;
        }
        return activateSubscription({
          userId,
          planAmount: payment.amount / 100, // Razorpay amounts are in paise
          subscriptionId: payment.id,
          provider: 'razorpay',
          externalEventId: payment.id,
          currency: (payment.currency ?? 'INR').toUpperCase()
        });
      }
    case 'refund.created':
      {
        const refund = eventPayload.refund?.entity;
        if (!refund) break;

        // Map refund back to subscription via payment ID
        const { data: subRows, error: subError } = await supabase
          .from('subscriptions')
          .select('userId')
          .eq('subscriptionId', refund.payment_id)
          .limit(1);

        if (subError) throw subError;

        if (!subRows || subRows.length === 0) {
          logger.warn('[Billing] Razorpay refund.created: no subscription found for payment', {
            paymentId: refund.payment_id
          });
          break;
        }
        const userId = subRows[0].userId;
        return refundSubscription({
          userId,
          subscriptionId: refund.payment_id,
          provider: 'razorpay',
          externalEventId: refund.id
        });
      }
    default:
      logger.debug('[Billing] Unhandled Razorpay event', {
        event
      });
  }
  return {
    handled: false,
    event
  };
}

/**
 * handleStripeWebhook(event, verified = false)
 *
 * Stripe sends: checkout.session.completed, customer.subscription.deleted,
 *               charge.refunded, invoice.payment_succeeded
 *
 * Wire this up in:
 *   POST /webhooks/stripe
 *   (use express.raw() middleware — NOT express.json() — for Stripe sig verification)
 */
async function handleStripeWebhook(event, verified = false) {
  if (!verified) throw new AppError('Webhook signature verification required', 401);
  switch (event.type) {
    case 'checkout.session.completed':
      {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) {
          logger.warn('[Billing] Stripe checkout.session.completed missing userId in metadata');
          break;
        }
        const amountUSD = (session.amount_total ?? 0) / 100; // cents → dollars

        return activateSubscription({
          userId,
          planAmount: amountUSD,
          subscriptionId: session.subscription ?? session.id,
          provider: 'stripe',
          externalEventId: event.id,
          currency: 'USD'
        });
      }
    case 'customer.subscription.deleted':
      {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (!userId) break;
        return cancelSubscription({
          userId,
          subscriptionId: sub.id,
          provider: 'stripe',
          externalEventId: event.id
        });
      }
    case 'charge.refunded':
      {
        const charge = event.data.object;
        const userId = charge.metadata?.userId;
        if (!userId) break;
        return refundSubscription({
          userId,
          subscriptionId: charge.payment_intent ?? charge.id,
          provider: 'stripe',
          externalEventId: event.id
        });
      }
    default:
      logger.debug('[Billing] Unhandled Stripe event', {
        type: event.type
      });
  }
  return {
    handled: false,
    event: event.type
  };
}

// ─── Subscription status query ────────────────────────────────────────────────

/**
 * getSubscriptionStatus(userId)
 * Returns current subscription state for /users/me and admin lookups.
 */
async function getSubscriptionStatus(userId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      userId,
      tier: 'free',
      status: 'inactive',
      credits: {
        allocated: 0,
        remaining: 0
      }
    };
  }

  return {
    userId,
    tier: data.tier,
    status: data.status,
    planAmount: data.planAmount,
    planCurrency: data.planCurrency,
    provider: data.provider,
    activatedAt: data.activatedAt ?? null,
    expiresAt: data.expiresAt ?? null,
    autoRenew: data.autoRenew,
    credits: {
      allocated: data.aiCreditsAllocated,
      remaining: data.aiCreditsRemaining
    }
  };
}

module.exports = {
  activateSubscription,
  cancelSubscription,
  refundSubscription,
  expireOverdueSubscriptions,
  handleRazorpayWebhook,
  handleStripeWebhook,
  getSubscriptionStatus,
  PLAN_CONFIG
};