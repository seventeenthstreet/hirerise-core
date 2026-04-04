'use strict';

/**
 * src/modules/skill-evolution/controllers/skill.controller.js
 *
 * HTTP controller for the Skill Evolution Engine.
 *
 * Routes handled:
 *   GET /api/v1/education/skills/recommendations/:studentId
 *     → Returns ranked skill recommendations
 *
 *   GET /api/v1/education/skills/student-skills/:studentId
 *     → Returns raw per-skill proficiency rows
 *
 * Supabase Migration Notes:
 * - Removes Firebase-era auth assumptions
 * - Supports normalized req.user.id with backward compatibility
 * - Hardened null safety + request validation
 * - Consistent structured logging
 * - Cleaner controller composition
 */

const logger = require('../../../utils/logger');
const skillEvolutionSvc = require('../services/skillEvolution.service');

/**
 * Extract authenticated user id safely.
 * Supports legacy uid during migration rollout.
 *
 * @param {object} req
 * @returns {string|null}
 */
function getAuthenticatedUserId(req) {
  return req?.user?.id || req?.user?.uid || null;
}

/**
 * Centralized authorization guard.
 *
 * Students may only access their own data.
 * Admins may access any student's data.
 *
 * @param {object} req
 * @param {string} studentId
 * @returns {boolean}
 */
function canAccessStudent(req, studentId) {
  const authUserId = getAuthenticatedUserId(req);
  const role = req?.user?.role;

  return role === 'admin' || authUserId === studentId;
}

/**
 * Validate required studentId route param.
 *
 * @param {string} studentId
 * @returns {boolean}
 */
function isValidStudentId(studentId) {
  return typeof studentId === 'string' && studentId.trim().length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/education/skills/recommendations/:studentId
// ─────────────────────────────────────────────────────────────────────────────

async function getRecommendations(req, res, next) {
  const studentId = req?.params?.studentId;

  try {
    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid studentId.',
      });
    }

    if (!canAccessStudent(req, studentId)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied: you may only view your own skill recommendations.',
      });
    }

    const data = await skillEvolutionSvc.getRecommendations(studentId);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Skill recommendations not yet generated. Run the analysis pipeline first.',
      });
    }

    const responsePayload = {
      skills: Array.isArray(data.skills) ? data.skills : [],
      roadmap: Array.isArray(data.roadmap) ? data.roadmap : [],
      top_career: data.top_career ?? null,
      recommended_stream: data.recommended_stream ?? null,
      engine_version: data.engine_version ?? null,
      calculated_at: data.calculated_at ?? null,
    };

    logger.info(
      {
        controller: 'skill.controller',
        action: 'getRecommendations',
        studentId,
        skillCount: responsePayload.skills.length,
      },
      '[SkillCtrl] Recommendations served'
    );

    return res.status(200).json({
      success: true,
      data: responsePayload,
    });
  } catch (err) {
    logger.error(
      {
        controller: 'skill.controller',
        action: 'getRecommendations',
        studentId,
        error: err.message,
        stack: err.stack,
      },
      '[SkillCtrl] getRecommendations failed'
    );

    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/education/skills/student-skills/:studentId
// ─────────────────────────────────────────────────────────────────────────────

async function getStudentSkills(req, res, next) {
  const studentId = req?.params?.studentId;

  try {
    if (!isValidStudentId(studentId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid studentId.',
      });
    }

    if (!canAccessStudent(req, studentId)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied.',
      });
    }

    const skills = await skillEvolutionSvc.getStudentSkills(studentId);

    const safeSkills = Array.isArray(skills) ? skills : [];

    logger.info(
      {
        controller: 'skill.controller',
        action: 'getStudentSkills',
        studentId,
        rowCount: safeSkills.length,
      },
      '[SkillCtrl] Student skills served'
    );

    return res.status(200).json({
      success: true,
      data: {
        skills: safeSkills,
      },
    });
  } catch (err) {
    logger.error(
      {
        controller: 'skill.controller',
        action: 'getStudentSkills',
        studentId,
        error: err.message,
        stack: err.stack,
      },
      '[SkillCtrl] getStudentSkills failed'
    );

    return next(err);
  }
}

module.exports = {
  getRecommendations,
  getStudentSkills,
};