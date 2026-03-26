'use strict';

/**
 * services/jobAnalyzer.service.js — Job Fit Analyzer (Premium Feature)
 *
 * Compares a user's extracted skills against a job description.
 * Returns a jobFitScore, matchedSkills[], and missingSkills[].
 *
 * Storage: job_analyses/{analysisId}
 *
 * Usage:
 *   const { analyzeJobFit } = require('./jobAnalyzer.service');
 *   const result = await analyzeJobFit(userId, { jobDescription: '...', jobUrl: '...' });
 */

const crypto = require('crypto');
const { db } = require('../config/supabase');
const { FieldValue } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../config/anthropic.client');
};

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// ─── System prompt ────────────────────────────────────────────────────────────

const JOB_ANALYZER_PROMPT = `You are a senior technical recruiter and career coach.

Your task is to analyse a job description and compare it against a candidate's skill profile.

Extract required skills from the job description, then calculate match scores.

You MUST respond with ONLY valid JSON — no preamble, no explanation, no markdown fences.

Return this exact structure:
{
  "jobTitle": "<extracted job title or 'Unknown'>",
  "jobSkills": ["<skill 1>", "<skill 2>"],
  "matchedSkills": ["<skills the candidate has that match the job>"],
  "missingSkills": ["<skills the job requires that the candidate lacks>"],
  "jobFitScore": <integer 0-100>,
  "fitSummary": "<2 sentence summary of fit>",
  "topRecommendations": ["<action 1>", "<action 2>", "<action 3>"]
}

Scoring guide:
- 80-100: Strong fit — candidate meets most requirements
- 60-79:  Good fit — some gaps but strong foundation
- 40-59:  Moderate fit — significant skill gaps to address
- 0-39:   Poor fit — major upskilling required`;

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * analyzeJobFit(userId, payload)
 *
 * @param {string} userId
 * @param {{ jobDescription?: string, jobUrl?: string }} payload
 * @returns {Promise<JobFitResult>}
 */
async function analyzeJobFit(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { jobDescription, jobUrl } = payload || {};
  if (!jobDescription && !jobUrl) {
    throw new AppError(
      'Either jobDescription or jobUrl is required.',
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── Fetch user's skills from users collection ─────────────────────────────
  const userSnap = await db.collection('users').doc(userId).get();
  const userData = userSnap.data() || {};
  const userSkills = userData.skills || [];

  if (userSkills.length === 0) {
    throw new AppError(
      'No skills found on your profile. Please upload a resume first.',
      422, { userId }, ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── If URL provided, use the description as-is (URL fetching is client-side) ─
  const jobText = jobDescription || `Job URL: ${jobUrl}`;

  // ── Call Claude ───────────────────────────────────────────────────────────
  const anthropic = getAnthropicClient();
  const startMs = Date.now();

  let analysisResult;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: JOB_ANALYZER_PROMPT,
      messages: [{
        role: 'user',
        content: `Candidate Skills: ${JSON.stringify(userSkills)}\n\nJob Description:\n${jobText}`,
      }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    analysisResult = JSON.parse(stripJson(rawText));
    logger.info('[JobAnalyzer] Analysis complete', {
      userId, latencyMs: Date.now() - startMs, score: analysisResult.jobFitScore,
    });
  } catch (err) {
    logger.error('[JobAnalyzer] Claude call failed', { userId, error: err.message });
    throw new AppError(
      'Job analysis failed. Please try again.',
      502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }

  // ── Persist to job_analyses collection ───────────────────────────────────
  const analysisId = crypto.randomUUID();
  const now = new Date();

  const analysisDoc = {
    analysisId,
    userId,
    jobTitle:           analysisResult.jobTitle || 'Unknown',
    jobUrl:             jobUrl || null,
    jobDescription:     jobDescription ? jobDescription.slice(0, 2000) : null,
    jobSkills:          analysisResult.jobSkills || [],
    matchedSkills:      analysisResult.matchedSkills || [],
    missingSkills:      analysisResult.missingSkills || [],
    jobFitScore:        analysisResult.jobFitScore || 0,
    fitSummary:         analysisResult.fitSummary || '',
    topRecommendations: analysisResult.topRecommendations || [],
    userSkillsSnapshot: userSkills,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection('job_analyses').doc(analysisId).set(analysisDoc);

  // Update user doc with latest job fit score for dashboard card
  await db.collection('users').doc(userId).set({
    latestJobFit: {
      analysisId,
      jobTitle:    analysisResult.jobTitle || 'Unknown',
      score:       analysisResult.jobFitScore || 0,
      analyzedAt:  now.toISOString(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    analysisId,
    jobTitle:           analysisResult.jobTitle,
    jobFitScore:        analysisResult.jobFitScore,
    matchedSkills:      analysisResult.matchedSkills,
    missingSkills:      analysisResult.missingSkills,
    fitSummary:         analysisResult.fitSummary,
    topRecommendations: analysisResult.topRecommendations,
    jobSkills:          analysisResult.jobSkills,
  };
}

/**
 * getJobAnalysisHistory(userId, limit)
 * Returns past job analyses for the user.
 */
async function getJobAnalysisHistory(userId, limit = 10) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const snap = await db.collection('job_analyses')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  if (snap.empty) return { userId, analyses: [], total: 0 };

  const analyses = snap.docs.map(doc => {
    const d = doc.data();
    return {
      analysisId:    d.analysisId,
      jobTitle:      d.jobTitle,
      jobFitScore:   d.jobFitScore,
      matchedSkills: d.matchedSkills,
      missingSkills: d.missingSkills,
      createdAt:     d.createdAt?.toDate?.()?.toISOString?.() ?? d.createdAt,
    };
  });

  return { userId, analyses, total: snap.size };
}

module.exports = {
  analyzeJobFit,
  getJobAnalysisHistory,
};









