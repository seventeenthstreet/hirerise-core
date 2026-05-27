'use strict';

/**
 * src/services/billing/billingMetadata.js
 *
 * Centralized billing metadata injection helper.
 *
 * PURPOSE
 * -------
 * Webhook handlers in Billing.service.js REQUIRE:
 *   Stripe  → metadata.user_id
 *   Razorpay → notes.user_id
 *
 * to map payment events back to HireRise users.
 *
 * If ANY checkout / subscription / order creation call omits these
 * fields, the webhook verifies correctly but safe-no-ops — the
 * subscription is never activated and no error is surfaced.
 *
 * This module provides a single source of truth for metadata injection
 * so future payment creation paths cannot accidentally omit user_id.
 *
 * USAGE
 * -----
 * Stripe:
 *   stripe.checkout.sessions.create({
 *     ...params,
 *     ...buildStripeMetadata(userId),
 *   });
 *
 * Razorpay:
 *   razorpay.subscriptions.create({
 *     ...params,
 *     ...buildRazorpayNotes(userId),
 *   });
 *
 * RULES
 * -----
 * - NEVER pass email as the identity fallback (Rule 3).
 * - ALWAYS pass the HireRise user UUID as user_id.
 * - Both helpers are intentionally thin: they produce only the
 *   provider-required shape and nothing else.
 */

/**
 * Build the metadata object for Stripe payment objects.
 *
 * Attach to: Checkout Session, Subscription, PaymentIntent.
 *
 * @param {string} userId  HireRise user UUID
 * @returns {{ metadata: { user_id: string } }}
 */
function buildStripeMetadata(userId) {
  if (!userId) {
    throw new Error('[BillingMetadata] userId is required for Stripe metadata injection');
  }
  return {
    metadata: {
      user_id: userId,
    },
  };
}

/**
 * Build the notes object for Razorpay payment objects.
 *
 * Attach to: Subscription, Order, Payment.
 *
 * @param {string} userId  HireRise user UUID
 * @returns {{ notes: { user_id: string } }}
 */
function buildRazorpayNotes(userId) {
  if (!userId) {
    throw new Error('[BillingMetadata] userId is required for Razorpay notes injection');
  }
  return {
    notes: {
      user_id: userId,
    },
  };
}

module.exports = Object.freeze({
  buildStripeMetadata,
  buildRazorpayNotes,
});