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

// All career routes require authentication
careerRouter.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/career/path
// ─────────────────────────────────────────────────────────────────────────────

careerRouter.post(
  '/path',
  careerRequestRateLimit,
  pendingJobLimitMiddleware,
  requestCareerPath,
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/career/:jobId/result
// ─────────────────────────────────────────────────────────────────────────────

careerRouter.get(
  '/:jobId/result',
  globalRequestRateLimit, // Prevent polling abuse
  validateJobIdParam,
  getCareerResult,
);

// ─────────────────────────────────────────────────────────────────────────────
// PARAM VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

function validateJobIdParam(req, res, next) {
  const { jobId } = req.params;

  // Basic UUID v4 check
  const isValid =
    typeof jobId === 'string' &&
    /^[0-9a-fA-F-]{36}$/.test(jobId);

  if (!isValid) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid jobId format',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }

  next();
}