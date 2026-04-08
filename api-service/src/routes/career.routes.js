'use strict';

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  careerRequestRateLimit,
  globalRequestRateLimit,
  pendingJobLimitMiddleware,
} from '../middleware/rate-limit.middleware.js';

import {
  requestCareerPath,
  getCareerResult,
} from '../controllers/career.controller.js';

export const careerRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Strict RFC4122 UUID v4 validation
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL AUTH
// ─────────────────────────────────────────────────────────────────────────────

// All career routes require authenticated Supabase user context
careerRouter.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/career/path
// Creates async career analysis job
// ─────────────────────────────────────────────────────────────────────────────

careerRouter.post(
  '/path',
  careerRequestRateLimit,
  pendingJobLimitMiddleware,
  requestCareerPath,
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/career/:jobId/result
// Fetch completed async career analysis result
// ─────────────────────────────────────────────────────────────────────────────

careerRouter.get(
  '/:jobId/result',
  globalRequestRateLimit, // protects against polling abuse
  validateJobIdParam,
  getCareerResult,
);

// ─────────────────────────────────────────────────────────────────────────────
// PARAM VALIDATION MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

export function validateJobIdParam(req, res, next) {
  const jobId = req.params?.jobId;

  if (typeof jobId !== 'string' || !UUID_V4_REGEX.test(jobId)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid jobId format',
      requestId: req.requestId ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  return next();
}