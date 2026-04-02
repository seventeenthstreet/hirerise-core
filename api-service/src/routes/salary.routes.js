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