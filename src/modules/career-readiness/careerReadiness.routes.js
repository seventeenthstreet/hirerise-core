'use strict';

/**
 * careerReadiness.routes.js
 *
 * Mounted at: /api/v1/career-readiness  (via server.js)
 * Auth:       authenticate applied upstream in server.js — not repeated here.
 */

const { Router } = require('express');

const CareerReadinessController = require('./careerReadiness.controller');
const CareerReadinessService    = require('./careerReadiness.service');

// ── External service dependencies ─────────────────────────────────────────────
const salaryService          = require('../../services/salary.service');
const { computeGapAnalysis } = require('../../services/skillGap.service');
const resumeScoreService     = require('../../services/resumeScore.service');
const careerRoleGraph        = require('../../data/career-graph/software_engineering/se_1.json');

// ── Dependency injection ──────────────────────────────────────────────────────
const service = new CareerReadinessService({
  salaryService,
  skillIntelligenceService: { computeGapAnalysis }, // adapter — matches DeterministicEngine interface
  resumeScoreService,
  careerRoleGraph,           // SE role graph — drives role-graph-dependent scoring
  scoreRepository:  null,   // optional — no dedicated score repo yet
});

const controller = new CareerReadinessController({
  careerReadinessService: service,
});

const router = Router();

// POST /api/v1/career-readiness/compute
// Body: { profile: CandidateProfile, resumeData?: object }
router.post('/compute', controller.computeReadiness);

module.exports = router;








