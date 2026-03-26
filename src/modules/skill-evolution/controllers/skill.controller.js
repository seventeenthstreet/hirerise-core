'use strict';

/**
 * controllers/skill.controller.js
 *
 * HTTP controller for the Skill Evolution Engine.
 *
 * Routes handled:
 *   GET  /api/v1/education/skills/recommendations/:studentId
 *        → Returns the student's ranked skill recommendation list
 *
 *   GET  /api/v1/education/skills/student-skills/:studentId
 *        → Returns raw per-skill proficiency rows for a student
 */

const logger              = require('../../../utils/logger');
const skillEvolutionSvc   = require('../services/skillEvolution.service');

// ─── GET /api/v1/education/skills/recommendations/:studentId ─────────────────

async function getRecommendations(req, res, next) {
  const { studentId } = req.params;

  // Students may only access their own data (admins may access any)
  if (req.user.uid !== studentId && req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error:   'Access denied: you may only view your own skill recommendations.',
    });
  }

  try {
    const data = await skillEvolutionSvc.getRecommendations(studentId);

    if (!data) {
      return res.status(404).json({
        success: false,
        error:   'Skill recommendations not yet generated. Run the analysis pipeline first.',
      });
    }

    logger.info({ studentId, skillCount: data.skills?.length }, '[SkillCtrl] Recommendations served');

    return res.status(200).json({
      success: true,
      data: {
        skills:             data.skills          ?? [],
        roadmap:            data.roadmap         ?? [],
        top_career:         data.top_career      ?? null,
        recommended_stream: data.recommended_stream ?? null,
        engine_version:     data.engine_version  ?? null,
        calculated_at:      data.calculated_at   ?? null,
      },
    });

  } catch (err) {
    logger.error({ studentId, err: err.message }, '[SkillCtrl] getRecommendations failed');
    next(err);
  }
}

// ─── GET /api/v1/education/skills/student-skills/:studentId ─────────────────

async function getStudentSkills(req, res, next) {
  const { studentId } = req.params;

  if (req.user.uid !== studentId && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Access denied.' });
  }

  try {
    const skills = await skillEvolutionSvc.getStudentSkills(studentId);

    return res.status(200).json({
      success: true,
      data:    { skills },
    });

  } catch (err) {
    logger.error({ studentId, err: err.message }, '[SkillCtrl] getStudentSkills failed');
    next(err);
  }
}

module.exports = {
  getRecommendations,
  getStudentSkills,
};









