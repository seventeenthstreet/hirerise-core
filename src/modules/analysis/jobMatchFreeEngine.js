'use strict';

/**
 * jobMatchFreeEngine.js
 *
 * Rule-based JD analysis for free tier users.
 * Zero AI cost. Runs unlimited times.
 *
 * STRATEGY:
 *   Free result must feel genuinely useful — not a fake gate.
 *   Users should see a real match score and real keyword gaps.
 *   But strategic interpretation, alignment summary, and tailored CV
 *   are null → shown as blurred premium sections on the frontend.
 *
 *   This creates the right conversion psychology:
 *   "I can see there are 4 missing keywords, but I don't know how to fix them."
 *   → natural pull toward premium.
 *
 * Output shape mirrors premium engine exactly. Null = locked in UI.
 */

const logger = require('../../utils/logger');

// Common technical and soft skill keywords by domain
const SKILL_PATTERNS = [
  // Engineering
  'python', 'javascript', 'typescript', 'java', 'go', 'rust', 'c\\+\\+',
  'react', 'node', 'vue', 'angular', 'next\\.?js',
  'sql', 'postgresql', 'mongodb', 'redis', 'elasticsearch',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform',
  'ci/cd', 'devops', 'git', 'rest api', 'graphql', 'microservices',
  'machine learning', 'deep learning', 'nlp', 'data science',
  // Finance / Accounting
  'tally', 'sap', 'gst', 'tds', 'excel', 'power bi', 'tableau',
  'accounts payable', 'accounts receivable', 'reconciliation', 'audit',
  // Management
  'project management', 'agile', 'scrum', 'jira', 'stakeholder',
  'p&l', 'budgeting', 'forecasting', 'team lead', 'cross-functional',
  // Soft skills with weight
  'communication', 'leadership', 'problem.solving', 'analytical',
];

function extractKeywords(text) {
  const lower    = (text || '').toLowerCase();
  const matched  = new Set();

  for (const pattern of SKILL_PATTERNS) {
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(lower)) matched.add(pattern.replace(/\\b|\\/g, '').replace(/\\.\\?/g, ''));
  }

  return [...matched];
}

function scoreMatch(resumeKeywords, jdKeywords) {
  if (!jdKeywords.length) return 50; // no parseable JD keywords → neutral score
  const matched = jdKeywords.filter(k => resumeKeywords.includes(k));
  return Math.round((matched.length / jdKeywords.length) * 100);
}

/**
 * runJobMatchFree({ resumeText, jobDescription })
 *
 * @returns object — matchScore, presentKeywords, missingKeywords,
 *                   premium fields are null
 */
function runJobMatchFree({ resumeText, jobDescription }) {
  logger.debug('[JobMatchFreeEngine] Running keyword match');

  const resumeKeywords  = extractKeywords(resumeText);
  const jdKeywords      = extractKeywords(jobDescription);
  const matchScore      = scoreMatch(resumeKeywords, jdKeywords);
  const presentKeywords = jdKeywords.filter(k => resumeKeywords.includes(k));
  const missingKeywords = jdKeywords.filter(k => !resumeKeywords.includes(k));

  return {
    engine:     'free',
    matchScore,

    // Visible to free users — real, useful
    presentKeywords,
    missingKeywords: missingKeywords.slice(0, 5), // cap at 5 for free

    // Null = blurred premium sections on frontend
    alignmentSummary:        null,  // requires premium
    improvementSuggestions:  null,  // requires premium
    tailoredCV:              null,  // requires premium

    analysedAt: new Date().toISOString(),
  };
}

module.exports = { runJobMatchFree };