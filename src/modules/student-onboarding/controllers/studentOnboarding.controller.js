'use strict';

/**
 * src/modules/student-onboarding/controllers/studentOnboarding.controller.js
 *
 * Thin controller layer. Contains no business logic, no DB calls.
 * Responsibility: extract input → call service → shape response.
 *
 * getUserId() follows the same pattern as the existing onboarding module
 * and the existing student-onboarding.routes.js (req.user.id → uid fallback).
 */

const sessionService   = require('../services/session.service');
const educationService = require('../services/education.service');
const logger           = require('../../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the authenticated user_id from req.user.
 * Matches the multi-alias pattern in auth.middleware.js:
 *   req.user.id (primary) → req.user.sub → req.user.uid (legacy).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getUserId(req) {
  const userId = req.user?.id ?? req.user?.sub ?? req.user?.uid;

  if (!userId || typeof userId !== 'string') {
    // This should never happen — auth middleware guarantees req.user.
    // If it does, it is a server configuration error, not a client error.
    const err = new Error('user_id unavailable after auth middleware');
    err.status = 500;
    err.code   = 'INTERNAL_ERROR';
    throw err;
  }

  return userId;
}

/**
 * Maps service errors → normalised HTTP responses.
 * Keeps controllers free of error-handling conditionals.
 *
 * @param {Error}                       err
 * @param {import('express').Response}  res
 * @param {string}                      context  For log context only
 */
function handleServiceError(err, res, context) {
  logger.error(
    { context, code: err.code, status: err.status, err: err.message },
    '[OnboardingController] service error',
  );

  const status = Number.isInteger(err.status) && err.status >= 400
    ? err.status
    : 500;

  return res.status(status).json({
    ok:    false,
    error: err.message ?? 'An unexpected error occurred.',
    code:  err.code    ?? 'INTERNAL_ERROR',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /student-onboarding/session
// Creates a new session or resumes an existing one.
// Returns 201 on creation, 200 on resume.
// ─────────────────────────────────────────────────────────────────────────────

async function createOrResumeSession(req, res) {
  let userId;
  try {
    userId = getUserId(req);
  } catch (err) {
    return handleServiceError(err, res, 'createOrResumeSession:getUserId');
  }

  try {
    const { session, created } = await sessionService.createOrResume(userId);

    return res.status(created ? 201 : 200).json({
      ok:      true,
      created,
      session,
    });
  } catch (err) {
    return handleServiceError(err, res, 'createOrResumeSession');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /student-onboarding/session
// Returns the current onboarding state for the authenticated user.
// ─────────────────────────────────────────────────────────────────────────────

async function getSession(req, res) {
  let userId;
  try {
    userId = getUserId(req);
  } catch (err) {
    return handleServiceError(err, res, 'getSession:getUserId');
  }

  try {
    const session = await sessionService.getSession(userId);
    return res.status(200).json({ ok: true, session });
  } catch (err) {
    return handleServiceError(err, res, 'getSession');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /student-onboarding/step/education
// Validates, saves education profile, advances session to 'academics'.
// ─────────────────────────────────────────────────────────────────────────────

async function saveEducation(req, res) {
  let userId;
  try {
    userId = getUserId(req);
  } catch (err) {
    return handleServiceError(err, res, 'saveEducation:getUserId');
  }

  const {
    education_level,
    board_type  = null,
    school_type = null,
  } = req.body;

  try {
    const result = await educationService.upsertEducationProfile(userId, {
      education_level,
      board_type,
      school_type,
    });

    return res.status(200).json({
      ok:        true,
      next_step: result.next_step,
      session:   result.session,
    });
  } catch (err) {
    return handleServiceError(err, res, 'saveEducation');
  }
}

module.exports = {
  createOrResumeSession,
  getSession,
  saveEducation,
};
