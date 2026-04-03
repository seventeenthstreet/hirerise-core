'use strict';

/**
 * controllers/analysis.controller.js
 *
 * HTTP handlers for Education Intelligence analysis endpoints.
 *
 * Responsibilities:
 * - auth + ownership guard
 * - input validation
 * - service orchestration
 * - consistent HTTP responses
 * - structured logging
 */

const analysisService = require('../services/analysis.service');
const logger = require('../../../utils/logger');

function getAuthenticatedUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

function isAdmin(req) {
  return req.user?.admin === true;
}

function isValidStudentId(studentId) {
  return (
    typeof studentId === 'string' &&
    studentId.trim().length > 0
  );
}

function parseRequireComplete(queryValue) {
  return queryValue !== 'false';
}

/**
 * POST /api/v1/education/analyze/:studentId
 *
 * Runs the full AI pipeline for a student.
 */
async function analyzeStudentProfile(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const studentId = req.params?.studentId;
    const requireComplete = parseRequireComplete(
      req.query?.requireComplete
    );

    // ── Input validation ─────────────────────────────────────────────
    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_STUDENT_ID',
        message: 'studentId path parameter must be a non-empty string.'
      });
    }

    // ── Auth guard ──────────────────────────────────────────────────
    if (requestingUserId !== studentId && !isAdmin(req)) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only trigger analysis for your own profile.'
      });
    }

    logger.info(
      {
        studentId,
        requestingUserId,
        requireComplete
      },
      '[AnalysisController] Analysis requested'
    );

    const result = await analysisService.runAnalysis(studentId, {
      requireComplete
    });

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[AnalysisController] Analysis failed'
    );

    return next(error);
  }
}

/**
 * GET /api/v1/education/analyze/:studentId
 *
 * Returns cached analysis result.
 */
async function getAnalysisResult(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const studentId = req.params?.studentId;

    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_STUDENT_ID',
        message: 'studentId path parameter must be a non-empty string.'
      });
    }

    if (requestingUserId !== studentId && !isAdmin(req)) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only view your own analysis results.'
      });
    }

    const result = await analysisService.getAnalysisResult(studentId);

    if (!result) {
      return res.status(404).json({
        success: false,
        errorCode: 'ANALYSIS_NOT_FOUND',
        message:
          'No analysis results found. Submit the onboarding form to generate your stream recommendation.'
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      {
        studentId: req.params?.studentId,
        error: error.message
      },
      '[AnalysisController] Fetch cached analysis failed'
    );

    return next(error);
  }
}

module.exports = {
  analyzeStudentProfile,
  getAnalysisResult
};