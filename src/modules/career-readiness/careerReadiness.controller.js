"use strict";

/**
 * src/modules/career-readiness/controllers/careerReadiness.controller.js
 *
 * Production-grade controller:
 * - Express-safe async flow
 * - dependency injection validation
 * - consistent API responses
 * - structured validation handling
 * - resilient request body parsing
 */

const logger = require("../../utils/logger");
const { ValidationError } = require("./careerReadiness.validator");

class CareerReadinessController {
  constructor({ careerReadinessService }) {
    if (!careerReadinessService) {
      throw new Error(
        "[CareerReadinessController] Missing required dependency: careerReadinessService"
      );
    }

    this.service = careerReadinessService;
    this.computeReadiness = this.computeReadiness.bind(this);
  }

  /**
   * POST /career-readiness/compute
   */
  async computeReadiness(req, res, next) {
    try {
      const body = req?.body ?? {};
      const profile = body.profile ?? null;
      const resumeData = body.resumeData ?? null;

      const result = await this.service.computeReadiness(
        profile,
        resumeData
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        logger.warn("[CareerReadinessController] Validation failed", {
          error: err.message,
          details: err.details ?? null,
          route: req?.originalUrl ?? null,
          method: req?.method ?? null,
        });

        return res.status(422).json({
          success: false,
          error: err.message,
          details: err.details ?? null,
        });
      }

      logger.error("[CareerReadinessController] Unexpected failure", {
        error: err?.message ?? "Unknown controller error",
        route: req?.originalUrl ?? null,
        method: req?.method ?? null,
      });

      return next(err);
    }
  }
}

module.exports = CareerReadinessController;