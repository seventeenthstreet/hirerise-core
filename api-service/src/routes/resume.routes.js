/**
 * api-service/src/routes/resume.routes.js
 *
 * Routes:
 *   POST /v1/resume/submit        — Submit resume for AI scoring
 *   GET  /v1/resume/:resumeId/score — Poll for score result
 */

import { Router } from 'express';
import { authenticate }          from '../middleware/auth.middleware.js';
import { resumeSubmitRateLimit } from '../middleware/rate-limit.middleware.js';
import {
  submitResume,
  getResumeScore,
} from '../controllers/resume.controller.js';

export const resumeRouter = Router();

// All resume routes require authentication
resumeRouter.use(authenticate);

// POST /v1/resume/submit
resumeRouter.post(
  '/submit',
  resumeSubmitRateLimit,
  submitResume,
);

// GET /v1/resume/:resumeId/score
resumeRouter.get(
  '/:resumeId/score',
  getResumeScore,
);