'use strict';

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  resumeSubmitRateLimit,
  globalRequestRateLimit,
  pendingJobLimitMiddleware,
} from '../middleware/rate-limit.middleware.js';

import {
  submitResume,
  getResumeScore,
} from '../controllers/resume.controller.js';

// ── Validation ────────────────────────────────────────────────────────────────
import { resumeSubmitSchema } from '../validations/schemas/resume.schema.js';
import { validate } from '../validations/middleware/validate.js';

export const resumeRouter = Router();

// All resume routes require authentication
resumeRouter.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// PARAM VALIDATION
// FIX: Defined before use — previously declared after the route that referenced
// it, causing a TDZ crash if the file is ever converted to const/arrow style.
// ─────────────────────────────────────────────────────────────────────────────

function validateResumeIdParam(req, res, next) {
  const { resumeId } = req.params;

  const isValid =
    typeof resumeId === 'string' &&
    /^[0-9a-fA-F-]{36}$/.test(resumeId);

  if (!isValid) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid resumeId format',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/resume/submit
// ─────────────────────────────────────────────────────────────────────────────

resumeRouter.post(
  '/submit',
  resumeSubmitRateLimit,
  pendingJobLimitMiddleware,
  resumeSubmitSchema, // ← express-validator chain
  validate,           // ← reject early if invalid
  submitResume,
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/resume/:resumeId/score
// ─────────────────────────────────────────────────────────────────────────────

resumeRouter.get(
  '/:resumeId/score',
  globalRequestRateLimit,
  validateResumeIdParam,
  getResumeScore,
);