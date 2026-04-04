'use strict';

/**
 * src/modules/university/controllers/university.controller.js
 *
 * Production-ready University Controller
 * Fully Firebase-free
 * Optimized for Supabase + JWT middleware compatibility
 */

const logger = require('../../../utils/logger');
const universityService = require('../services/university.service');
const matchingService = require('../../opportunities/services/studentMatching.service');

// ─────────────────────────────────────────────────────────────
// Response Helpers
// ─────────────────────────────────────────────────────────────

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function fail(res, statusCode, message, code = 'UNIVERSITY_ERROR', details = null) {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code,
      ...(details ? { details } : {}),
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Auth Helper (Supabase-safe)
// Removes Firebase `req.user.uid` legacy assumption
// ─────────────────────────────────────────────────────────────

function getAuthenticatedUserId(req) {
  return (
    req.user?.id ||
    req.user?.uid || // backward compatibility during rollout
    req.user?.user_id ||
    req.auth?.userId ||
    null
  );
}

// ─────────────────────────────────────────────────────────────
// Error Handler Wrapper
// Reduces duplicated try/catch blocks
// ─────────────────────────────────────────────────────────────

function withErrorHandling(handler, context) {
  return async function wrappedHandler(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      logger.error(
        {
          context,
          message: err.message,
          stack: err.stack,
          statusCode: err.statusCode,
        },
        `[UniversityController] ${context}`
      );

      return fail(
        res,
        err.statusCode || 500,
        err.message || 'Internal server error',
        err.code || 'UNIVERSITY_ERROR'
      );
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Create University
// ─────────────────────────────────────────────────────────────

const createUniversity = withErrorHandling(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  }

  const { university_name, country, website } = req.body;

  if (!university_name?.trim()) {
    return fail(res, 400, 'university_name is required.', 'MISSING_NAME');
  }

  const result = await universityService.createUniversity(userId, {
    university_name: university_name.trim(),
    country: country?.trim?.() || null,
    website: website?.trim?.() || null,
  });

  return ok(res, result, 201);
}, 'createUniversity');

// ─────────────────────────────────────────────────────────────
// Get My Universities
// ─────────────────────────────────────────────────────────────

const getMyUniversities = withErrorHandling(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  if (!userId) {
    return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  }

  const result = await universityService.getMyUniversities(userId);
  return ok(res, result);
}, 'getMyUniversities');

// ─────────────────────────────────────────────────────────────
// Get Single University
// ─────────────────────────────────────────────────────────────

const getUniversity = withErrorHandling(async (req, res) => {
  const { universityId } = req.params;
  const result = await universityService.getUniversity(universityId);
  return ok(res, result);
}, 'getUniversity');

// ─────────────────────────────────────────────────────────────
// Create Program
// ─────────────────────────────────────────────────────────────

const createProgram = withErrorHandling(async (req, res) => {
  const { universityId } = req.params;
  const {
    program_name,
    degree_type,
    duration_years,
    tuition_cost,
    streams,
    career_outcomes,
  } = req.body;

  if (!program_name?.trim()) {
    return fail(res, 400, 'program_name is required.', 'MISSING_PROGRAM_NAME');
  }

  const result = await universityService.createProgram(universityId, {
    program_name: program_name.trim(),
    degree_type: degree_type?.trim?.() || null,
    duration_years: duration_years ?? null,
    tuition_cost: tuition_cost ?? null,
    streams: Array.isArray(streams) ? streams : [],
    career_outcomes: Array.isArray(career_outcomes) ? career_outcomes : [],
  });

  return ok(res, result, 201);
}, 'createProgram');

// ─────────────────────────────────────────────────────────────
// List Programs
// ─────────────────────────────────────────────────────────────

const listPrograms = withErrorHandling(async (req, res) => {
  const { universityId } = req.params;
  const result = await universityService.listPrograms(universityId);
  return ok(res, result);
}, 'listPrograms');

// ─────────────────────────────────────────────────────────────
// Update Program
// ─────────────────────────────────────────────────────────────

const updateProgram = withErrorHandling(async (req, res) => {
  const { universityId, programId } = req.params;

  const result = await universityService.updateProgram(
    universityId,
    programId,
    req.body
  );

  return ok(res, result);
}, 'updateProgram');

// ─────────────────────────────────────────────────────────────
// Delete Program
// ─────────────────────────────────────────────────────────────

const deleteProgram = withErrorHandling(async (req, res) => {
  const { universityId, programId } = req.params;

  const result = await universityService.deleteProgram(universityId, programId);
  return ok(res, result);
}, 'deleteProgram');

// ─────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────

const getAnalytics = withErrorHandling(async (req, res) => {
  const { universityId } = req.params;
  const result = await universityService.getAnalytics(universityId);
  return ok(res, result);
}, 'getAnalytics');

// ─────────────────────────────────────────────────────────────
// Program Matches
// ─────────────────────────────────────────────────────────────

const getProgramMatches = withErrorHandling(async (req, res) => {
  const { programId } = req.params;
  const result = await matchingService.getMatchedStudentsForProgram(programId);
  return ok(res, result);
}, 'getProgramMatches');

module.exports = {
  createUniversity,
  getMyUniversities,
  getUniversity,
  createProgram,
  listPrograms,
  updateProgram,
  deleteProgram,
  getAnalytics,
  getProgramMatches,
};