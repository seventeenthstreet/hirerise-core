'use strict';

/**
 * src/modules/analysis/freeEngine.js
 *
 * Production-ready deterministic analysis engine for free-tier users.
 *
 * DESIGN GOALS
 * - Zero external paid API calls
 * - Pure compute engine (no DB writes)
 * - Supabase-ready output shape
 * - Supports dynamic skill keyword injection from DB cache
 * - Stable, testable, and horizontally scalable
 */

const logger = require('../../../utils/logger');

const DEFAULT_SKILL_KEYWORDS = Object.freeze({
  technical: [
    'python', 'javascript', 'typescript', 'java', 'sql', 'react', 'node',
    'aws', 'docker', 'kubernetes', 'git', 'api', 'rest', 'graphql',
    'excel', 'tally', 'sap', 'gst', 'tds', 'power bi', 'tableau',
    'figma', 'photoshop', 'autocad', 'solidworks',
  ],
  leadership: [
    'managed', 'led', 'supervised', 'mentored', 'coordinated', 'directed', 'headed',
  ],
  impact: [
    'reduced', 'increased', 'improved', 'saved', 'delivered', 'launched', 'achieved',
  ],
});

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function resolveKeywords(dynamicKeywords = {}) {
  return {
    technical: safeArray(dynamicKeywords.technical).length
      ? dynamicKeywords.technical
      : DEFAULT_SKILL_KEYWORDS.technical,
    leadership: safeArray(dynamicKeywords.leadership).length
      ? dynamicKeywords.leadership
      : DEFAULT_SKILL_KEYWORDS.leadership,
    impact: safeArray(dynamicKeywords.impact).length
      ? dynamicKeywords.impact
      : DEFAULT_SKILL_KEYWORDS.impact,
  };
}

function countKeywordMatches(text, keywords) {
  return keywords.reduce((count, keyword) => {
    return text.includes(keyword.toLowerCase()) ? count + 1 : count;
  }, 0);
}

function scoreResumeFree(resumeText, keywords) {
  if (!resumeText || typeof resumeText !== 'string') return 30;

  const text = normalizeText(resumeText);
  const wordCount = text ? text.split(/\s+/).length : 0;

  let score = 30;

  if (wordCount > 300) score += 10;
  if (wordCount > 500) score += 5;

  const techMatches = countKeywordMatches(text, keywords.technical);
  score += Math.min(techMatches * 3, 20);

  const leadershipMatches = countKeywordMatches(text, keywords.leadership);
  score += Math.min(leadershipMatches * 2, 10);

  const hasQuantifiedImpact = /(\d+%|\d+\+?\s*years?|₹\s?\d+|\$\s?\d+|increased|reduced|improved)/i.test(text);
  if (hasQuantifiedImpact) score += 10;

  const hasContact = /(email|phone|linkedin|github)/i.test(text);
  if (hasContact) score += 5;

  const hasEducation = /(university|college|degree|b\.tech|mba|bca|b\.com|m\.tech)/i.test(text);
  if (hasEducation) score += 5;

  return Math.min(Math.round(score), 75);
}

function estimateExperienceFree(resumeText) {
  const text = normalizeText(resumeText);

  const yearMatches = text.match(/20\d{2}/g) || [];
  if (yearMatches.length >= 2) {
    const years = yearMatches.map(Number).sort((a, b) => a - b);
    const spread = years[years.length - 1] - years[0];
    return Math.max(0, Math.min(spread, 20));
  }

  const explicitExperience = text.match(/(\d+)\+?\s*years?\s*(?:of\s*)?(?:experience)?/i);
  if (explicitExperience) {
    return Math.min(parseInt(explicitExperience[1], 10) || 0, 40);
  }

  return 0;
}

function getTopSkillsFree(resumeText, keywords) {
  const text = normalizeText(resumeText);

  return keywords.technical
    .filter((keyword) => text.includes(keyword.toLowerCase()))
    .slice(0, 5)
    .map((keyword) => keyword
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '));
}

function scoreTier(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'average';
  return 'poor';
}

/**
 * runFreeEngine
 * @param {Object} params
 * @param {string} params.resumeId
 * @param {string} params.resumeText
 * @param {string} params.fileName
 * @param {Object} [params.skillKeywords]
 * @returns {Object}
 */
function runFreeEngine({ resumeId, resumeText, fileName, skillKeywords = {} }) {
  const keywords = resolveKeywords(skillKeywords);

  logger.debug('[FreeEngine] Running deterministic analysis', {
    resumeId,
    keywordSource: Object.keys(skillKeywords).length ? 'dynamic' : 'default',
  });

  const score = scoreResumeFree(resumeText, keywords);
  const tier = scoreTier(score);
  const estimatedExperienceYears = estimateExperienceFree(resumeText);
  const topSkills = getTopSkillsFree(resumeText, keywords);

  return {
    resumeId,
    fileName,
    engine: 'free',
    score,
    tier,
    summary: 'Basic analysis complete. Upgrade to unlock premium AI insights.',
    breakdown: {
      clarity: Math.round(score * 0.9),
      relevance: Math.round(score * 0.95),
      experience: Math.round(score * 0.85),
      skills: Math.round(score),
      achievements: Math.round(score * 0.7),
    },
    strengths: topSkills.length
      ? [`Relevant skills detected: ${topSkills.join(', ')}`]
      : ['Resume text extracted successfully'],
    improvements: [
      'Add more quantified achievements with measurable outcomes',
      'Include specific tools, frameworks, and technologies',
      'Improve role-wise project impact statements',
    ],
    topSkills,
    estimatedExperienceYears,

    // Premium-only placeholders
    chiScore: null,
    dimensions: null,
    marketPosition: null,
    peerComparison: null,
    growthInsights: null,
    salaryEstimate: null,
    roadmap: null,

    scoredAt: new Date().toISOString(),
  };
}

module.exports = {
  runFreeEngine,
  DEFAULT_SKILL_KEYWORDS,
  scoreResumeFree,
  estimateExperienceFree,
  getTopSkillsFree,
};
