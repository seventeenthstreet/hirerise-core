'use strict';

/**
 * controllers/student.controller.js
 *
 * HTTP request handlers for the Education Intelligence module.
 * Thin layer: extract → validate → call service → respond.
 *
 * Never contains business logic or direct Firestore calls.
 * All validation happens before the service is called.
 */

const service   = require('../services/student.service');
const validator = require('../validators/student.validator');
const logger    = require('../../../utils/logger');

// ─── POST /api/v1/education/student ──────────────────────────────────────────

async function createStudent(req, res, next) {
  try {
    const userId = req.user.uid;
    const { name, email, education_level } = req.body;

    validator.validateCreateStudent({ name, email, education_level });

    const result = await service.createStudent(userId, {
      name:            name.trim(),
      email:           email.trim().toLowerCase(),
      education_level,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/v1/education/academics ────────────────────────────────────────

async function saveAcademics(req, res, next) {
  try {
    const userId = req.user.uid;
    const { records } = req.body;

    validator.validateSaveAcademics({ records });

    const result = await service.saveAcademics(userId, records);

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/v1/education/activities ───────────────────────────────────────

async function saveActivities(req, res, next) {
  try {
    const userId = req.user.uid;
    const { activities } = req.body;

    validator.validateSaveActivities({ activities });

    const result = await service.saveActivities(userId, activities);

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/v1/education/cognitive ────────────────────────────────────────

async function saveCognitive(req, res, next) {
  try {
    const userId = req.user.uid;
    const {
      analytical_score,
      logical_score,
      memory_score,
      communication_score,
      creativity_score,
      raw_answers,
    } = req.body;

    const fields = {
      analytical_score,
      logical_score,
      memory_score,
      communication_score,
      creativity_score,
      raw_answers: raw_answers || {},
    };

    validator.validateSaveCognitive(fields);

    const result = await service.saveCognitive(userId, fields);

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/v1/education/student/:id ───────────────────────────────────────

async function getStudentProfile(req, res, next) {
  try {
    const requestingUid = req.user.uid;
    const targetId      = req.params.id;

    validator.validateStudentId(targetId);

    // Students may only fetch their own profile.
    // Admins (req.user.admin === true) may fetch any profile.
    if (requestingUid !== targetId && !req.user.admin) {
      return res.status(403).json({
        success:   false,
        errorCode: 'FORBIDDEN',
        message:   'You may only access your own education profile.',
      });
    }

    const result = await service.getStudentProfile(targetId);

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createStudent,
  saveAcademics,
  saveActivities,
  saveCognitive,
  getStudentProfile,
};









