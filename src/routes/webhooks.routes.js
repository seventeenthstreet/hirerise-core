'use strict';

/**
 * src/routes/webhooks.routes.js
 *
 * Production-hardened payment webhooks
 * FINAL:
 * - lazy Stripe singleton (prevents startup crash)
 * - raw body verification for Stripe + Razorpay
 * - manual activation hardened
 */

const express = require('express');
const crypto = require('crypto');
const Stripe = require('stripe');
const { z } = require('zod');

const logger = require('../utils/logger');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const {
  handleRazorpayWebhook,
  handleStripeWebhook,
  activateSubscription,
} = require('../services/billing/Billing.service');
const {
  authenticate,
  requireAdmin,
  requireRole,
} = require('../middleware/auth.middleware');
const { validateBody } = require('../middleware/validation.schemas');

const router = express.Router();

let stripeClient = null;

/**
 * Lazy Stripe singleton.
 * Prevents app boot crash when Stripe is not configured.
 */
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

  stripeClient = new Stripe(apiKey, {
    apiVersion: '2024-04-10',
  });

  return stripeClient;
}

const ManualActivationSchema = z.object({
  userId: z.string().min(1),
  planAmount: z.coerce.number().positive(),
  subscriptionId: z.string().min(1),
  currency: z.enum(['INR', 'USD']).default('INR'),
  reason: z.string().max(200).optional(),
});

// ─────────────────────────────────────────────────────────────
// POST /razorpay
// ─────────────────────────────────────────────────────────────
router.post(
  '/razorpay',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    if (!secret) {
      logger.error('[Webhook/Razorpay] Secret missing');

      throw new AppError(
        'Webhook secret not configured',
        500,
        {},
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    let verified = false;

    try {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('hex');

      verified = crypto.timingSafeEqual(
        Buffer.from(expectedSig, 'hex'),
        Buffer.from(signature || '', 'hex'),
      );
    } catch {
      verified = false;
    }

    if (!verified) {
      logger.warn('[Webhook/Razorpay] Invalid signature', {
        ip: req.ip,
      });

      return res.status(401).json({
        error: 'Invalid webhook signature',
      });
    }

    const payload = JSON.parse(req.body.toString('utf8'));

    // Fast ACK first
    res.status(200).json({ received: true });

    // Fire-and-forget processing
    handleRazorpayWebhook(payload, true).catch((err) => {
      logger.error('[Webhook/Razorpay] Processing failed', {
        event: payload?.event,
        error: err.message,
      });
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /stripe
// ─────────────────────────────────────────────────────────────
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const signature = req.headers['stripe-signature'];

    if (!secret) {
      throw new AppError(
        'STRIPE_WEBHOOK_SECRET not configured',
        500,
        {},
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    let event;

    try {
      const stripe = getStripeClient();

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        secret,
      );
    } catch (err) {
      logger.warn('[Webhook/Stripe] Signature verification failed', {
        error: err.message,
        ip: req.ip,
      });

      return res.status(400).json({
        error: 'Invalid webhook signature',
      });
    }

    // Fast ACK first
    res.status(200).json({ received: true });

    // Fire-and-forget processing
    handleStripeWebhook(event, true).catch((err) => {
      logger.error('[Webhook/Stripe] Processing failed', {
        eventType: event?.type,
        error: err.message,
      });
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /manual-activate
// ─────────────────────────────────────────────────────────────
router.post(
  '/manual-activate',
  authenticate,
  requireAdmin,
  requireRole('super_admin'),
  validateBody(ManualActivationSchema),
  asyncHandler(async (req, res) => {
    const adminId =
      req.user?.id ||
      req.auth?.userId ||
      req.user?.user_id ||
      req.user?.uid;

    const {
      userId,
      planAmount,
      subscriptionId,
      currency,
    } = req.body;

    const result = await activateSubscription({
      userId,
      planAmount,
      subscriptionId,
      provider: 'manual',
      externalEventId: `manual:${adminId}:${Date.now()}`,
      currency,
    });

    logger.info('[Webhook/Manual] Manual activation', {
      adminId,
      targetUserId: userId,
      planAmount,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),
);

module.exports = router;