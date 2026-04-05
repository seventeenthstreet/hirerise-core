'use strict';

/**
 * @file services/jobAnalyzer.service.js
 * @description
 * Premium Job Fit Analyzer service (Supabase-native).
 *
 * Features:
 * - deterministic Supabase row-based persistence
 * - minimal column selection
 * - strict null-safe payload normalization
 * - resilient AI JSON parsing
 * - production-safe logging
 * - isolated non-fatal dashboard update
 * - optimized history retrieval
 */

const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../config/anthropic.client');
}

function stripJson(text = '') {
  return String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeAnalysisResult(result = {}) {
  return {
    jobTitle:
      typeof result.jobTitle === 'string' && result.jobTitle.trim()
        ? result.jobTitle.trim()
        : 'Unknown',
    jobSkills: normalizeStringArray(result.jobSkills),
    matchedSkills: normalizeStringArray(result.matchedSkills),
    missingSkills: normalizeStringArray(result.missingSkills),
    jobFitScore: Number.isFinite(result.jobFitScore)
      ? Math.max(0, Math.min(100, Math.round(result.jobFitScore)))
      : 0,
    fitSummary:
      typeof result.fitSummary === 'string' ? result.fitSummary.trim() : '',
    topRecommendations: normalizeStringArray(result.topRecommendations),
  };
}

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
- 60-79: Good fit — some gaps but strong foundation
- 40-59: Moderate fit — significant skill gaps to address
- 0-39: Poor fit — major upskilling required`;

async function fetchUserSkills(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('skills')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new AppError(
      error.message,
      500,
      { userId, stage: 'fetch_user_skills' },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  const skills = normalizeStringArray(data?.skills);

  if (!skills.length) {
    throw new AppError(
      'No skills found on your profile. Please upload a resume first.',
      422,
      { userId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return skills;
}

async function runAIJobAnalysis(userSkills, jobText, userId) {
  const anthropic = getAnthropicClient();

  if (!anthropic) {
    throw new AppError(
      'Anthropic client unavailable in current environment.',
      500,
      { userId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  const startMs = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: JOB_ANALYZER_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Candidate Skills: ${JSON.stringify(
            userSkills
          )}\n\nJob Description:\n${jobText}`,
        },
      ],
    });

    const rawText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const parsed = JSON.parse(stripJson(rawText));
    const normalized = normalizeAnalysisResult(parsed);

    logger.info('[JobAnalyzer] AI analysis completed', {
      userId,
      latencyMs: Date.now() - startMs,
      score: normalized.jobFitScore,
      matchedSkills: normalized.matchedSkills.length,
      missingSkills: normalized.missingSkills.length,
    });

    return normalized;
  } catch (error) {
    logger.error('[JobAnalyzer] AI analysis failed', {
      userId,
      error: error.message,
    });

    throw new AppError(
      'Job analysis failed. Please try again.',
      502,
      { userId },
      ErrorCodes.EXTERNAL_SERVICE_ERROR
    );
  }
}

async function persistAnalysis(userId, payload) {
  const { jobDescription, jobUrl, userSkills, analysis } = payload;

  const analysisId = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = {
    id: analysisId,
    analysisId,
    userId,
    jobTitle: analysis.jobTitle,
    jobUrl: jobUrl || null,
    jobDescription: jobDescription?.slice(0, 5000) || null,
    jobSkills: analysis.jobSkills,
    matchedSkills: analysis.matchedSkills,
    missingSkills: analysis.missingSkills,
    jobFitScore: analysis.jobFitScore,
    fitSummary: analysis.fitSummary,
    topRecommendations: analysis.topRecommendations,
    userSkillsSnapshot: userSkills,
    createdAt: now,
    updatedAt: now,
  };

  const { error } = await supabase
    .from('job_analyses')
    .upsert(row, { onConflict: 'id' });

  if (error) {
    logger.error('[JobAnalyzer] Failed to persist analysis', {
      userId,
      error: error.message,
    });

    throw new AppError(
      error.message,
      500,
      { userId, stage: 'persist_analysis' },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return { analysisId, now };
}

async function updateLatestJobFit(userId, analysisId, analysis, timestamp) {
  const { error } = await supabase
    .from('users')
    .update({
      latestJobFit: {
        analysisId,
        jobTitle: analysis.jobTitle,
        score: analysis.jobFitScore,
        analyzedAt: timestamp,
      },
      updatedAt: timestamp,
    })
    .eq('id', userId);

  if (error) {
    logger.warn('[JobAnalyzer] Failed latestJobFit dashboard update', {
      userId,
      error: error.message,
    });
  }
}

async function analyzeJobFit(userId, payload = {}) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const { jobDescription, jobUrl } = payload;

  if (!jobDescription && !jobUrl) {
    throw new AppError(
      'Either jobDescription or jobUrl is required.',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const userSkills = await fetchUserSkills(userId);
  const jobText = jobDescription || `Job URL: ${jobUrl}`;

  const analysis = await runAIJobAnalysis(userSkills, jobText, userId);

  const { analysisId, now } = await persistAnalysis(userId, {
    jobDescription,
    jobUrl,
    userSkills,
    analysis,
  });

  await updateLatestJobFit(userId, analysisId, analysis, now);

  return {
    analysisId,
    ...analysis,
  };
}

async function getJobAnalysisHistory(userId, limit = 10) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);

  const { data, error } = await supabase
    .from('job_analyses')
    .select(
      `
      analysisId,
      jobTitle,
      jobFitScore,
      matchedSkills,
      missingSkills,
      createdAt
    `
    )
    .eq('userId', userId)
    .order('createdAt', { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new AppError(
      error.message,
      500,
      { userId, stage: 'history_fetch' },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return {
    userId,
    analyses: data || [],
    total: data?.length || 0,
  };
}

module.exports = {
  analyzeJobFit,
  getJobAnalysisHistory,
};