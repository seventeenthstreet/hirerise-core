'use strict';

/**
 * routes/semantic.routes.js
 * Semantic AI upgrade routes
 */

const express = require('express');
const { body, query } = require('express-validator');

const router = express.Router();

const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/requestValidator');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// Engines
// ─────────────────────────────────────────────────────────────
const semanticSkillEngine = require('../engines/semanticSkill.engine');
const semanticJobEngine = require('../engines/semanticJobMatching.engine');
const careerAdvisorEngine = require('../engines/careerAdvisor.engine');
const learningPathEngine = require('../engines/learningPath.engine');

// ─────────────────────────────────────────────────────────────
// Lazy-loaded shared services
// ─────────────────────────────────────────────────────────────
let skillGraphSvc = null;
let jobMatchSvc = null;
let marketSvc = null;

function getSkillGraphSvc() {
  if (!skillGraphSvc) {
    skillGraphSvc = require('../modules/jobSeeker/skillGraphEngine.service');
  }
  return skillGraphSvc;
}

function getJobMatchSvc() {
  if (!jobMatchSvc) {
    jobMatchSvc = require('../modules/jobSeeker/jobMatchingEngine.service');
  }
  return jobMatchSvc;
}

function getMarketSvc() {
  if (!marketSvc) {
    try {
      marketSvc = require('../modules/labor-market-intelligence/services/marketTrend.service');
    } catch (_) {
      marketSvc = null;
    }
  }
  return marketSvc;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

function ok(res, data) {
  return res.status(200).json({
    success: true,
    data,
  });
}

function fail(res, message, code = 500) {
  return res.status(code).json({
    success: false,
    error: {
      code: code === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      message,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// GET /skills/similar
// ─────────────────────────────────────────────────────────────
router.get(
  '/skills/similar',
  authenticate,
  validate([
    query('skill')
      .isString()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('skill must be 2-100 characters'),

    query('topK')
      .optional()
      .isInt({ min: 1, max: 20 })
      .toInt(),

    query('minScore')
      .optional()
      .isFloat({ min: 0, max: 1 })
      .toFloat(),
  ]),
  async (req, res) => {
    try {
      const skill = req.query.skill;
      const topK = req.query.topK ?? 5;
      const minScore = req.query.minScore ?? 0.6;

      const result =
        await semanticSkillEngine.findSimilarSkills(skill, {
          topK,
          minScore,
        });

      return ok(res, result);
    } catch (error) {
      logger.error('[SemanticRoutes] skills/similar failed', {
        error: error.message,
      });
      return fail(res, 'Failed to find similar skills');
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST /skills/embed
// ─────────────────────────────────────────────────────────────
router.post(
  '/skills/embed',
  authenticate,
  validate([
    body('skill')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 2, max: 150 }),

    body('skills')
      .optional()
      .isArray({ min: 1, max: 100 }),

    body('skills.*')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 2, max: 150 }),
  ]),
  async (req, res) => {
    try {
      const { skill, skills } = req.body;

      if (Array.isArray(skills)) {
        const result =
          await semanticSkillEngine.batchGenerateEmbeddings(
            skills
          );
        return ok(res, result);
      }

      if (!skill) {
        return fail(
          res,
          '"skill" or "skills[]" required in body',
          400
        );
      }

      const result =
        await semanticSkillEngine.generateSkillEmbedding(skill);

      return ok(res, {
        skill: result.skill_name,
        status: 'embedded',
      });
    } catch (error) {
      logger.error('[SemanticRoutes] skills/embed failed', {
        error: error.message,
      });
      return fail(res, 'Embedding generation failed');
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /job-seeker/jobs/semantic-match
// ─────────────────────────────────────────────────────────────
router.get(
  '/job-seeker/jobs/semantic-match',
  authenticate,
  validate([
    query('limit').optional().isInt({ min: 1, max: 30 }).toInt(),
    query('minScore').optional().isInt({ min: 0, max: 100 }).toInt(),
  ]),
  async (req, res) => {
    const userId = resolveUserId(req);
    if (!userId) return fail(res, 'Unauthenticated', 401);

    try {
      const limit = req.query.limit ?? 10;
      const minScore = req.query.minScore ?? 30;

      const [userGraph, jobMatchData] =
        await Promise.allSettled([
          getSkillGraphSvc().getUserSkillGap(userId),
          getJobMatchSvc().getJobMatches(userId, {
            limit: 50,
          }),
        ]);

      const skillGapData =
        userGraph.status === 'fulfilled'
          ? userGraph.value
          : {};

      const candidateJobs =
        jobMatchData.status === 'fulfilled'
          ? (
              jobMatchData.value?.recommended_jobs || []
            ).map((j) => ({
              id: j.id || j.roleId,
              title: j.title,
              description: j.description || '',
              skills:
                j.required_skills ||
                j.missing_skills ||
                [],
              company: j.company || null,
              location: j.location || null,
              yearsRequired: j.yearsRequired || 0,
              industry: j.sector || null,
            }))
          : [];

      const userProfile = {
        userId,
        skills: skillGapData.existing_skills || [],
        yearsExperience:
          skillGapData.years_experience || 0,
        industry: skillGapData.industry || '',
        location: '',
      };

      const { recommended_jobs } =
        await semanticJobEngine.getSemanticJobRecommendations(
          userProfile,
          candidateJobs,
          { topN: limit, minScore }
        );

      return ok(res, {
        recommended_jobs,
        total_evaluated: candidateJobs.length,
        user_skills_count:
          userProfile.skills.length,
        scoring_weights:
          semanticJobEngine.WEIGHTS,
      });
    } catch (error) {
      logger.error(
        '[SemanticRoutes] semantic-match failed',
        {
          userId,
          error: error.message,
        }
      );
      return fail(res, 'Semantic job matching failed');
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /career/advice
// ─────────────────────────────────────────────────────────────
router.get(
  '/career/advice',
  authenticate,
  async (req, res) => {
    const userId = resolveUserId(req);
    if (!userId) return fail(res, 'Unauthenticated', 401);

    try {
      const [skillGapRes, jobMatchRes, marketRes] =
        await Promise.allSettled([
          getSkillGraphSvc().getUserSkillGap(userId),
          getJobMatchSvc().getJobMatches(userId, {
            limit: 5,
          }),
          getMarketSvc()
            ? getMarketSvc().getTrendingSkills()
            : Promise.resolve(null),
        ]);

      const skillGap =
        skillGapRes.status === 'fulfilled'
          ? skillGapRes.value
          : {};

      const jobMatches =
        jobMatchRes.status === 'fulfilled'
          ? jobMatchRes.value?.recommended_jobs || []
          : [];

      const marketDemand =
        marketRes.status === 'fulfilled'
          ? marketRes.value
          : null;

      const profile = {
        skills: skillGap.existing_skills || [],
        yearsExperience:
          skillGap.years_experience || 0,
        targetRole: skillGap.target_role || null,
        industry: skillGap.industry || null,
      };

      const result =
        await careerAdvisorEngine.generateCareerAdvice({
          userId,
          profile,
          skillGap,
          marketDemand,
          topJobMatches: jobMatches,
        });

      return ok(res, result);
    } catch (error) {
      logger.error('[SemanticRoutes] advice failed', {
        userId,
        error: error.message,
      });
      return fail(res, 'Career advice generation failed');
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /skills/learning-path
// ─────────────────────────────────────────────────────────────
router.get(
  '/skills/learning-path',
  authenticate,
  async (req, res) => {
    const userId = resolveUserId(req);
    const { skill, skills, targetRole } = req.query;

    let skillList = [];
    if (skills) {
      skillList = String(skills)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (skill) {
      skillList = [String(skill).trim()];
    }

    if (!skillList.length) {
      return fail(
        res,
        'Query param "skill" or "skills" is required',
        400
      );
    }

    try {
      let userSkills = [];

      if (userId) {
        try {
          const skillGap =
            await getSkillGraphSvc().getUserSkillGap(
              userId
            );
          userSkills =
            skillGap?.existing_skills || [];
        } catch (_) {}
      }

      const result =
        skillList.length === 1
          ? await learningPathEngine.generateLearningPath(
              {
                skill: skillList[0],
                userSkills,
                targetRole: targetRole || '',
              }
            )
          : await learningPathEngine.generateMultiSkillPaths(
              {
                skills: skillList,
                userSkills,
                targetRole: targetRole || '',
              }
            );

      return ok(res, result);
    } catch (error) {
      logger.error(
        '[SemanticRoutes] learning-path failed',
        {
          userId,
          error: error.message,
        }
      );
      return fail(
        res,
        'Learning path generation failed'
      );
    }
  }
);

module.exports = router;