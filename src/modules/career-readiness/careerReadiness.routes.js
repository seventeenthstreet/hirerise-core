"use strict";

/**
 * src/modules/career-readiness/careerReadiness.routes.js
 *
 * Mounted at: /api/v1/career-readiness
 * Auth middleware is applied upstream in server.js
 *
 * Production-grade improvements:
 * - Firebase-clean architecture
 * - safer dependency composition
 * - route boot resilience
 * - lazy-safe JSON loading
 * - improved testability
 */

const { Router } = require("express");
const path = require("path");

const logger = require("../../utils/logger");

const CareerReadinessController = require("./careerReadiness.controller");
const CareerReadinessService = require("./careerReadiness.service");

// External dependencies
const salaryService = require("../../services/salary.service");
const { computeGapAnalysis } = require("../../services/skillGap.service");
const resumeScoreService = require("../../services/resumeScore.service");

function loadCareerRoleGraph() {
  try {
    const graphPath = path.join(
      __dirname,
      "../../data/career-graph/software_engineering/se_1.json"
    );

    return require(graphPath);
  } catch (error) {
    logger.error("[CareerReadinessRoutes] Failed to load role graph", {
      error: error?.message ?? "Unknown graph load error",
    });

    /**
     * Fail safe:
     * keep API available even if graph asset is temporarily unavailable
     */
    return {};
  }
}

function createCareerReadinessRouter() {
  const router = Router();

  const careerRoleGraph = loadCareerRoleGraph();

  const service = new CareerReadinessService({
    salaryService,
    skillIntelligenceService: {
      computeGapAnalysis,
    },
    resumeScoreService,
    careerRoleGraph,
    scoreRepository: null,
  });

  const controller = new CareerReadinessController({
    careerReadinessService: service,
  });

  /**
   * POST /api/v1/career-readiness/compute
   * Body: { profile: CandidateProfile, resumeData?: object }
   */
  router.post("/compute", controller.computeReadiness);

  return router;
}

module.exports = createCareerReadinessRouter();