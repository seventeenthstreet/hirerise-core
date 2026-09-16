'use strict';

/**
 * src/services/billing/paygWebhook.service.js
 *
 * PAYG Phase 1 — provider-neutral normalization for Stripe and Razorpay.
 *
 * SEPARATE handler/path from subscription billing (controlling prompt §8,
 * §9, §13): this module never calls activateSubscription/
 * cancelSubscription/activate_subscription_tx, never changes users.tier,
 * and is invoked independently of src/services/billing/Billing.service.js.
 * Both are wired into the same two provider webhook routes in
 * src/routes/webhooks.routes.js — each decides independently whether an
 * event belongs to it.
 *
 * Normalized shape handed to paygPayment.service#recordPaygPaymentEvent:
 *   { provider, providerEventId, providerPaymentId, userId, packageId,
 *     amount, currency, status, occurredAt, metadata }
 *
 * Stripe event coverage (controlling prompt §8): Stripe's event catalog is
 * public, versioned, stable API surface — full confirmed/failed/refunded/
 * disputed coverage is implemented.
 *
 * Razorpay event coverage (controlling prompt §9): this codebase's
 * existing, already-live Razorpay integration (Billing.service.js) only
 * establishes the semantics of `payment.captured` and `payment.failed`.
 * Refund/dispute webhook event names and payload shapes for Razorpay are
 * NOT independently verifiable in this environment (no live account, no
 * credentials, no sandbox event log access — controlling prompt §9 and
 * Stop Condition #3). Implementing refund/dispute parsing now would mean
 * guessing a payload shape for a financial state transition, which the
 * controlling prompt explicitly forbids. Razorpay refund/dispute handling
 * is therefore DEFERRED — see the STOP note in handleRazorpayPaygWebhook
 * below. The `refunded`/`disputed` states are already supported by the
 * database layer (record_payg_payment_event), so wiring this up later
 * needs only a normalizer, once the payload shape is confirmed against
 * Razorpay's real dashboard/docs or a sandbox account.
 */

const logger = require('../../utils/logger');
const { recordPaygPaymentEvent } = require('./paygPayment.service');

// ─────────────────────────────────────────────────────────────────────────
// Stripe
// ─────────────────────────────────────────────────────────────────────────

const STRIPE_PAYG_CONFIRM_EVENTS = new Set(['payment_intent.succeeded']);
const STRIPE_PAYG_FAIL_EVENTS = new Set(['payment_intent.payment_failed']);
const STRIPE_PAYG_REFUND_EVENTS = new Set(['charge.refunded']);
const STRIPE_PAYG_DISPUTE_EVENTS = new Set(['charge.dispute.created']);

function isStripePaygCheckoutSession(obj) {
  // A Checkout Session is only PAYG-relevant when it is a one-time
  // payment (mode 'payment') rather than a subscription checkout.
  return obj?.mode === 'payment';
}

/**
 * Normalizes a verified Stripe event into the provider-neutral shape, or
 * returns null if the event is not PAYG-relevant (subscriptions, or an
 * unrelated event type — safely ignored here, and independently handled
 * or ignored by Billing.service.js's subscription path).
 */
function normalizeStripeEvent(event) {
  const { type, data } = event;
  const obj = data?.object ?? {};

  if (type === 'checkout.session.completed' && isStripePaygCheckoutSession(obj)) {
    if (obj.payment_status !== 'paid') {
      // Async payment methods can complete the session before payment is
      // confirmed. Wait for payment_intent.succeeded instead of guessing.
      return null;
    }

    return {
      provider: 'stripe',
      providerEventId: event.id,
      providerPaymentId: obj.payment_intent ?? obj.id,
      userId: obj.metadata?.user_id ?? obj.metadata?.userId ?? null,
      packageId: obj.metadata?.package_id ?? obj.metadata?.packageId ?? null,
      amount: (obj.amount_total ?? 0) / 100,
      currency: (obj.currency ?? '').toUpperCase(),
      status: 'confirmed',
      occurredAt: new Date(event.created * 1000).toISOString(),
      metadata: { stripeEventType: type },
    };
  }

  if (STRIPE_PAYG_CONFIRM_EVENTS.has(type) || STRIPE_PAYG_FAIL_EVENTS.has(type)) {
    // payment_intent.* events fire for BOTH PAYG one-time payments and
    // Stripe Billing invoice-driven subscription charges (Stripe attaches
    // a payment_intent to subscription invoices too). Only treat this as
    // a PAYG event when it is not tied to an invoice/subscription.
    if (obj.invoice) return null;

    return {
      provider: 'stripe',
      providerEventId: event.id,
      providerPaymentId: obj.id,
      userId: obj.metadata?.user_id ?? obj.metadata?.userId ?? null,
      packageId: obj.metadata?.package_id ?? obj.metadata?.packageId ?? null,
      amount: (obj.amount ?? 0) / 100,
      currency: (obj.currency ?? '').toUpperCase(),
      status: STRIPE_PAYG_CONFIRM_EVENTS.has(type) ? 'confirmed' : 'failed',
      occurredAt: new Date(event.created * 1000).toISOString(),
      metadata: { stripeEventType: type },
    };
  }

  if (STRIPE_PAYG_REFUND_EVENTS.has(type)) {
    if (obj.invoice) return null; // subscription invoice refund, not PAYG

    return {
      provider: 'stripe',
      providerEventId: event.id,
      providerPaymentId: obj.payment_intent ?? obj.id,
      userId: obj.metadata?.user_id ?? obj.metadata?.userId ?? null,
      packageId: obj.metadata?.package_id ?? obj.metadata?.packageId ?? null,
      amount: (obj.amount ?? 0) / 100,
      currency: (obj.currency ?? '').toUpperCase(),
      status: 'refunded',
      occurredAt: new Date(event.created * 1000).toISOString(),
      metadata: { stripeEventType: type },
    };
  }

  if (STRIPE_PAYG_DISPUTE_EVENTS.has(type)) {
    return {
      provider: 'stripe',
      providerEventId: event.id,
      providerPaymentId: obj.payment_intent ?? obj.id,
      userId: obj.metadata?.user_id ?? obj.metadata?.userId ?? null,
      packageId: obj.metadata?.package_id ?? obj.metadata?.packageId ?? null,
      amount: (obj.amount ?? 0) / 100,
      currency: (obj.currency ?? '').toUpperCase(),
      status: 'disputed',
      occurredAt: new Date(event.created * 1000).toISOString(),
      metadata: { stripeEventType: type },
    };
  }

  return null;
}

async function handleStripePaygWebhook(event) {
  let normalized;
  try {
    normalized = normalizeStripeEvent(event);
  } catch (err) {
    logger.error('[PAYG/Stripe] Normalization failed', { eventId: event?.id, error: err.message });
    return;
  }

  if (!normalized) return; // not a PAYG-relevant event — no-op

  await recordPaygPaymentEvent(normalized);
}

// ─────────────────────────────────────────────────────────────────────────
// Razorpay
// ─────────────────────────────────────────────────────────────────────────

function isRazorpaySubscriptionEntity(payload) {
  return Boolean(payload?.payload?.subscription?.entity);
}

/**
 * Normalizes a verified Razorpay payload into the provider-neutral shape,
 * or returns null if not PAYG-relevant.
 *
 * Only `payment.captured` and `payment.failed` are implemented — see the
 * module header for why refund/dispute are deferred (Stop Condition #3 /
 * controlling prompt §9).
 */
function normalizeRazorpayPayload(payload) {
  const event = payload?.event;

  // `payment.captured` / `payment.failed` fire for BOTH subscription
  // recurring charges and one-time (PAYG) order payments. Only the
  // absence of a subscription entity makes this PAYG-relevant — mirrors
  // the isolation guard added to Billing.service.js's legacy handler.
  if (event !== 'payment.captured' && event !== 'payment.failed') return null;
  if (isRazorpaySubscriptionEntity(payload)) return null;

  const entity = payload?.payload?.payment?.entity;
  if (!entity) return null;

  const rawAmount = entity.amount ?? 0;

  return {
    provider: 'razorpay',
    providerEventId: `${event}:${entity.id}`,
    providerPaymentId: entity.order_id ?? entity.id,
    userId: entity.notes?.user_id ?? entity.notes?.userId ?? null,
    packageId: entity.notes?.package_id ?? entity.notes?.packageId ?? null,
    amount: rawAmount / 100, // paise -> rupees
    currency: (entity.currency ?? 'INR').toUpperCase(),
    status: event === 'payment.captured' ? 'confirmed' : 'failed',
    occurredAt: entity.created_at
      ? new Date(entity.created_at * 1000).toISOString()
      : new Date().toISOString(),
    metadata: { razorpayEvent: event },
  };
}

async function handleRazorpayPaygWebhook(payload) {
  // STOP — Refund/dispute events (e.g. `refund.processed`,
  // `payment.dispute.created`) are intentionally NOT parsed here. See
  // module header: their payload shape cannot be established without
  // live Razorpay account or sandbox access (controlling prompt §9,
  // Stop Condition #3). Logged, not silently dropped, so this gap is
  // visible in operation rather than only in code comments.
  if (
    typeof payload?.event === 'string' &&
    (payload.event.startsWith('refund.') || payload.event.startsWith('payment.dispute.'))
  ) {
    logger.warn('[PAYG/Razorpay] Refund/dispute event received but not yet handled — see paygWebhook.service.js STOP note', {
      event: payload.event,
    });
    return;
  }

  let normalized;
  try {
    normalized = normalizeRazorpayPayload(payload);
  } catch (err) {
    logger.error('[PAYG/Razorpay] Normalization failed', { event: payload?.event, error: err.message });
    return;
  }

  if (!normalized) return; // not a PAYG-relevant event — no-op

  await recordPaygPaymentEvent(normalized);
}

module.exports = {
  normalizeStripeEvent,
  normalizeRazorpayPayload,
  handleStripePaygWebhook,
  handleRazorpayPaygWebhook,
};
