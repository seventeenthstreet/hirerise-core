'use strict';

/**
 * chiV2.controller.js
 *
 * POST /api/v1/chi-v2/calculate            — CHI score only
 * POST /api/v1/chi-v2/skill-gap            — Skill gap + learning path
 * POST /api/v1/chi-v2/career-path          — Career path + timeline
 * POST /api/v1/chi-v2/opportunities        — Career opportunity ranking
 * POST /api/v1/chi-v2/full-intelligence    — All four engines combined
 *
 * SECURITY: authenticate middleware applied in routes. Read-only Firestore.
 */

const { asyncHandler }                   = require('../../utils/helpers');
const { AppError, ErrorCodes }           = require('../../middleware/errorHandler');
const { calculateCHI, resolveRoleId }    = require('./chiV2.engine');
const { analyseSkillGap }                = require('./skillGapEngine');
const { recommendCareerPath }            = require('./careerPathEngine');
const { analyseCareerOpportunities }     = require('./careerOpportunityEngine');
const { runIntelligence }                = require('./intelligenceOrchestrator');
const logger                             = require('../../utils/logger');

function extractProfile(body) {
  return {
    current_role:     body.current_role     ?? null,
    target_role:      body.target_role      ?? null,
    skills:           Array.isArray(body.skills)       ? body.skills       : [],
    skill_levels:     Array.isArray(body.skill_levels) ? body.skill_levels : [],
    education_level:  body.education_level  ?? null,
    years_experience: Number(body.years_experience)    || 0,
    current_salary:   Number(body.current_salary)      || 0,
  };
}

function requireField(body, field) {
  if (!body[field]) throw new AppError(
    `${field} is required`, 400, { field }, ErrorCodes.VALIDATION_ERROR
  );
}

// POST /calculate
const calculate = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');
  const result = await calculateCHI(extractProfile(req.body));
  res.json({ success: true, data: result });
});

// POST /skill-gap
const skillGap = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');
  const profile      = extractProfile(req.body);
  const targetRoleId = await resolveRoleId(profile.target_role);
  if (!targetRoleId) throw new AppError(`Target role not found: "${profile.target_role}"`, 404, {}, ErrorCodes.NOT_FOUND);
  const result = await analyseSkillGap(targetRoleId, profile.skills);
  res.json({ success: true, data: result });
});

// POST /career-path
const careerPath = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');
  const profile = extractProfile(req.body);
  const [targetRoleId, currentRoleId] = await Promise.all([
    resolveRoleId(profile.target_role),
    profile.current_role ? resolveRoleId(profile.current_role) : Promise.resolve(null),
  ]);
  if (!targetRoleId) throw new AppError(`Target role not found: "${profile.target_role}"`, 404, {}, ErrorCodes.NOT_FOUND);
  const result = await recommendCareerPath(currentRoleId, targetRoleId);
  res.json({ success: true, data: result });
});

// POST /opportunities
const opportunities = asyncHandler(async (req, res) => {
  requireField(req.body, 'current_role');
  const profile  = extractProfile(req.body);
  const country  = req.body.country  ?? null;
  const top_n    = Number(req.body.top_n) || 3;

  const [currentRoleId, chiResult] = await Promise.all([
    resolveRoleId(profile.current_role),
    profile.target_role
      ? calculateCHI(profile).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (!currentRoleId) throw new AppError(`Current role not found: "${profile.current_role}"`, 404, {}, ErrorCodes.NOT_FOUND);

  const result = await analyseCareerOpportunities(
    { current_role_id: currentRoleId, chi_score: chiResult?.chi_score ?? null },
    { country, top_n }
  );
  res.json({ success: true, data: result });
});

// POST /full-intelligence
const fullIntelligence = asyncHandler(async (req, res) => {
  requireField(req.body, 'target_role');
  const result = await runIntelligence(
    extractProfile(req.body),
    { country: req.body.country ?? null, top_n: Number(req.body.top_n) || 3 }
  );
  res.json({ success: true, data: result });
});

module.exports = { calculate, skillGap, careerPath, opportunities, fullIntelligence };








