'use strict';

/**
 * controllers/university.controller.js
 *
 * Clean, production-ready controller (Supabase-compatible)
 */

const logger = require('../../../utils/logger');
const universityService = require('../services/university.service');
const matchingService = require('../../opportunities/services/studentMatching.service');

// ─── Response Helpers ─────────────────────────────────

function ok(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function fail(res, statusCode, message, code = 'UNIVERSITY_ERROR') {
  return res.status(statusCode).json({
    success: false,
    error: { message, code },
  });
}

// ─── Create University ────────────────────────────────

async function createUniversity(req, res) {
  try {
    const { university_name, country, website } = req.body;

    if (!university_name?.trim()) {
      return fail(res, 400, 'university_name is required.', 'MISSING_NAME');
    }

    const result = await universityService.createUniversity(req.user.uid, {
      university_name,
      country,
      website,
    });

    return ok(res, result, 201);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] createUniversity');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Get My Universities ──────────────────────────────

async function getMyUniversities(req, res) {
  try {
    const result = await universityService.getMyUniversities(req.user.uid);
    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] getMyUniversities');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Get Single University ────────────────────────────

async function getUniversity(req, res) {
  try {
    const { universityId } = req.params;

    const result = await universityService.getUniversity(universityId);
    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] getUniversity');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Create Program ───────────────────────────────────

async function createProgram(req, res) {
  try {
    const { universityId } = req.params;
    const { program_name, degree_type, duration_years, tuition_cost, streams, career_outcomes } = req.body;

    if (!program_name?.trim()) {
      return fail(res, 400, 'program_name is required.', 'MISSING_PROGRAM_NAME');
    }

    const result = await universityService.createProgram(universityId, {
      program_name,
      degree_type,
      duration_years,
      tuition_cost,
      streams,
      career_outcomes,
    });

    return ok(res, result, 201);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] createProgram');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── List Programs ────────────────────────────────────

async function listPrograms(req, res) {
  try {
    const { universityId } = req.params;

    const result = await universityService.listPrograms(universityId);
    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] listPrograms');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Update Program ───────────────────────────────────

async function updateProgram(req, res) {
  try {
    const { universityId, programId } = req.params;

    const result = await universityService.updateProgram(
      universityId,
      programId,
      req.body
    );

    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] updateProgram');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Delete Program ───────────────────────────────────

async function deleteProgram(req, res) {
  try {
    const { universityId, programId } = req.params;

    const result = await universityService.deleteProgram(universityId, programId);
    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] deleteProgram');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Analytics ────────────────────────────────────────

async function getAnalytics(req, res) {
  try {
    const { universityId } = req.params;

    const result = await universityService.getAnalytics(universityId);
    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] getAnalytics');
    return fail(res, err.statusCode || 500, err.message);
  }
}

// ─── Program Matches ──────────────────────────────────

async function getProgramMatches(req, res) {
  try {
    const { programId } = req.params;

    const result = await matchingService.getMatchedStudentsForProgram(programId);
    return ok(res, result);

  } catch (err) {
    logger.error({ err: err.message }, '[UniversityController] getProgramMatches');
    return fail(res, err.statusCode || 500, err.message);
  }
}

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