'use strict';

/**
 * src/services/billing/Billing.service.js
 *
 * PATCH: ETag correctness — activateSubscription() and cancelSubscription()
 * now propagate updated_at to the users table after the billing RPC completes.
 *
 * Root cause:
 *   activate_subscription_tx and cancel_subscription_tx are Supabase RPCs that
 *   write exclusively to the subscriptions table.  They change subscription_status
 *   and tier in that table, but do NOT update users.subscription_status,
 *   users.tier, or users.updated_at.
 *
 *   GET /me reads subscription_status from users.subscription_status (not the
 *   subscriptions table directly) and also exposes users.tier.  The ETag
 *   freshness token includes both of those columns from users.
 *
 *   If the billing RPC doesn't propagate changes to the users row, the ETag
 *   survives a plan upgrade/downgrade/cancellation unchanged → GET /me returns
 *   304 with stale tier and subscriptionStatus.
 *
 * Fix strategy:
 *   After each billing RPC succeeds, issue a single UPDATE to users to:
 *     - set subscription_status to the new value
 *     - set tier to the new value
 *     - bump updated_at
 *   This is the minimal denormalization already expected by users.routes.js
 *   (which reads users.subscription_status and users.tier directly).
 *   The update is non-fatal: billing already succeeded; a cache-staleness
 *   warning is logged if the touch fails.
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { sendAlert, SEVERITY } = require('../../monitoring/alerts');

// ── Billing metadata-miss alert helper ───────────────────────────────────────
//
// PURPOSE
// Emits a structured WARN log and fires a fire-and-forget alert for every
// webhook event that cannot be mapped to a HireRise user due to missing
// metadata.user_id (Stripe) or notes.user_id (Razorpay).
//
// RULES
// - Never throws — must not break safe-no-op behavior (Rule 1 & 2)
// - No secret or sensitive payment data logged (Rule 5)
// - Deduplicated per eventId — provider retries won't cause log storms (Rule 6)
// - alertable: true field enables log-query-based alert routing (Rule 3 & 4)
//
// SPAM CONTROL
// Stripe retries a webhook up to 72h with exponential backoff.
// Razorpay retries up to 5 times over ~24h.
// Each retry carries the SAME eventId / entity.id — the dedup key in the
// alert system.  One WARN per delivery is correct; the alert system
// (via alertKey) deduplicates at the aggregation layer.

const _emittedMetadataMissKeys = new Set();
const MAX_DEDUP_CACHE = 500; // evict after 500 unique keys to prevent unbounded growth

/**
 * Emit a structured, alertable WARN for a metadata-miss event.
 * Fire-and-forget alert sent to ALERT_WEBHOOK_URL if configured.
 *
 * @param {object} opts
 * @param {'stripe'|'razorpay'} opts.provider
 * @param {string} opts.eventType     - Stripe type or Razorpay event string
 * @param {string} opts.eventId       - Unique event ID for dedup
 * @param {string|null} opts.subscriptionId
 * @param {string|null} opts.customerId    - Stripe only (never a secret)
 * @param {string|null} opts.paymentId     - Razorpay only
 * @param {boolean} opts.metadataPresent   - Was the metadata/notes key present at all?
 * @param {'activate'|'cancel'} opts.action
 */
function emitMetadataMissAlert({
  provider,
  eventType,
  eventId,
  subscriptionId,
  customerId = null,
  paymentId = null,
  metadataPresent,
  action,
}) {
  // Per-event dedup: one structured WARN per unique delivery
  const dedupKey = `${provider}:${eventId}:${action}`;
  if (_emittedMetadataMissKeys.has(dedupKey)) return;

  // Evict oldest entries if cache is full (simple FIFO)
  if (_emittedMetadataMissKeys.size >= MAX_DEDUP_CACHE) {
    const oldest = _emittedMetadataMissKeys.values().next().value;
    _emittedMetadataMissKeys.delete(oldest);
  }
  _emittedMetadataMissKeys.add(dedupKey);

  const logFields = {
    provider,
    eventType,
    eventId,
    subscriptionId: subscriptionId ?? null,
    customerId:     customerId ?? null,   // Stripe customer ID — not a secret
    paymentId:      paymentId ?? null,    // Razorpay payment ID — not a secret
    metadataPresent,
    action,
    billingActivationSkipped: true,
    alertable: true,
  };

  logger.warn('[BillingWebhook] Missing user_id metadata — billing activation skipped', logFields);

  // Fire-and-forget alert — never awaited, never throws
  sendAlert({
    message:  `[BillingWebhook] Missing user_id metadata (${provider} / ${eventType})`,
    severity: SEVERITY.HIGH,
    alertKey: dedupKey,
    context:  logFields,
  }).catch(() => {/* absorb — alert must not affect webhook response */});
}
// ── END billing metadata-miss alert helper ────────────────────────────────────

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
      rpc: name, ...context, code: error.code, error: error.message,
    });
    throw error;
  }

  return normalizeRpcRow(data);
}

/**
 * Propagate billing state changes to the users row so the ETag freshness
 * token (which reads users.subscription_status + users.tier + users.updated_at)
 * is correctly invalidated after plan changes.
 *
 * Non-fatal: billing already succeeded before this is called.
 * A failure here is a cache-consistency warning, not a data-loss event.
 */
async function touchUserBillingState(userId, newTier, newStatus, context = '') {
  if (!userId) return;

  const { error } = await supabase
    .from('users')
    .update({
      tier: newTier ?? 'free',
      subscription_status: newStatus ?? 'inactive',
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) {
    logger.warn(`[Billing] users updated_at touch failed after ${context} — ETag may be stale`, {
      userId,
      newTier,
      newStatus,
      err: error.message,
    });
  }
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
    throw new AppError('Invalid planAmount', 400, { planAmount }, ErrorCodes.VALIDATION_ERROR);
  }

  const result = await safeRpc(
    'activate_subscription_tx',
    {
      p_user_id: userId,
      p_plan_amount: normalizedPlanAmount,
      p_plan_currency: currency,
      p_subscription_id: subscriptionId,
      p_provider: provider || DEFAULT_PROVIDER,
      p_external_event_id: externalEventId ?? subscriptionId,
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

  // ── ETag INVALIDATION FIX ────────────────────────────────────────────────
  // Propagate tier + subscription_status to users row and bump updated_at so
  // the GET /me freshness token invalidates on the next request.
  if (!result.out_skipped) {
    await touchUserBillingState(userId, result.out_tier, 'active', 'activateSubscription');
  }
  // ── END ETag INVALIDATION FIX ────────────────────────────────────────────

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
      p_external_event_id: externalEventId ?? subscriptionId,
      p_idempotency_key: `cancel:${subscriptionId}`,
      p_now: new Date().toISOString(),
    },
    { userId, subscriptionId, reason }
  );

  // ── ETag INVALIDATION FIX ────────────────────────────────────────────────
  // After cancellation (or expiry), downgrade tier to 'free' in users row
  // and bump updated_at so GET /me ETag invalidates.
  if (!result.out_skipped) {
    await touchUserBillingState(
      userId,
      result.out_tier || 'free',
      'inactive',
      `cancelSubscription[${reason}]`
    );
  }
  // ── END ETag INVALIDATION FIX ────────────────────────────────────────────

  return {
    skipped: Boolean(result.out_skipped),
    userId,
    newTier: result.out_tier || 'free',
  };
}

async function refundSubscription(params) {
  return cancelSubscription({ ...params, reason: 'refund' });
}

async function expireOverdueSubscriptions() {
  let processed = 0;
  let failed = 0;

  while (true) {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from(TABLE_SUBSCRIPTIONS)
      .select('user_id, subscription_id, provider, expires_at')
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
          subscriptionId: row.subscription_id ?? `expired:${row.user_id}`,
          provider: row.provider ?? 'system',
          reason: 'expired',
          externalEventId: `expiry:${row.user_id}`,
        })
      )
    );

    processed += results.filter((r) => r.status === 'fulfilled').length;
    failed += results.filter((r) => r.status === 'rejected').length;

    if (data.length < EXPIRE_BATCH_SIZE) break;
  }

  logger.info('[Billing] Expiry batch completed', { processed, failed });
  return { processed, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook handler
//
// Preferred flow:
//   Stripe event → already-verified by constructEvent() in webhooks.routes.js
//   → normalize event type → activateSubscription() / cancelSubscription()
//   → touchUserBillingState() [called inside activate/cancel]
//   → return (caller already sent 200)
//
// Idempotency: activate_subscription_tx and cancel_subscription_tx RPCs use
// p_idempotency_key = "activate:<subId>" / "cancel:<subId>".  The RPC sets
// out_skipped = true when the key was already processed, so duplicate Stripe
// retries are safe — touchUserBillingState is skipped for already-processed events.
// ─────────────────────────────────────────────────────────────────────────────

// Stripe subscription events that mean "the customer is now paying"
const STRIPE_ACTIVATE_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',   // handles plan upgrades mid-cycle
  'invoice.payment_succeeded',
  'checkout.session.completed',
]);

// Stripe subscription events that mean "the subscription is ending"
const STRIPE_CANCEL_EVENTS = new Set([
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'invoice.payment_failed',
]);

/**
 * handleStripeWebhook
 *
 * @param {object} event   Verified Stripe event object (from stripe.webhooks.constructEvent)
 * @param {boolean} _ack   Unused — kept for call-site signature compatibility
 */
async function handleStripeWebhook(event, _ack) {
  const { type, data } = event;

  logger.info('[Billing/Stripe] Received event', { type, eventId: event.id });

  // ── ACTIVATE ──────────────────────────────────────────────────────────────
  if (STRIPE_ACTIVATE_EVENTS.has(type)) {
    const obj = data?.object ?? {};

    // checkout.session.completed puts subscription under obj.subscription
    // invoice.payment_succeeded puts subscription under obj.subscription
    // customer.subscription.* — obj IS the subscription
    const subscriptionId =
      obj.subscription ??   // checkout / invoice events
      obj.id;               // subscription events

    // customer.subscription.* carries customer directly;
    // invoice events carry customer on the invoice object
    const customerId =
      obj.customer ??
      obj.customer;

    const userId =
      obj.metadata?.user_id ??
      obj.metadata?.userId ??
      null;

    if (!userId || !subscriptionId) {
      emitMetadataMissAlert({
        provider:        'stripe',
        eventType:       type,
        eventId:         event.id,
        subscriptionId:  subscriptionId ?? null,
        customerId:      customerId ?? null,
        metadataPresent: !!obj.metadata,
        action:          'activate',
      });
      return;
    }

    // plan amount: prefer subscription plan, fall back to invoice amount_paid
    const planAmount =
      obj.plan?.amount ??
      obj.items?.data?.[0]?.plan?.amount ??
      obj.amount_paid ??
      obj.amount_total ??
      0;

    const currency = (obj.currency ?? 'inr').toUpperCase();

    await activateSubscription({
      userId,
      planAmount,
      subscriptionId,
      provider: 'stripe',
      externalEventId: event.id,
      currency,
    });

    logger.info('[Billing/Stripe] Activation handled', {
      type,
      userId,
      subscriptionId,
    });
    return;
  }

  // ── CANCEL ────────────────────────────────────────────────────────────────
  if (STRIPE_CANCEL_EVENTS.has(type)) {
    const obj = data?.object ?? {};

    const subscriptionId = obj.id ?? obj.subscription;
    const userId =
      obj.metadata?.user_id ??
      obj.metadata?.userId ??
      null;

    if (!userId || !subscriptionId) {
      emitMetadataMissAlert({
        provider:        'stripe',
        eventType:       type,
        eventId:         event.id,
        subscriptionId:  subscriptionId ?? null,
        customerId:      obj.customer ?? null,
        metadataPresent: !!obj.metadata,
        action:          'cancel',
      });
      return;
    }

    const reason = type === 'invoice.payment_failed' ? 'payment_failed' : 'cancelled';

    await cancelSubscription({
      userId,
      subscriptionId,
      provider: 'stripe',
      reason,
      externalEventId: event.id,
    });

    logger.info('[Billing/Stripe] Cancellation handled', {
      type,
      userId,
      subscriptionId,
    });
    return;
  }

  // Unhandled but recognised events — log and ignore (do not throw)
  logger.info('[Billing/Stripe] Unhandled event type — ignored', { type });
}

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay webhook handler
//
// Preferred flow:
//   Razorpay payload → already signature-verified in webhooks.routes.js
//   → normalize event → activateSubscription() / cancelSubscription()
//   → touchUserBillingState() [called inside activate/cancel]
//   → return (caller already sent 200)
//
// Idempotency: same RPC idempotency_key strategy as Stripe above.
// Razorpay retries the same payment_id / subscription_id on failure.
// ─────────────────────────────────────────────────────────────────────────────

const RAZORPAY_ACTIVATE_EVENTS = new Set([
  'payment.captured',
  'subscription.activated',
  'subscription.charged',
]);

const RAZORPAY_CANCEL_EVENTS = new Set([
  'subscription.cancelled',
  'subscription.completed',
  'subscription.paused',
  'payment.failed',
]);

/**
 * handleRazorpayWebhook
 *
 * @param {object} payload   Parsed Razorpay webhook body (JSON)
 * @param {boolean} _ack     Unused — kept for call-site signature compatibility
 */
async function handleRazorpayWebhook(payload, _ack) {
  const event = payload?.event;
  const entity = payload?.payload?.subscription?.entity ??
                 payload?.payload?.payment?.entity ??
                 {};

  logger.info('[Billing/Razorpay] Received event', { event });

  // ── ACTIVATE ──────────────────────────────────────────────────────────────
  if (RAZORPAY_ACTIVATE_EVENTS.has(event)) {
    const subscriptionId =
      entity.id ??
      payload?.payload?.subscription?.entity?.id;

    const userId =
      entity.notes?.user_id ??
      entity.notes?.userId ??
      null;

    if (!userId || !subscriptionId) {
      emitMetadataMissAlert({
        provider:        'razorpay',
        eventType:       event,
        eventId:         entity.id ?? subscriptionId ?? payload?.event ?? 'unknown',
        subscriptionId:  subscriptionId ?? null,
        paymentId:       payload?.payload?.payment?.entity?.id ?? null,
        metadataPresent: !!entity.notes,
        action:          'activate',
      });
      return;
    }

    // Razorpay amounts are in the smallest currency unit (paise for INR)
    const rawAmount =
      entity.amount ??
      payload?.payload?.payment?.entity?.amount ??
      0;
    const planAmount = rawAmount / 100;   // convert paise → rupees

    const currency = (entity.currency ?? 'INR').toUpperCase();

    await activateSubscription({
      userId,
      planAmount,
      subscriptionId,
      provider: 'razorpay',
      externalEventId: entity.id ?? subscriptionId,
      currency,
    });

    logger.info('[Billing/Razorpay] Activation handled', {
      event,
      userId,
      subscriptionId,
    });
    return;
  }

  // ── CANCEL ────────────────────────────────────────────────────────────────
  if (RAZORPAY_CANCEL_EVENTS.has(event)) {
    const subscriptionId = entity.id;
    const userId =
      entity.notes?.user_id ??
      entity.notes?.userId ??
      null;

    if (!userId || !subscriptionId) {
      emitMetadataMissAlert({
        provider:        'razorpay',
        eventType:       event,
        eventId:         entity.id ?? payload?.event ?? 'unknown',
        subscriptionId:  subscriptionId ?? null,
        paymentId:       payload?.payload?.payment?.entity?.id ?? null,
        metadataPresent: !!entity.notes,
        action:          'cancel',
      });
      return;
    }

    const reason = event === 'payment.failed' ? 'payment_failed' : 'cancelled';

    await cancelSubscription({
      userId,
      subscriptionId,
      provider: 'razorpay',
      reason,
      externalEventId: subscriptionId,
    });

    logger.info('[Billing/Razorpay] Cancellation handled', {
      event,
      userId,
      subscriptionId,
    });
    return;
  }

  logger.info('[Billing/Razorpay] Unhandled event — ignored', { event });
}

module.exports = Object.freeze({
  activateSubscription,
  cancelSubscription,
  refundSubscription,
  expireOverdueSubscriptions,
  handleStripeWebhook,
  handleRazorpayWebhook,
});