/**
 * api-service/src/routes/career.routes.js
 *
 * Routes:
 *   POST /v1/career/path          — Request career path analysis
 *   GET  /v1/career/:jobId/result — Poll for career result
 */

import { Router } from 'express';
import { authenticate }          from '../middleware/auth.middleware.js';
import { careerRequestRateLimit } from '../middleware/rate-limit.middleware.js';
import {
  requestCareerPath,
  getCareerResult,
} from '../controllers/career.controller.js';

export const careerRouter = Router();

// All career routes require authentication
careerRouter.use(authenticate);

// POST /v1/career/path
careerRouter.post(
  '/path',
  careerRequestRateLimit,
  requestCareerPath,
);

// GET /v1/career/:jobId/result
careerRouter.get(
  '/:jobId/result',
  getCareerResult,
);