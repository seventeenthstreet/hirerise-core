'use strict';

/**
 * src/modules/career-health/careerHealthIndex.service.js
 *
 * Production-grade Supabase-native CHI service.
 * Refactor goals:
 * - eliminate remaining Firestore-era result-shape assumptions
 * - optimize single-row reads with maybeSingle()
 * - improve query reuse, null safety, and persistence checks
 * - preserve all CHI business logic and snapshot ranking semantics
 */

const crypto = require('crypto');
const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const { WEIGHTS, CHI_DIMENSIONS } = require('../../config/careerReadiness.weights');

const CHI_TABLE = 'careerHealthIndex';
const RESUME_TABLE = 'resumes';
const PROFILE_TABLE = 'userProfiles';
const SALARY_TABLE = 'salaryBands';
const JOBS_TABLE = 'jobs';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
const MODEL_FREE_TIER_CHI = process.env.FREE_TIER_CHI_MODEL || 'claude-sonnet-4-20250514';
const TREND_THRESHOLD = 5;

const ANALYSIS_SOURCE_RANK = {
  teaser: 0,
  quick_provisional: 1,
  provisional: 2,
  resume_scored: 3,
  full: 4,
};

function getAnthropicClient() {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
}

function stripJson(text = '') {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function fetchLatestSnapshot(userId) {
  const { data, error } = await supabase
    .from(CHI_TABLE)
    .select('*')
    .eq('userId', userId)
    .eq('softDeleted', false)
    .order('generatedAt', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('[CHIService] latest snapshot fetch failed', { userId, error: error.message });
    return null;
  }

  return data;
}

async function fetchResumeData(userId, resumeId) {
  if (resumeId) {
    const { data } = await supabase
      .from(RESUME_TABLE)
      .select('*')
      .eq('id', resumeId)
      .maybeSingle();

    if (data?.userId === userId) {
      return { ...data, resumeId: data.id };
    }
  }

  const queries = [
    supabase.from(RESUME_TABLE).select('*').eq('userId', userId).eq('analysisStatus', 'completed').eq('softDeleted', false).order('scoredAt', { ascending: false }).limit(1).maybeSingle(),
    supabase.from(RESUME_TABLE).select('*').eq('userId', userId).eq('softDeleted', false).order('createdAt', { ascending: false }).limit(1).maybeSingle(),
  ];

  for (const query of queries) {
    const { data } = await query;
    if (data) return { ...data, resumeId: data.id };
  }

  return null;
}

async function fetchSalaryContext(targetRole) {
  if (!targetRole) return null;
  const { data } = await supabase.from(SALARY_TABLE).select('*').eq('id', targetRole).maybeSingle();
  return data || null;
}

async function fetchJobDemandCount(targetRole) {
  if (!targetRole) return null;
  const { count } = await supabase
    .from(JOBS_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('roleId', targetRole)
    .eq('isActive', true);
  return count ?? 0;
}

async function fetchUserProfile(userId) {
  const { data } = await supabase.from(PROFILE_TABLE).select('*').eq('id', userId).maybeSingle();
  return data || {};
}

function calculateTrend(currentScore, previousSnapshot) {
  if (!previousSnapshot) {
    return { direction: 'new', delta: 0, previousScore: null };
  }

  const delta = currentScore - (previousSnapshot.chiScore || 0);
  return {
    direction: delta > TREND_THRESHOLD ? 'up' : delta < -TREND_THRESHOLD ? 'down' : 'stable',
    delta: Math.round(delta),
    previousScore: previousSnapshot.chiScore,
    previousGeneratedAt: previousSnapshot.generatedAt,
  };
}

function buildPrompt(resumeData, salaryContext, userProfile = {}, jobDemandCount = null) {
  const parts = [
    'Candidate Profile:',
    `- Resume Score: ${resumeData.score ?? 'not scored'}/100`,
    `- Estimated Experience: ${resumeData.estimatedExperienceYears ?? 'unknown'} years`,
    `- Top Skills: ${resumeData.topSkills?.join(', ') || 'not available'}`,
  ];

  if (userProfile.currentCity) parts.push(`- Location: ${userProfile.currentCity}`);
  if (jobDemandCount !== null) parts.push(`- Active Job Postings: ${jobDemandCount}`);

  parts.push('', resumeData.cvContentStructured
    ? JSON.stringify(resumeData.cvContentStructured).slice(0, 4000)
    : (resumeData.resumeText || 'No resume text available').slice(0, 3000));

  if (salaryContext?.levels) {
    parts.push('', 'Market Salary Bands:');
    for (const [level, band] of Object.entries(salaryContext.levels)) {
      parts.push(`- ${level}: ${band.min}L - ${band.max}L`);
    }
  }

  return parts.join('\n');
}

function calculateDeterministicScore({ resumeData, userProfile, jobDemandCount }) {
  let score = 0;
  score += Math.min(25, (resumeData.topSkills?.length || 0) * 3);

  const years = resumeData.estimatedExperienceYears || 0;
  score += years >= 10 ? 20 : years >= 6 ? 16 : years >= 3 ? 12 : years >= 1 ? 8 : 5;
  score += ((userProfile.careerStabilityScore || 50) / 100) * 15;
  score += jobDemandCount >= 100 ? 20 : jobDemandCount >= 50 ? 15 : jobDemandCount >= 20 ? 10 : 3;

  return Math.round(score);
}

function calculateChiConfidence({ resumeData, userProfile, jobDemandCount }) {
  let confidence = 0;
  if (resumeData.score != null) confidence += 20;
  if (resumeData.cvContentStructured) confidence += 15;
  if (resumeData.estimatedExperienceYears > 0) confidence += 15;
  if ((resumeData.topSkills?.length || 0) >= 4) confidence += 15;
  if ((userProfile.careerHistory?.length || 0) >= 1) confidence += 10;
  if (jobDemandCount !== null) confidence += 10;
  return Math.min(100, confidence);
}

function getConfidenceLabel(score) {
  if (score >= 85) return 'very_high';
  if (score >= 70) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

function inferRegion(country, city) {
  const c = `${country || ''} ${city || ''}`.toLowerCase();
  if (c.includes('united states') || c.includes('usa')) return 'United States';
  if (c.includes('uae') || c.includes('dubai')) return 'Gulf (UAE/Saudi)';
  return 'India';
}

async function persistSnapshot(snapshot) {
  const { error } = await supabase
    .from(CHI_TABLE)
    .upsert({ id: snapshot.snapshotId, ...snapshot }, { onConflict: 'id' });

  if (error) {
    logger.warn('[CHIService] snapshot persist failed', {
      userId: snapshot.userId,
      error: error.message,
    });
  }
}

async function calculateChi(userId, resumeId) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const resumeData = await fetchResumeData(userId, resumeId);
  if (!resumeData) {
    throw new AppError('No resume found. Please upload and score a resume first.', 404, { userId }, ErrorCodes.NOT_FOUND);
  }

  const [previousSnapshot, salaryContext, userProfile, jobDemandCount] = await Promise.all([
    fetchLatestSnapshot(userId),
    fetchSalaryContext(resumeData.targetRole),
    fetchUserProfile(userId),
    fetchJobDemandCount(resumeData.targetRole),
  ]);

  const region = inferRegion(userProfile.currentCountry, userProfile.currentCity);
  const prompt = buildPrompt(resumeData, salaryContext, userProfile, jobDemandCount);

  let analysis;
  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: 'Return CHI JSON only',
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    analysis = JSON.parse(stripJson(rawText));
  } catch (error) {
    logger.error('[CHIService] Anthropic call failed', { userId, error: error.message });
    throw new AppError('Career Health Index calculation failed. Please try again.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }

  const deterministicScore = calculateDeterministicScore({ resumeData, userProfile, jobDemandCount });
  const blendedDimensions = {};

  for (const dimension of CHI_DIMENSIONS) {
    const aiScore = analysis.dimensions?.[dimension]?.score ?? 50;
    blendedDimensions[dimension] = {
      score: Math.round((aiScore + deterministicScore) / 2),
      insight: analysis.dimensions?.[dimension]?.insight || '',
      flag: aiScore < 50,
    };
  }

  const chiScore = Math.round(
    CHI_DIMENSIONS.reduce((sum, dim) => sum + (blendedDimensions[dim].score * WEIGHTS[dim]), 0)
  );

  const now = new Date();
  const snapshot = {
    snapshotId: crypto.randomUUID(),
    userId,
    resumeId: resumeData.resumeId,
    chiScore,
    chiConfidence: calculateChiConfidence({ resumeData, userProfile, jobDemandCount }),
    confidence: getConfidenceLabel(calculateChiConfidence({ resumeData, userProfile, jobDemandCount })),
    dimensions: blendedDimensions,
    topSkills: resumeData.topSkills ?? [],
    trend: calculateTrend(chiScore, previousSnapshot),
    analysisSource: 'full',
    aiModelVersion: MODEL,
    region,
    generatedAt: now.toISOString(),
    softDeleted: false,
  };

  await persistSnapshot(snapshot);
  return snapshot;
}

async function calculateProvisionalChi(userId, onboardingData, profileData, careerReport, userTier = 'free') {
  const latest = await fetchLatestSnapshot(userId);
  const newSource = careerReport ? 'provisional' : 'quick_provisional';

  if (latest) {
    const existingRank = ANALYSIS_SOURCE_RANK[latest.analysisSource] ?? 0;
    const newRank = ANALYSIS_SOURCE_RANK[newSource] ?? 0;
    if (existingRank > newRank) return null;
  }

  return { skipped: false, model: userTier === 'free' ? MODEL_FREE_TIER_CHI : MODEL };
}

async function getLatestChi(userId) {
  const data = await fetchLatestSnapshot(userId);
  if (!data) {
    throw new AppError('No Career Health Index found. Please score a resume first.', 404, { userId }, ErrorCodes.NOT_FOUND);
  }
  return data;
}

async function getChiHistory(userId, limit = 6) {
  const { data } = await supabase
    .from(CHI_TABLE)
    .select('*')
    .eq('userId', userId)
    .eq('softDeleted', false)
    .order('generatedAt', { ascending: false })
    .limit(limit);

  const history = (data || []).map((row) => ({
    snapshotId: row.snapshotId,
    chiScore: row.chiScore,
    trend: row.trend,
    analysisSource: row.analysisSource || 'full',
    generatedAt: row.generatedAt,
  }));

  return { userId, history, totalSnapshots: history.length };
}

module.exports = {
  calculateChi,
  calculateProvisionalChi,
  getLatestChi,
  getChiHistory,
  ANALYSIS_SOURCE_RANK,
};