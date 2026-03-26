'use strict';

/**
 * freeEngine.js
 *
 * Rule-based analysis engine for free tier users.
 *
 * ARCHITECTURE DECISION:
 *   Free engine NEVER calls Claude or any paid external API.
 *   All logic is deterministic and rule-based.
 *   Output shape mirrors premium engine output exactly —
 *   this allows the frontend to consume both responses identically.
 *   Premium fields that can't be computed without AI are null.
 *
 * Cost: ₹0 per call. Runs unlimited times.
 */

const logger = require('../../../utils/logger');

// ─── Skill keyword signals ────────────────────────────────────
const SKILL_KEYWORDS = {
  technical: [
    'python', 'javascript', 'typescript', 'java', 'sql', 'react', 'node',
    'aws', 'docker', 'kubernetes', 'git', 'api', 'rest', 'graphql',
    'excel', 'tally', 'sap', 'gst', 'tds', 'power bi', 'tableau',
    'figma', 'photoshop', 'autocad', 'solidworks',
  ],
  leadership: ['managed', 'led', 'supervised', 'mentored', 'coordinated', 'directed', 'headed'],
  impact:     ['reduced', 'increased', 'improved', 'saved', 'delivered', 'launched', 'achieved'],
};

// ─── Scoring rules ────────────────────────────────────────────
function scoreResumeFree(resumeText) {
  if (!resumeText || typeof resumeText !== 'string') return 30;

  const text      = resumeText.toLowerCase();
  const wordCount = resumeText.split(/\s+/).length;
  let   score     = 30; // baseline

  // Word count signal
  if (wordCount > 300) score += 10;
  if (wordCount > 500) score += 5;

  // Technical skill coverage
  const techMatches = SKILL_KEYWORDS.technical.filter(k => text.includes(k)).length;
  score += Math.min(techMatches * 3, 20);

  // Leadership signal
  const leaderMatches = SKILL_KEYWORDS.leadership.filter(k => text.includes(k)).length;
  score += Math.min(leaderMatches * 2, 10);

  // Impact/quantification signal
  const hasNumbers  = /\d+%|\d+ years?|\₹\d+|increased|reduced|improved/.test(text);
  if (hasNumbers) score += 10;

  // Contact info signal
  const hasContact = /email|phone|linkedin|github/.test(text);
  if (hasContact) score += 5;

  // Education signal
  const hasEducation = /university|college|degree|b\.tech|mba|bca|b\.com/.test(text);
  if (hasEducation) score += 5;

  return Math.min(Math.round(score), 75); // free engine caps at 75 — premium gives full picture
}

function estimateExperienceFree(resumeText) {
  const text = (resumeText || '').toLowerCase();

  // Look for year patterns: 2018-2022, 2019 - present, etc.
  const yearMatches = text.match(/20\d\d/g) || [];
  if (yearMatches.length >= 2) {
    const years  = yearMatches.map(Number).sort();
    const spread = years[years.length - 1] - years[0];
    return Math.min(spread, 20);
  }

  // Fallback: count "years of experience" mentions
  const expMatch = text.match(/(\d+)\+?\s*years?\s*(?:of\s*)?(?:experience)?/i);
  if (expMatch) return parseInt(expMatch[1]);

  return 0;
}

function getTopSkillsFree(resumeText) {
  const text   = (resumeText || '').toLowerCase();
  return SKILL_KEYWORDS.technical
    .filter(k => text.includes(k))
    .slice(0, 5)
    .map(k => k.charAt(0).toUpperCase() + k.slice(1));
}

function scoreTier(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'average';
  return 'poor';
}

// ─── Main free engine ─────────────────────────────────────────

/**
 * runFreeEngine(resumeData)
 *
 * @param {object} resumeData - { resumeId, resumeText, fileName }
 * @returns {object} analysis result (mirrors premium shape, AI fields are null)
 */
function runFreeEngine(resumeData) {
  const { resumeId, resumeText, fileName } = resumeData;

  logger.debug('[FreeEngine] Running rule-based analysis', { resumeId });

  const score      = scoreResumeFree(resumeText);
  const tier       = scoreTier(score);
  const expYears   = estimateExperienceFree(resumeText);
  const topSkills  = getTopSkillsFree(resumeText);

  return {
    resumeId,
    fileName,
    engine:    'free',

    // ── Resume score ──────────────────────────────────────
    score,
    tier,
    summary:   'Basic analysis complete. Upgrade to see AI-powered insights.',
    breakdown: {
      clarity:     Math.round(score * 0.9),
      relevance:   Math.round(score * 0.95),
      experience:  Math.round(score * 0.85),
      skills:      Math.round(score * 1.0),
      achievements: Math.round(score * 0.7),
    },
    strengths:    topSkills.length > 0
      ? [`Relevant skills detected: ${topSkills.join(', ')}`]
      : ['Resume text extracted successfully'],
    improvements: [
      'Add more quantified achievements (numbers, percentages, outcomes)',
      'Include specific tools and technologies',
    ],
    topSkills,
    estimatedExperienceYears: expYears,

    // ── CHI (free: limited) ───────────────────────────────
    chiScore:       null,  // requires premium engine
    dimensions:     null,  // requires premium engine
    marketPosition: null,  // requires premium engine
    peerComparison: null,  // requires premium engine

    // ── Growth (free: null) ───────────────────────────────
    growthInsights:    null,
    salaryEstimate:    null,
    roadmap:           null,

    scoredAt: new Date().toISOString(),
  };
}

module.exports = { runFreeEngine };








