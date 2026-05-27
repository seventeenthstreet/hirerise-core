'use strict';

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  salaryRequestRateLimit,
  globalRequestRateLimit,
  pendingJobLimitMiddleware,
} from '../middleware/rate-limit.middleware.js';

import {
  requestSalaryBenchmark,
  getSalaryResult,
} from '../controllers/salary.controller.js';

// ── Validation ────────────────────────────────────────────────────────────────
import { salaryBenchmarkSchema } from '../validations/schemas/salary.schema.js';
import { validate } from '../validations/middleware/validate.js';

export const salaryRouter = Router();

// All salary routes require authentication
salaryRouter.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/salary/benchmark
// ─────────────────────────────────────────────────────────────────────────────

salaryRouter.post(
  '/benchmark',
  salaryRequestRateLimit,
  pendingJobLimitMiddleware,
  salaryBenchmarkSchema,  // ← express-validator chain
  validate,               // ← reject early if invalid
  requestSalaryBenchmark,
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/salary/:jobId/result
// ─────────────────────────────────────────────────────────────────────────────

salaryRouter.get(
  '/:jobId/result',
  globalRequestRateLimit,
  validateJobIdParam,
  getSalaryResult,
);

// ─────────────────────────────────────────────────────────────────────────────
// PARAM VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

function validateJobIdParam(req, res, next) {
  const { jobId } = req.params;

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