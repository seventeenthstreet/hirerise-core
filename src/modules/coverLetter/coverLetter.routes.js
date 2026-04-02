'use strict';

/**
 * coverLetter.routes.js
 *
 * Production-grade routing layer for cover letter generation.
 *
 * Responsibilities:
 * - request validation
 * - paid-tier enforcement
 * - credit availability guard
 * - quota middleware composition
 * - controller delegation
 */

const express = require('express');
const { z } = require('zod');

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { generate } = require('./controllers/coverLetter.controller');
const { supabase } = require('../../config/supabase');

const router = express.Router();

const COVER_LETTER_CREDIT_COST = 2;

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const GenerateCoverLetterSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().min(1).max(200),
  jobDescription: z.string().trim().min(50).max(3500),
  tone: z
    .enum([
      'professional',
      'confident',
      'conversational',
      'formal',
    ])
    .optional()
    .default('professional'),
}).strict();

/**
 * Request body validator middleware.
 *
 * @param {z.ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      return next(
        new AppError(
          'Request validation failed',
          400,
          { fields },
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    req.body = parsed.data;
    return next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────

function requirePaidTier(req, res, next) {
  const tier = req.user?.plan ?? 'free';

  if (tier === 'free') {
    return next(
      new AppError(
        'Cover letter generation is a Pro feature. Upgrade your plan to access it.',
        403,
        {
          upgradeUrl: process.env.UPGRADE_URL ?? '/pricing',
        },
        ErrorCodes.FORBIDDEN
      )
    );
  }

  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT GUARD
// ─────────────────────────────────────────────────────────────────────────────

async function creditGuard(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return next(
        new AppError(
          'Unauthorized',
          401,
          {},
          ErrorCodes.UNAUTHORIZED
        )
      );
    }

    const { data, error } = await supabase
      .from('users')
      .select('ai_credits_remaining')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      return next(
        new AppError(
          'Failed to fetch user credits',
          500,
          { error: error.message },
          ErrorCodes.DB_ERROR
        )
      );
    }

    if (!data) {
      return next(
        new AppError(
          'User not found',
          404,
          {},
          ErrorCodes.NOT_FOUND
        )
      );
    }

    const availableCredits = Number(data.ai_credits_remaining ?? 0);

    if (availableCredits < COVER_LETTER_CREDIT_COST) {
      return next(
        new AppError(
          'Insufficient AI credits. Please purchase a new plan to continue.',
          402,
          {
            creditsRequired: COVER_LETTER_CREDIT_COST,
            creditsAvailable: availableCredits,
          },
          ErrorCodes.PAYMENT_REQUIRED
        )
      );
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL TIER QUOTA MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

let tierQuotaMiddleware = (req, res, next) => next();

try {
  const tierQuotaModule = require('../../middleware/tierquota.middleware');
  if (typeof tierQuotaModule?.tierQuota === 'function') {
    tierQuotaMiddleware = tierQuotaModule.tierQuota('cover_letter');
  }
} catch {
  // Safe no-op fallback for environments without quota middleware
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/generate',
  validateBody(GenerateCoverLetterSchema),
  requirePaidTier,
  tierQuotaMiddleware,
  creditGuard,
  generate
);

module.exports = router;