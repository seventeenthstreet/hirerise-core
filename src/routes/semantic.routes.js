'use strict';

/**
 * semantic.routes.js — Semantic AI Upgrade Routes
 *
 * Registers all 4 upgrade endpoints on the existing Express app.
 * Drop this file into src/routes/ and add one line to server.js.
 *
 * Routes added:
 *   GET  /api/v1/skills/similar          (Upgrade 1 — Semantic Skill Intelligence)
 *   POST /api/v1/skills/embed            (Upgrade 1 — generate skill embedding)
 *   GET  /api/v1/job-seeker/jobs/semantic-match  (Upgrade 2 — Semantic Job Matching)
 *   GET  /api/v1/career/advice           (Upgrade 3 — AI Career Advisor)
 *   GET  /api/v1/skills/learning-path    (Upgrade 4 — Learning Path Generation)
 *
 * Auth: all routes require Firebase auth (existing auth.middleware).
 * Rate limiting: inherits existing aiRateLimit middleware where needed.
 *
 * To register — add ONE line to server.js (after existing routes):
 *   app.use('/api/v1', require('./routes/semantic.routes'));
 */

const express               = require('express');
const router                = express.Router();

const { authenticate }      = require('../middleware/auth.middleware');
const logger                = require('../utils/logger');

// ─── Engines ──────────────────────────────────────────────────────────────────

const semanticSkillEngine   = require('../engines/semanticSkill.engine');
const semanticJobEngine     = require('../engines/semanticJobMatching.engine');
const careerAdvisorEngine   = require('../engines/careerAdvisor.engine');
const learningPathEngine    = require('../engines/learningPath.engine');

// ─── Existing services (reuse) ────────────────────────────────────────────────

let _skillGraphSvc  = null;
let _jobMatchSvc    = null;
let _marketSvc      = null;

function getSkillGraphSvc() {
  if (!_skillGraphSvc) _skillGraphSvc = require('../modules/jobSeeker/skillGraphEngine.service');
  return _skillGraphSvc;
}

function getJobMatchSvc() {
  if (!_jobMatchSvc) _jobMatchSvc = require('../modules/jobSeeker/jobMatchingEngine.service');
  return _jobMatchSvc;
}

function getMarketSvc() {
  if (!_marketSvc) {
    try { _marketSvc = require('../modules/labor-market-intelligence/services/marketTrend.service'); }
    catch (_) {}
  }
  return _marketSvc;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

const ok  = (res, data)  => res.status(200).json({ success: true,  data });
const err = (res, msg, code = 500) => res.status(code).json({ success: false, error: msg });

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE 1 — GET /skills/similar?skill=Excel&topK=5
// Returns semantically similar skills via cosine similarity.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/skills/similar', authenticate, async (req, res) => {
  const { skill, topK = 5, minScore = 0.6 } = req.query;

  if (!skill || String(skill).trim().length < 2) {
    return err(res, 'Query param "skill" is required (min 2 chars)', 400);
  }

  try {
    const result = await semanticSkillEngine.findSimilarSkills(
      String(skill).trim(),
      { topK: Math.min(parseInt(topK) || 5, 20), minScore: parseFloat(minScore) || 0.6 }
    );
    ok(res, result);
  } catch (e) {
    logger.error('[Route] skills/similar', { err: e.message });
    err(res, 'Failed to find similar skills', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE 1 — POST /skills/embed   { skill: "Power BI" }
// Manually trigger embedding generation for a skill (admin/import use).
// ─────────────────────────────────────────────────────────────────────────────

router.post('/skills/embed', authenticate, async (req, res) => {
  const { skill, skills } = req.body;

  // Support single or batch
  if (skills && Array.isArray(skills)) {
    try {
      const result = await semanticSkillEngine.batchGenerateEmbeddings(skills);
      ok(res, result);
    } catch (e) {
      logger.error('[Route] skills/embed batch', { err: e.message });
      err(res, 'Batch embedding failed', 500);
    }
    return;
  }

  if (!skill || String(skill).trim().length < 2) {
    return err(res, '"skill" or "skills[]" required in body', 400);
  }

  try {
    const result = await semanticSkillEngine.generateSkillEmbedding(String(skill).trim());
    ok(res, { skill: result.skill_name, status: 'embedded' });
  } catch (e) {
    logger.error('[Route] skills/embed single', { err: e.message });
    err(res, 'Embedding generation failed', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE 2 — GET /job-seeker/jobs/semantic-match?limit=10&minScore=30
// Returns semantically matched jobs with scores and missing skills.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/job-seeker/jobs/semantic-match', authenticate, async (req, res) => {
  const userId  = req.user?.uid || req.user?.id;
  const limit   = Math.min(parseInt(req.query.limit)    || 10, 30);
  const minScore = parseInt(req.query.minScore) || 30;

  if (!userId) return err(res, 'Unauthenticated', 401);

  try {
    const skillGraphSvc = getSkillGraphSvc();

    // Load user profile + skill graph (reuse existing service)
    const [userGraph, jobMatchData] = await Promise.allSettled([
      skillGraphSvc.getUserSkillGap(userId),
      getJobMatchSvc().getJobMatches(userId, { limit: 50 }), // fetch more candidates
    ]);

    const skillGapData  = userGraph.status   === 'fulfilled' ? userGraph.value   : {};
    const candidateJobs = jobMatchData.status === 'fulfilled'
      ? (jobMatchData.value?.recommended_jobs || []).map(j => ({
          id:            j.id || j.roleId,
          title:         j.title,
          description:   j.description || '',
          skills:        j.required_skills || j.missing_skills || [],
          company:       j.company || null,
          location:      j.location || null,
          yearsRequired: j.yearsRequired || 0,
          industry:      j.sector || null,
        }))
      : [];

    const userProfile = {
      userId,
      skills:          skillGapData.existing_skills || [],
      yearsExperience: skillGapData.years_experience || 0,
      industry:        skillGapData.industry || '',
      location:        '',
    };

    const { recommended_jobs } = await semanticJobEngine.getSemanticJobRecommendations(
      userProfile,
      candidateJobs,
      { topN: limit, minScore }
    );

    ok(res, {
      recommended_jobs,
      total_evaluated: candidateJobs.length,
      user_skills_count: userProfile.skills.length,
      scoring_weights:   semanticJobEngine.WEIGHTS,
    });
  } catch (e) {
    logger.error('[Route] job-seeker/jobs/semantic-match', { userId, err: e.message });
    err(res, 'Semantic job matching failed', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE 3 — GET /career/advice
// Returns AI-generated career insight for the authenticated user.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/career/advice', authenticate, async (req, res) => {
  const userId = req.user?.uid || req.user?.id;
  if (!userId) return err(res, 'Unauthenticated', 401);

  try {
    const skillGraphSvc = getSkillGraphSvc();
    const marketSvc     = getMarketSvc();

    // Load data in parallel
    const [skillGapRes, jobMatchRes, marketRes] = await Promise.allSettled([
      skillGraphSvc.getUserSkillGap(userId),
      getJobMatchSvc().getJobMatches(userId, { limit: 5 }),
      marketSvc ? marketSvc.getTrendingSkills() : Promise.resolve(null),
    ]);

    const skillGap     = skillGapRes.status   === 'fulfilled' ? skillGapRes.value   : {};
    const jobMatches   = jobMatchRes.status   === 'fulfilled' ? jobMatchRes.value?.recommended_jobs || [] : [];
    const marketDemand = marketRes.status     === 'fulfilled' ? marketRes.value : null;

    // Build profile from skill gap data
    const profile = {
      skills:          skillGap.existing_skills   || [],
      yearsExperience: skillGap.years_experience  || 0,
      targetRole:      skillGap.target_role       || null,
      industry:        skillGap.industry          || null,
    };

    const result = await careerAdvisorEngine.generateCareerAdvice({
      userId,
      profile,
      skillGap,
      marketDemand,
      topJobMatches: jobMatches,
    });

    ok(res, result);
  } catch (e) {
    logger.error('[Route] career/advice', { userId, err: e.message });
    err(res, 'Career advice generation failed', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE 4 — GET /skills/learning-path?skill=Power+BI
//           — GET /skills/learning-path?skills=Power+BI,Python,SQL (multi)
// Returns structured learning path(s) for missing skill(s).
// ─────────────────────────────────────────────────────────────────────────────

router.get('/skills/learning-path', authenticate, async (req, res) => {
  const userId  = req.user?.uid || req.user?.id;
  const { skill, skills: skillsParam, targetRole } = req.query;

  // Parse skills — support comma-separated or single
  let skillList = [];
  if (skillsParam) {
    skillList = String(skillsParam).split(',').map(s => s.trim()).filter(Boolean);
  } else if (skill) {
    skillList = [String(skill).trim()];
  }

  if (skillList.length === 0) {
    return err(res, 'Query param "skill" or "skills" is required', 400);
  }

  try {
    // Load user's existing skills for prerequisite filtering
    let userSkills = [];
    if (userId) {
      try {
        const skillGap = await getSkillGraphSvc().getUserSkillGap(userId);
        userSkills = skillGap?.existing_skills || [];
      } catch (_) {}
    }

    let result;
    if (skillList.length === 1) {
      result = await learningPathEngine.generateLearningPath({
        skill:      skillList[0],
        userSkills,
        targetRole: targetRole || '',
      });
    } else {
      result = await learningPathEngine.generateMultiSkillPaths({
        skills:     skillList,
        userSkills,
        targetRole: targetRole || '',
      });
    }

    ok(res, result);
  } catch (e) {
    logger.error('[Route] skills/learning-path', { userId, err: e.message });
    err(res, 'Learning path generation failed', 500);
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = router;









