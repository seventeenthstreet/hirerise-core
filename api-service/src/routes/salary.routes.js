/**
 * api-service/src/routes/salary.routes.js
 *
 * Routes:
 *   POST /v1/salary/benchmark      — Request salary benchmark
 *   GET  /v1/salary/:jobId/result  — Poll for salary result
 */

import { Router } from 'express';
import { authenticate }           from '../middleware/auth.middleware.js';
import { salaryRequestRateLimit } from '../middleware/rate-limit.middleware.js';
import {
  requestSalaryBenchmark,
  getSalaryResult,
} from '../controllers/salary.controller.js';

export const salaryRouter = Router();

// All salary routes require authentication
salaryRouter.use(authenticate);

// POST /v1/salary/benchmark
salaryRouter.post(
  '/benchmark',
  salaryRequestRateLimit,
  requestSalaryBenchmark,
);

// GET /v1/salary/:jobId/result
salaryRouter.get(
  '/:jobId/result',
  getSalaryResult,
);