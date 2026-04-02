'use strict';

/**
 * skillDemand.controller.js — Optimized
 *
 * ✅ asyncHandler applied
 * ✅ Input validation
 * ✅ Limit protection
 * ✅ Timeout protection
 * ✅ Pagination added
 */

const { asyncHandler } = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const { SkillDemandService } = require('../service/skillDemand.service');
const { SkillDemandRepository } = require('../repository/skillDemand.repository');
const logger = require('../utils/logger');

const service = new SkillDemandService();
const repo = new SkillDemandRepository();

// Timeout wrapper
const withTimeout = (promise, ms = 5000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    ),
  ]);

// Helpers
const sanitizeString = (val) =>
  val ? String(val).trim().slice(0, 100) : null;

// ─────────────────────────────────────────────
// CONTROLLER
// ─────────────────────────────────────────────

class SkillDemandController {

  analyzeSkills = asyncHandler(async (req, res) => {
    const { role, skills } = req.body;
    const userId = req.user.uid;

    if (!role) {
      throw new AppError('role is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
    }

    if (!Array.isArray(skills)) {
      throw new AppError('skills must be an array', 400, {}, ErrorCodes.VALIDATION_ERROR);
    }

    if (skills.length > 50) {
      throw new AppError('Maximum 50 skills allowed', 400, {}, ErrorCodes.VALIDATION_ERROR);
    }

    const safeRole = sanitizeString(role);

    logger.info('[SkillDemand] Analyze', {
      userId,
      role: safeRole,
      skillCount: skills.length
    });

    const result = await withTimeout(
      service.analyzeSkillDemand({
        role: safeRole,
        skills
      }),
      7000
    );

    // Non-blocking persistence (with logging)
    repo.saveAnalysis(userId, result).catch(err =>
      logger.warn('[SkillDemand] Persist failed', {
        error: err.message,
        userId
      })
    );

    return res.status(200).json({
      success: true,
      data: {
        skill_score: result.skill_score,
        skill_gaps: result.skill_gaps,
        recommended_skills: result.top_recommended_skills,

        user_skills: result.user_skills,
        required_skills: result.required_skills,
        matched_skills: result.matched_skills,
        top_recommended_skills: result.top_recommended_skills,

        analysis_meta: result.analysis_meta,
      },
    });
  });

  getTopDemandSkills = asyncHandler(async (req, res) => {
    const industry = sanitizeString(req.query.industry);

    let limit = parseInt(req.query.limit || '10', 10);
    limit = Math.min(limit, 50);

    const skills = await service.getTopDemandSkills({ industry, limit });

    return res.status(200).json({
      success: true,
      data: {
        skills,
        total: skills.length,
        industry: industry || 'all',
      },
    });
  });

  getRoleSkills = asyncHandler(async (req, res) => {
    const role = sanitizeString(req.params.role);

    if (!role) {
      throw new AppError(
        'role param is required',
        400,
        {},
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const requiredSkills = await service.getRoleRequiredSkills(role);

    return res.status(200).json({
      success: true,
      data: {
        role,
        required_skills: requiredSkills,
        total: requiredSkills.length,
      },
    });
  });

  getUserHistory = asyncHandler(async (req, res) => {
    const userId = req.user.uid;

    let page  = Math.max(parseInt(req.query.page || '1', 10), 1);
    let limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

    const analyses = await repo.listUserAnalyses(userId, { page, limit });

    return res.status(200).json({
      success: true,
      data: {
        analyses,
        page,
        limit,
        total: analyses.length,
      },
    });
  });
}

module.exports = { SkillDemandController };