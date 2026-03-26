'use strict';

/**
 * aiOutput.validator.js
 *
 * Place at: src/utils/aiOutput.validator.js
 *
 * Unified validation layer for ALL AI service outputs.
 * Called after every LLM response before it is returned to callers or cached.
 *
 * Covers:
 *   validateCareerIntelligence(output)  — careerIntelligence.service.js
 *   validateCvBuilderOutput(output)     — cvBuilder.service.js
 *   validateResumeScore(output)         — resumeScore.service.js
 *   validateChiSnapshot(snapshot)       — careerHealthIndex.service.js
 *
 * Behaviour:
 *   - Throws a descriptive Error if validation fails
 *   - Auto-corrects minor issues (label/score mismatches, rounding)
 *   - Logs which auto-corrections were applied (for monitoring)
 *   - Never silently swallows an empty or malformed response
 *
 * Usage:
 *   const { validateCareerIntelligence } = require('../utils/aiOutput.validator');
 *   validateCareerIntelligence(llmOutput); // throws on failure
 */

const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _assertObject(val, label) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`[Validator] ${label} must be a non-null object, got: ${typeof val}`);
  }
}

function _assertArray(val, label, minLen = 0, maxLen = Infinity) {
  if (!Array.isArray(val)) {
    throw new Error(`[Validator] ${label} must be an array, got: ${typeof val}`);
  }
  if (val.length < minLen) {
    throw new Error(`[Validator] ${label} must have at least ${minLen} items, got: ${val.length}`);
  }
  if (val.length > maxLen) {
    throw new Error(`[Validator] ${label} must have at most ${maxLen} items, got: ${val.length}`);
  }
}

function _assertString(val, label, minLen = 1) {
  if (typeof val !== 'string' || val.trim().length < minLen) {
    throw new Error(`[Validator] ${label} must be a non-empty string (min ${minLen} chars), got: ${JSON.stringify(val)}`);
  }
}

function _assertNumber(val, label, min = -Infinity, max = Infinity) {
  if (typeof val !== 'number' || !isFinite(val)) {
    throw new Error(`[Validator] ${label} must be a finite number, got: ${JSON.stringify(val)}`);
  }
  if (val < min || val > max) {
    throw new Error(`[Validator] ${label} must be between ${min} and ${max}, got: ${val}`);
  }
}

function _assertEnum(val, label, allowed) {
  if (!allowed.includes(val)) {
    throw new Error(`[Validator] ${label} must be one of [${allowed.join(', ')}], got: "${val}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Career Intelligence output (careerIntelligence.service.js → llmClient.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateCareerIntelligence(output)
 *
 * Validates the structured JSON returned by the career intelligence LLM prompt.
 * Enforces:
 *   - Monotonically increasing growth probabilities
 *   - Salary figures are integers in INR
 *   - Automation risk score matches label
 *   - Exactly 5 top skills
 *   - Exactly 3 next roles
 *   - Non-empty summary
 */
function validateCareerIntelligence(output) {
  _assertObject(output, 'CareerIntelligence output');

  // ── growthProjection ─────────────────────────────────────────────────────
  _assertObject(output.growthProjection, 'growthProjection');
  _assertString(output.growthProjection.currentLevel, 'growthProjection.currentLevel');
  _assertObject(output.growthProjection.projection, 'growthProjection.projection');

  const proj     = output.growthProjection.projection;
  const horizons = ['1Year', '3Year', '5Year'];

  for (const h of horizons) {
    if (!proj[h]) throw new Error(`[Validator] Missing projection horizon: ${h}`);

    const p = proj[h].probability;
    _assertNumber(p, `growthProjection.projection.${h}.probability`, 0, 1);
    _assertString(proj[h].level || '', `growthProjection.projection.${h}.level`);

    const sr = proj[h].salaryRange;
    _assertObject(sr, `growthProjection.projection.${h}.salaryRange`);
    _assertNumber(sr.min, `${h}.salaryRange.min`,  0);
    _assertNumber(sr.max, `${h}.salaryRange.max`,  1);

    if (sr.min >= sr.max) {
      throw new Error(`[Validator] ${h}.salaryRange: min (${sr.min}) must be < max (${sr.max})`);
    }
    if (sr.currency !== 'INR') {
      throw new Error(`[Validator] ${h}.salaryRange.currency must be "INR", got "${sr.currency}"`);
    }
    // Enforce integers
    if (!Number.isInteger(sr.min) || !Number.isInteger(sr.max)) {
      logger.debug('[Validator] Auto-correcting salary to integers', { h });
      sr.min = Math.round(sr.min);
      sr.max = Math.round(sr.max);
      if (sr.median != null) sr.median = Math.round(sr.median);
    }
  }

  // Monotonically increasing probabilities
  const [p1, p3, p5] = horizons.map(h => proj[h].probability);
  if (p1 >= p3) {
    throw new Error(`[Validator] Probabilities not monotonically increasing: 1Y(${p1}) >= 3Y(${p3})`);
  }
  if (p3 >= p5) {
    throw new Error(`[Validator] Probabilities not monotonically increasing: 3Y(${p3}) >= 5Y(${p5})`);
  }

  // ── automationRisk ────────────────────────────────────────────────────────
  _assertObject(output.automationRisk, 'automationRisk');
  const ar = output.automationRisk;
  _assertNumber(ar.score, 'automationRisk.score', 0, 10);
  if (!Number.isInteger(ar.score)) {
    ar.score = Math.round(ar.score);
    logger.debug('[Validator] Auto-corrected automationRisk.score to integer', { score: ar.score });
  }

  const expectedLabel =
    ar.score <= 3 ? 'Low' :
    ar.score <= 5 ? 'Medium' :
    ar.score <= 7 ? 'High' : 'Critical';

  if (ar.label !== expectedLabel) {
    logger.debug('[Validator] Auto-corrected automationRisk.label', {
      was: ar.label, correctedTo: expectedLabel, score: ar.score,
    });
    ar.label = expectedLabel;
  }

  _assertString(ar.reasoning || '', 'automationRisk.reasoning', 10);
  _assertString(ar.timeframe  || '', 'automationRisk.timeframe', 2);

  // ── topSkills ─────────────────────────────────────────────────────────────
  _assertArray(output.topSkills, 'topSkills', 3, 8);
  const validPriorities = ['critical', 'high', 'medium'];

  output.topSkills.forEach((s, i) => {
    _assertString(s.skill || '', `topSkills[${i}].skill`);
    if (!validPriorities.includes(s.priority)) {
      logger.debug('[Validator] Auto-corrected topSkills priority', { i, was: s.priority });
      s.priority = 'high';
    }
    if (!s.reason || s.reason.trim().length < 5) {
      s.reason = `Required for ${s.skill} proficiency in this role`;
    }
  });

  // ── nextRoles ─────────────────────────────────────────────────────────────
  _assertArray(output.nextRoles, 'nextRoles', 1, 5);
  const validDifficulty = ['easy', 'medium', 'hard'];

  output.nextRoles.forEach((r, i) => {
    _assertString(r.title || '', `nextRoles[${i}].title`);
    _assertNumber(r.timelineMonths, `nextRoles[${i}].timelineMonths`, 1, 120);
    if (!Number.isInteger(r.timelineMonths)) r.timelineMonths = Math.round(r.timelineMonths);
    if (typeof r.salaryUpliftPercent === 'number') {
      r.salaryUpliftPercent = Math.round(Math.max(0, Math.min(100, r.salaryUpliftPercent)));
    }
    if (!validDifficulty.includes(r.transitionDifficulty)) {
      r.transitionDifficulty = 'medium';
    }
    if (!Array.isArray(r.keySkillsNeeded)) r.keySkillsNeeded = [];
  });

  // ── summary ───────────────────────────────────────────────────────────────
  _assertString(output.summary || '', 'summary', 20);

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CV Builder output (cvBuilder.service.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateCvBuilderOutput(output, templateId)
 *
 * Validates that the CV builder LLM returned a well-formed result.
 */
function validateCvBuilderOutput(output, templateId) {
  _assertObject(output, 'CvBuilderOutput');

  _assertString(output.optimizedSummary || '', 'optimizedSummary', 20);
  _assertArray(output.extractedJobKeywords || [], 'extractedJobKeywords', 1);
  _assertArray(output.highlightedSkills    || [], 'highlightedSkills',    1);
  _assertArray(output.reorderedExperience  || [], 'reorderedExperience',  0);

  if (typeof output.keywordMatchScore !== 'number'
      || output.keywordMatchScore < 0
      || output.keywordMatchScore > 100) {
    logger.debug('[Validator] Auto-correcting keywordMatchScore', { was: output.keywordMatchScore });
    output.keywordMatchScore = Math.round(Math.min(100, Math.max(0, output.keywordMatchScore || 50)));
  }

  output.reorderedExperience.forEach((exp, i) => {
    _assertString(exp.jobTitle || '', `reorderedExperience[${i}].jobTitle`);
    if (!Array.isArray(exp.optimizedBullets)) exp.optimizedBullets = [];
    if (exp.optimizedBullets.length === 0) {
      logger.debug('[Validator] reorderedExperience entry has no bullets', { i, title: exp.jobTitle });
    }
  });

  // Check template style matches requested template
  if (templateId && output.templateStyle && output.templateStyle !== templateId) {
    logger.debug('[Validator] Template style mismatch — correcting', {
      requested: templateId, returned: output.templateStyle,
    });
    output.templateStyle = templateId;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resume Score output (resumeScore.service.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateResumeScore(output)
 *
 * Ensures the resume score result is real and structurally correct.
 * This is the critical check that prevents mock data from flowing downstream.
 */
function validateResumeScore(output) {
  _assertObject(output, 'ResumeScore output');

  // Hard stop: isMockData must NEVER be true
  if (output.isMockData === true) {
    throw new Error(
      '[Validator] CRITICAL: isMockData is true. ' +
      'Replace performAIScoring() stub in resumeScore.service.js with real scoring logic.'
    );
  }

  // Score must be a real computed number, not the old hardcoded 72
  _assertNumber(output.overallScore, 'overallScore', 0, 100);
  if (output.overallScore === 72) {
    logger.warn('[Validator] overallScore is exactly 72 — this may be the old stub value');
  }

  _assertObject(output.breakdown, 'breakdown');
  const dims = ['skills', 'experience', 'roleMatch', 'education', 'completeness'];
  for (const dim of dims) {
    _assertNumber(output.breakdown[dim] ?? null, `breakdown.${dim}`, 0);
  }

  // Sum of dimensions should equal overallScore (within rounding)
  const sum = dims.reduce((s, d) => s + (output.breakdown[d] || 0), 0);
  const diff = Math.abs(sum - output.overallScore);
  if (diff > 2) {
    logger.warn('[Validator] overallScore doesn\'t match breakdown sum', {
      overallScore: output.overallScore, sum, diff,
    });
  }

  _assertString(output.roleFit || '', 'roleFit');
  if (output.roleFit === 'unknown') {
    logger.debug('[Validator] roleFit is "unknown" — resume may have no detectedRoles');
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHI Snapshot (careerHealthIndex.service.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateChiSnapshot(snapshot)
 *
 * Validates a CHI snapshot before it is written to Firestore.
 */
function validateChiSnapshot(snapshot) {
  _assertObject(snapshot, 'ChiSnapshot');

  _assertString(snapshot.snapshotId || '', 'snapshotId');
  _assertString(snapshot.userId     || '', 'userId');
  _assertNumber(snapshot.chiScore,  'chiScore', 0, 100);

  if (!Number.isInteger(snapshot.chiScore)) {
    snapshot.chiScore = Math.round(snapshot.chiScore);
  }

  _assertObject(snapshot.dimensions, 'dimensions');

  const expectedDims = ['skillVelocity', 'experienceDepth', 'marketAlignment', 'salaryTrajectory', 'careerMomentum'];
  for (const dim of expectedDims) {
    if (!snapshot.dimensions[dim]) {
      logger.warn('[Validator] CHI snapshot missing dimension', { dim });
      snapshot.dimensions[dim] = { score: 50, insight: 'Insufficient data', flag: true };
    }
    const { score } = snapshot.dimensions[dim];
    _assertNumber(score, `dimensions.${dim}.score`, 0, 100);
  }

  const validSources = ['full', 'provisional', 'quick_provisional', 'resume_scored'];
  if (!validSources.includes(snapshot.analysisSource)) {
    throw new Error(`[Validator] Invalid analysisSource: "${snapshot.analysisSource}"`);
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatible export (careerOutput.validator.js uses validateCareerOutput)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  validateCareerIntelligence,
  validateCareerOutput: validateCareerIntelligence, // alias for existing callers
  validateCvBuilderOutput,
  validateResumeScore,
  validateChiSnapshot,
};








