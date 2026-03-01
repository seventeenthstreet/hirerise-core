'use strict';

/**
 * coverLetter.routes.js
 *
 * POST /api/v1/cover-letter/generate
 *
 * Middleware chain:
 *   authenticate → requirePaidTier → tierQuota → creditGuard → validate → controller
 *
 * TIER ENFORCEMENT:
 *   requirePaidTier blocks free users with 403 before any DB read.
 *   creditGuard checks remaining credits (fast read, no transaction).
 *   Service deducts credits atomically (Firestore transaction).
 *   Three layers of protection = no accidental free access.
 *
 * REGISTRATION in server.js:
 *   app.use(`${API_PREFIX}/cover-letter`, authenticate, require('./modules/coverLetter/coverLetter.routes'));
 */

const express = require('express');
const { z }   = require('zod');

const { authenticate }   = require('../../middleware/auth.middleware');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { generate }       = require('./controllers/coverLetter.controller');

const router = express.Router();

// ─── Zod validation schema ────────────────────────────────────────────────────

const GenerateCoverLetterSchema = z.object({
  companyName:    z.string().min(1, 'Company name is required').max(200),
  jobTitle:       z.string().min(1, 'Job title is required').max(200),
  jobDescription: z.string()
    .min(50, 'Job description must be at least 50 characters')
    .max(3500, 'Job description must not exceed 3500 characters'),
  tone:           z.enum(['professional', 'confident', 'conversational', 'formal'])
    .optional()
    .default('professional'),
}).strict();

// ─── Inline validation middleware (no external dep for simple routes) ─────────

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields = result.error.issues.map(i => ({
        field:   i.path.join('.'),
        message: i.message,
      }));
      return next(new AppError('Request validation failed', 400, { fields }, ErrorCodes.VALIDATION_ERROR));
    }
    req.body = result.data; // coerced + stripped
    next();
  };
}

// ─── Tier enforcement middleware ──────────────────────────────────────────────
// Blocks free users before any credit check or DB read.
// Uses req.user.plan set by authenticate middleware.

function requirePaidTier(req, res, next) {
  const tier = req.user?.plan ?? 'free';
  if (tier === 'free') {
    return next(new AppError(
      'Cover letter generation is a Pro feature. Upgrade your plan to access it.',
      403,
      { upgradeUrl: process.env.UPGRADE_URL ?? '/pricing' },
      ErrorCodes.FORBIDDEN
    ));
  }
  next();
}

// ─── Credit guard (fast read, no transaction) ─────────────────────────────────
// Checks available credits before route handler runs.
// Mirrors creditGuard.middleware.js but inline for feature isolation.

const { db } = require('../../config/firebase');
const COVER_LETTER_CREDIT_COST = 2;

async function creditGuard(req, res, next) {
  try {
    const userId = req.user?.uid;
    const doc    = await db.collection('users').doc(userId).get();

    if (!doc.exists) {
      return next(new AppError('User not found', 404, {}, ErrorCodes.NOT_FOUND));
    }

    const available = doc.data().aiCreditsRemaining ?? 0;

    if (available < COVER_LETTER_CREDIT_COST) {
      return next(new AppError(
        'Insufficient AI credits. Please purchase a new plan to continue.',
        402,
        { creditsRequired: COVER_LETTER_CREDIT_COST, creditsAvailable: available },
        ErrorCodes.PAYMENT_REQUIRED
      ));
    }

    next();
  } catch (err) {
    return next(err);
  }
}

// ─── Quota enforcement (monthly cap for pro users if needed) ──────────────────
// Uses tierQuota middleware from hardening phase.
// Falls back gracefully if not yet installed.

let tierQuotaMiddleware;
try {
  tierQuotaMiddleware = require('../../middleware/tierquota.middleware').tierQuota('cover_letter');
} catch {
  // tierQuota not yet wired — use pass-through
  tierQuotaMiddleware = (req, res, next) => next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post(
  '/generate',
  requirePaidTier,          // 1. Block free users immediately
  tierQuotaMiddleware,      // 2. Monthly cap check (no-op if tierQuota not installed)
  creditGuard,              // 3. Fast credit check
  validateBody(GenerateCoverLetterSchema), // 4. Validate + sanitize body
  generate                  // 5. Controller
);

module.exports = router;