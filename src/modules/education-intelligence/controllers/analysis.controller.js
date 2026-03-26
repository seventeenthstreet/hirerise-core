'use strict';

/**
 * controllers/analysis.controller.js
 *
 * HTTP handlers for the Education Intelligence analysis endpoints.
 * Thin layer: extract → validate → call service → respond.
 *
 * Endpoints handled:
 *   POST  /api/v1/education/analyze/:studentId  → run full AI pipeline
 *   GET   /api/v1/education/analyze/:studentId  → return cached result
 */

const analysisService = require('../services/analysis.service');
const logger          = require('../../../utils/logger');

// ─── POST /api/v1/education/analyze/:studentId ────────────────────────────────

/**
 * Runs the full AI engine pipeline for the given student.
 *
 * Auth rules:
 *   - A student may only trigger analysis for their own profile.
 *   - An admin (req.user.admin === true) may trigger analysis for any student.
 *
 * Query params:
 *   ?requireComplete=true  — rejects if student has not finished all onboarding steps.
 *                            Defaults to false so admins can run partial analysis.
 */
async function analyzeStudentProfile(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId     = req.params.studentId;
    const requireComplete = req.query.requireComplete !== 'false';

    // ── Auth guard ───────────────────────────────────────────────────────
    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   'You may only trigger analysis for your own profile.',
      });
    }

    // ── Input guard ──────────────────────────────────────────────────────
    if (!studentId || typeof studentId !== 'string' || studentId.trim().length === 0) {
      return res.status(400).json({
        success:   false,
        errorCode: 'INVALID_STUDENT_ID',
        message:   'studentId path parameter must be a non-empty string.',
      });
    }

    logger.info({ studentId, requestingUid }, '[AnalysisController] Analysis requested');

    const result = await analysisService.runAnalysis(studentId, { requireComplete });

    return res.status(200).json({
      success: true,
      data:    result,
    });

  } catch (err) {
    next(err);
  }
}

// ─── GET /api/v1/education/analyze/:studentId ─────────────────────────────────

/**
 * Returns the most recently cached stream analysis result.
 * Does NOT re-run the pipeline.
 * Returns HTTP 404 if no analysis has been run yet.
 */
async function getAnalysisResult(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const studentId     = req.params.studentId;

    if (requestingUid !== studentId && !req.user.admin) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   'You may only view your own analysis results.',
      });
    }

    const result = await analysisService.getAnalysisResult(studentId);

    if (!result) {
      return res.status(404).json({
        success:   false,
        errorCode: 'ANALYSIS_NOT_FOUND',
        message:   'No analysis results found. Submit the onboarding form to generate your stream recommendation.',
      });
    }

    return res.status(200).json({
      success: true,
      data:    result,
    });

  } catch (err) {
    next(err);
  }
}

module.exports = {
  analyzeStudentProfile,
  getAnalysisResult,
};








