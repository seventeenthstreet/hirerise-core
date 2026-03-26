'use strict';

/**
 * skillDemand.controller.js — HTTP handlers for the Skill Demand Intelligence API
 *
 * SECURITY CONTRACT:
 *   - userId always sourced from req.user.uid (auth token) — never from body
 *   - Input validated by express-validator before reaching handlers
 *   - No sensitive data (credentials, internal IDs) in responses
 *
 * Handlers:
 *   analyzeSkills      POST /api/v1/skills/analyze
 *   getTopDemandSkills GET  /api/v1/skills/demand/top
 *   getRoleSkills      GET  /api/v1/skills/demand/role/:role
 *   getUserHistory     GET  /api/v1/skills/demand/history
 *
 * @module modules/skillDemand/controller/skillDemand.controller
 */

const { SkillDemandService }    = require('../service/skillDemand.service');
const { SkillDemandRepository } = require('../repository/skillDemand.repository');
const logger = require('../../../utils/logger');

const service = new SkillDemandService();
const repo    = new SkillDemandRepository();

class SkillDemandController {

  /**
   * POST /api/v1/skills/analyze
   *
   * Main skill demand analysis endpoint.
   *
   * Request body: { role: string, skills: string[] }
   *
   * Response:
   * {
   *   skill_score: number,
   *   skill_gaps: string[],
   *   recommended_skills: [{ skill, demand_score, salary_boost, growth_rate, composite_score }],
   *   // full detail fields also included
   * }
   */
  async analyzeSkills(req, res, next) {
    try {
      const { role, skills } = req.body;
      const userId = req.user.uid;

      logger.info('[SkillDemandCtrl] Analyze request', { userId, role, skillCount: skills?.length });

      // Run analysis
      const result = await service.analyzeSkillDemand({ role, skills });

      // Persist for user history (non-blocking — don't fail request if this fails)
      repo.saveAnalysis(userId, result).catch(err =>
        logger.warn('[SkillDemandCtrl] Failed to persist analysis', { error: err.message })
      );

      // Return structured response matching the API contract
      return res.status(200).json({
        success: true,
        data: {
          // Core API contract fields
          skill_score:         result.skill_score,
          skill_gaps:          result.skill_gaps,
          recommended_skills:  result.top_recommended_skills,

          // Extended fields for rich UI
          user_skills:         result.user_skills,
          required_skills:     result.required_skills,
          matched_skills:      result.matched_skills,
          top_recommended_skills: result.top_recommended_skills,

          // Analysis metadata
          analysis_meta:       result.analysis_meta,
        },
      });

    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/skills/demand/top
   *
   * Returns the highest-demand skills from the dataset.
   *
   * Query params:
   *   industry?: string  — filter by industry (e.g. "Technology", "Finance")
   *   limit?:    number  — max results (default 10, max 50)
   */
  async getTopDemandSkills(req, res, next) {
    try {
      const industry = req.query.industry || null;
      const limit    = Math.min(parseInt(req.query.limit || '10', 10), 50);

      const skills = await service.getTopDemandSkills({ industry, limit });

      return res.status(200).json({
        success: true,
        data: { skills, total: skills.length, industry: industry || 'all' },
      });

    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/skills/demand/role/:role
   *
   * Returns the required skills list for a given role from the dataset.
   */
  async getRoleSkills(req, res, next) {
    try {
      const { role } = req.params;

      if (!role || typeof role !== 'string') {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'role param is required' },
        });
      }

      const requiredSkills = await service.getRoleRequiredSkills(role);

      return res.status(200).json({
        success: true,
        data: {
          role,
          required_skills: requiredSkills,
          total:           requiredSkills.length,
        },
      });

    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/skills/demand/history
   *
   * Returns the authenticated user's past skill demand analyses.
   */
  async getUserHistory(req, res, next) {
    try {
      const userId = req.user.uid;
      const analyses = await repo.listUserAnalyses(userId);

      return res.status(200).json({
        success: true,
        data: {
          analyses,
          total: analyses.length,
        },
      });

    } catch (err) {
      next(err);
    }
  }
}

module.exports = { SkillDemandController };








