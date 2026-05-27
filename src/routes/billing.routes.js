'use strict';

/**
 * src/routes/billing.routes.js
 *
 * TASK 3 — Stripe Checkout Redirect
 *
 * Mounted at: /api/v1/billing
 * Auth:       authenticate middleware applied at server.js mount point
 *
 * Routes:
 *   POST /checkout-session  → create Stripe Checkout Session, return url
 */

const { Router } = require('express');
const { createCheckoutSession } = require('../controllers/billing.controller');

const router = Router();

router.post('/checkout-session', createCheckoutSession);

module.exports = router;