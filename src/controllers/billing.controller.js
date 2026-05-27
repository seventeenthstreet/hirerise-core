'use strict';

/**
 * src/controllers/billing.controller.js
 *
 * TASK 3 — Stripe Checkout Redirect
 *
 * POST /api/v1/billing/checkout-session
 *   Creates a Stripe Checkout Session and returns the hosted URL.
 *   Frontend redirects the browser to that URL.
 */

const Stripe = require('stripe');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { buildStripeMetadata } = require('../services/billing/billingMetadata');
const logger = require('../utils/logger');

// ── Lazy Stripe singleton ─────────────────────────────────────────────────────
// Same pattern as webhooks.routes.js — prevents startup crash when Stripe is
// not configured, and avoids creating multiple client instances.

let stripeClient = null;

function getStripeClient() {
  if (stripeClient) return stripeClient;

  const apiKey = process.env.STRIPE_SECRET_KEY;

  if (!apiKey) {
    throw new AppError(
      'STRIPE_SECRET_KEY not configured',
      500,
      {},
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  if (apiKey.startsWith('pk_')) {
    throw new AppError(
      'STRIPE_SECRET_KEY must be a secret key (sk_live_ or sk_test_). ' +
      'A publishable key (pk_) was provided — this is a misconfiguration.',
      500,
      {},
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  if (!apiKey.startsWith('sk_')) {
    throw new AppError(
      'STRIPE_SECRET_KEY has an unrecognised format. Expected sk_live_ or sk_test_.',
      500,
      {},
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  stripeClient = new Stripe(apiKey, { apiVersion: '2024-04-10' });
  return stripeClient;
}

// ── Handler ───────────────────────────────────────────────────────────────────

const createCheckoutSession = asyncHandler(async (req, res) => {
  // Extract authenticated user ID — same pattern as all other controllers
  const userId = req?.user?.id ?? req?.user?.uid ?? null;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  const priceId = process.env.STRIPE_PRICE_ID;

  if (!priceId) {
    logger.error('[Billing] STRIPE_PRICE_ID not configured');
    throw new AppError(
      'STRIPE_PRICE_ID not configured',
      500,
      {},
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  // Frontend origin used for success/cancel redirect URLs.
  // Falls back to APP_URL (backend) for local dev without FRONTEND_URL set.
  const appUrl =
    process.env.FRONTEND_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    'http://localhost:3000';

  const stripe = getStripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price:    priceId,
        quantity: 1,
      },
    ],
    success_url: `${appUrl}/report?upgrade=success`,
    cancel_url:  `${appUrl}/report?upgrade=cancelled`,
    // Injects metadata.user_id so the checkout.session.completed webhook
    // can map the payment back to this HireRise user.
    ...buildStripeMetadata(userId),
  });

  logger.info('[Billing] Checkout session created', {
    userId,
    sessionId: session.id,
  });

  return res.status(200).json({
    success: true,
    data: { url: session.url },
  });
});

module.exports = { createCheckoutSession };