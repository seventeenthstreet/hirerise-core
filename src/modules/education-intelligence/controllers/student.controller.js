'use strict';

/**
 * controllers/student.controller.js
 *
 * HTTP request handlers for the Education Intelligence module.
 * Thin layer: extract → validate → call service → respond.
 *
 * No business logic.
 * No direct database access.
 * Fully compatible with Supabase auth middleware.
 */

const service = require('../services/student.service');
const validator = require('../validators/student.validator');
const logger = require('../../../utils/logger');

function getAuthenticatedUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

function isAdmin(req) {
  return req.user?.admin === true;
}

// ─── POST /api/v1/education/student ──────────────────────────────────────────

async function createStudent(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { name, email, education_level } = req.body;

    validator.validateCreateStudent({
      name,
      email,
      education_level
    });

    const result = await service.createStudent(userId, {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      education_level
    });

    return res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      '[StudentController] Create student failed'
    );

    return next(error);
  }
}

// ─── POST /api/v1/education/academics ────────────────────────────────────────

async function saveAcademics(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { records } = req.body;

    validator.validateSaveAcademics({ records });

    const result = await service.saveAcademics(userId, records);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      '[StudentController] Save academics failed'
    );

    return next(error);
  }
}

// ─── POST /api/v1/education/activities ───────────────────────────────────────

async function saveActivities(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { activities } = req.body;

    validator.validateSaveActivities({ activities });

    const result = await service.saveActivities(userId, activities);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      '[StudentController] Save activities failed'
    );

    return next(error);
  }
}

// ─── POST /api/v1/education/cognitive ────────────────────────────────────────

async function saveCognitive(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);
    const {
      analytical_score,
      logical_score,
      memory_score,
      communication_score,
      creativity_score,
      raw_answers
    } = req.body;

    const fields = {
      analytical_score,
      logical_score,
      memory_score,
      communication_score,
      creativity_score,
      raw_answers: raw_answers || {}
    };

    validator.validateSaveCognitive(fields);

    const result = await service.saveCognitive(userId, fields);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      '[StudentController] Save cognitive failed'
    );

    return next(error);
  }
}

// ─── GET /api/v1/education/student/:id ───────────────────────────────────────

async function getStudentProfile(req, res, next) {
  try {
    const requestingUserId = getAuthenticatedUserId(req);
    const targetId = req.params?.id;

    validator.validateStudentId(targetId);

    if (requestingUserId !== targetId && !isAdmin(req)) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN',
        message: 'You may only access your own education profile.'
      });
    }

    const result = await service.getStudentProfile(targetId);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(
      {
        targetId: req.params?.id,
        error: error.message
      },
      '[StudentController] Get profile failed'
    );

    return next(error);
  }
}

module.exports = {
  createStudent,
  saveAcademics,
  saveActivities,
  saveCognitive,
  getStudentProfile
};