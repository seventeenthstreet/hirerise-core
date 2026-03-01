'use strict';

/**
 * webhooks.routes.js — Payment Webhook Handlers
 * ==============================================
 * PRODUCTION HARDENED — Phase 4
 *
 * CRITICAL: These routes MUST NOT use the authenticate middleware.
 * Webhooks come from payment providers, not users.
 * Authentication is done via signature verification instead.
 *
 * PLACEMENT in server.js — add BEFORE authenticate routes:
 *
 *   // Webhooks — NO authenticate middleware — signature-verified
 *   app.use(`${API_PREFIX}/webhooks`, require('./routes/webhooks.routes'));
 *
 * RAZORPAY SETUP:
 *   1. Dashboard → Settings → Webhooks → Add Webhook
 *   2. URL: https://yourdomain.com/api/v1/webhooks/razorpay
 *   3. Events: payment.captured, refund.created
 *   4. Set RAZORPAY_WEBHOOK_SECRET in .env
 *
 * STRIPE SETUP:
 *   1. Dashboard → Developers → Webhooks → Add endpoint
 *   2. URL: https://yourdomain.com/api/v1/webhooks/stripe
 *   3. Events: checkout.session.completed, customer.subscription.deleted, charge.refunded
 *   4. Set STRIPE_WEBHOOK_SECRET in .env
 *   5. MUST use express.raw() for body — see bodyParser config below
 */

const express = require('express');
const crypto  = require('crypto');
const logger  = require('../utils/logger');
const { handleRazorpayWebhook, handleStripeWebhook } = require('../services/billing/Billing.service');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

// ─── Razorpay webhook ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/webhooks/razorpay
 *
 * Verifies Razorpay webhook signature using HMAC-SHA256.
 * Razorpay sends X-Razorpay-Signature header.
 */
router.post(
  '/razorpay',
  express.json(),  // Razorpay sends JSON body — standard parsing is fine
  async (req, res, next) => {
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = JSON.stringify(req.body);

    if (!secret) {
      logger.error('[Webhook/Razorpay] RAZORPAY_WEBHOOK_SECRET not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // ── Signature verification ──────────────────────────────────────────────
    let verified = false;
    try {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      verified = crypto.timingSafeEqual(
        Buffer.from(expectedSig, 'hex'),
        Buffer.from(signature ?? '', 'hex')
      );
    } catch (_) {
      verified = false;
    }

    if (!verified) {
      logger.warn('[Webhook/Razorpay] Invalid signature', {
        ip: req.ip,
        event: req.body?.event,
      });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // ── Acknowledge immediately (Razorpay expects fast 200) ─────────────────
    res.status(200).json({ received: true });

    // ── Process asynchronously (fire-and-forget after 200) ──────────────────
    handleRazorpayWebhook(req.body, true).catch(err => {
      logger.error('[Webhook/Razorpay] Processing failed', {
        event:   req.body?.event,
        error:   err.message,
      });
    });
  }
);

// ─── Stripe webhook ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/webhooks/stripe
 *
 * IMPORTANT: Stripe signature verification requires the RAW body (Buffer),
 * not the parsed JSON. This route uses express.raw() instead of express.json().
 *
 * In server.js, the global express.json() middleware runs BEFORE routes.
 * For this specific route, express.raw() here takes precedence because
 * it's route-level middleware, not app-level.
 *
 * If you hit "No signatures found matching the expected signature" errors,
 * check that global express.json() hasn't already consumed the body for this route.
 * Solution: add `express.raw({ type: 'application/json' })` before global json middleware
 * only for /webhooks/stripe path, or use a separate Express sub-app.
 */
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    const secret    = process.env.STRIPE_WEBHOOK_SECRET;
    const signature = req.headers['stripe-signature'];

    if (!secret) {
      logger.error('[Webhook/Stripe] STRIPE_WEBHOOK_SECRET not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // ── Stripe signature verification via official SDK ────────────────────
    // stripe package must be installed: npm install stripe
    // Requires the raw Buffer body — express.raw() above ensures this.
    let event;
    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2024-04-10',
      });
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
    } catch (err) {
      logger.warn('[Webhook/Stripe] Signature verification failed', {
        error: err.message,
        ip:    req.ip,
      });
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    // ── Acknowledge immediately ──────────────────────────────────────────
    res.status(200).json({ received: true });

    // ── Process asynchronously ───────────────────────────────────────────
    handleStripeWebhook(event, true).catch(err => {
      logger.error('[Webhook/Stripe] Processing failed', {
        eventType: event?.type,
        error:     err.message,
      });
    });
  }
);

// ─── Manual admin activation (fallback for manual payments) ──────────────────

/**
 * POST /api/v1/webhooks/manual-activate
 * Body: { userId, planAmount, subscriptionId, provider: 'manual', currency }
 *
 * For: UPI transfers, bank transfers, test activations.
 * Requires: super_admin role.
 * Protected by: authenticate + requireAdmin + requireRole('super_admin')
 */
const { authenticate } = require('../middleware/auth.middleware');
const { requireAdmin, requireRole } = require('../middleware/auth.middleware');
const { activateSubscription } = require('../services/billing/Billing.service');
const { validateBody } = require('../middleware/validation.schemas');
const { z } = require('zod');

const ManualActivationSchema = z.object({
  userId:          z.string().min(1),
  planAmount:      z.coerce.number().positive(),
  subscriptionId:  z.string().min(1),
  currency:        z.enum(['INR', 'USD']).default('INR'),
  reason:          z.string().max(200).optional(),
});

router.post(
  '/manual-activate',
  authenticate,
  requireAdmin,
  requireRole('super_admin'),
  validateBody(ManualActivationSchema),
  async (req, res, next) => {
    try {
      const { userId, planAmount, subscriptionId, currency } = req.body;
      const result = await activateSubscription({
        userId,
        planAmount,
        subscriptionId,
        provider:        'manual',
        externalEventId: `manual:${req.user.uid}:${Date.now()}`,
        currency,
      });

      logger.info('[Webhook/Manual] Manual activation by admin', {
        adminUid:       req.user.uid,
        targetUserId:   userId,
        planAmount,
      });

      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;