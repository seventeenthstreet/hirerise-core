'use strict';

/**
 * src/modules/career-health/controllers/careerHealthIndex.controller.js
 *
 * Supabase-native production controller for Career Health Index (CHI).
 *
 * Goals achieved:
 * - Zero Firebase / Firestore legacy assumptions
 * - Row-based Supabase queries with single-row fetches where appropriate
 * - Deterministic response enrichment without extra AI calls
 * - Strong null safety and defensive data normalization
 * - Consistent controller response/error flow
 * - Connection reuse via shared singleton Supabase client
 * - Drop-in compatible API response contract
 */

const chiService = require('../careerHealthIndex.service');
const { supabase } = require('../../../config/supabase');
const {
  applyTierFilter,
  applyHistoryTierFilter,
} = require('../../../utils/tier.filter');

const DEFAULT_DIMENSION_SCORE = 50;
const DEFAULT_HISTORY_LIMIT = 6;
const MAX_HISTORY_LIMIT = 24;
const CHI_TABLE = 'careerHealthIndex';

function getUserId(req) {
  return req?.user?.id ?? req?.user?.uid ?? null;
}

function getUserPlan(req) {
  return req?.user?.plan ?? 'free';
}

function isNotFoundError(error) {
  return error?.statusCode === 404 || error?.status === 404;
}

function createUnauthorizedResponse(res) {
  return res.status(401).json({
    success: false,
    message: 'Unauthorized',
  });
}

function createEmptyChiResponse() {
  return {
    chiScore: null,
    isReady: false,
    skillGaps: [],
    salaryBenchmark: null,
    demandMetrics: [],
    automationRisk: null,
    lastCalculated: null,
    dimensions: null,
    analysisSource: null,
    detectedProfession: null,
    currentJobTitle: null,
    chiDelta: null,
    estimatedExperienceYears: null,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getDimensionScore(snapshot, key) {
  return snapshot?.dimensions?.[key]?.score ?? snapshot?.chiScore ?? DEFAULT_DIMENSION_SCORE;
}

function deriveSkillGaps(snapshot = {}) {
  const gaps = [];
  const dimensions = snapshot.dimensions ?? {};
  const topSkills = Array.isArray(snapshot.topSkills) ? snapshot.topSkills : [];

  const marketScore = dimensions.marketAlignment?.score ?? DEFAULT_DIMENSION_SCORE;
  const skillScore = dimensions.skillVelocity?.score ?? DEFAULT_DIMENSION_SCORE;

  if (topSkills.length > 0) {
    for (const [index, skillName] of topSkills.entries()) {
      const yourLevel = clamp(Math.round(skillScore - index * 3), 0, 100);
      const marketLevel = clamp(Math.round(marketScore + 10), 0, 100);
      const gap = Math.max(0, marketLevel - yourLevel);

      const priority =
        gap >= 30 ? 'critical' :
        gap >= 20 ? 'high' :
        gap >= 10 ? 'medium' :
        'low';

      gaps.push({
        skillName,
        category: index < 3 ? 'technical' : index < 6 ? 'domain' : 'soft',
        yourLevel,
        marketLevel,
        gap,
        priority,
      });
    }
  } else {
    const dimensionToSkill = {
      skillVelocity: { skillName: 'Technical Skills', category: 'technical' },
      marketAlignment: { skillName: 'Industry Knowledge', category: 'domain' },
      experienceDepth: { skillName: 'Leadership & Scope', category: 'soft' },
      careerMomentum: { skillName: 'Career Progression', category: 'domain' },
    };

    for (const [dimensionKey, meta] of Object.entries(dimensionToSkill)) {
      const score = dimensions[dimensionKey]?.score ?? DEFAULT_DIMENSION_SCORE;
      if (score >= 70) continue;

      gaps.push({
        skillName: meta.skillName,
        category: meta.category,
        yourLevel: score,
        marketLevel: 80,
        gap: Math.round(80 - score),
        priority: score < 40 ? 'critical' : score < 55 ? 'high' : 'medium',
      });
    }
  }

  return gaps.sort((a, b) => b.gap - a.gap).slice(0, 8);
}

function deriveDemandMetrics(snapshot = {}) {
  const topSkills = Array.isArray(snapshot.topSkills) ? snapshot.topSkills : [];
  const marketScore = snapshot.dimensions?.marketAlignment?.score ?? DEFAULT_DIMENSION_SCORE;
  const marketFlag = Boolean(snapshot.dimensions?.marketAlignment?.flag);

  return topSkills.slice(0, 7).map((skillName, index) => {
    const offset = index === 0 ? 15 : index === 1 ? 8 : index === 2 ? 3 : -index * 2;
    const demandScore = clamp(Math.round(marketScore + offset), 20, 100);

    const trend =
      !marketFlag && demandScore >= 70 ? 'rising' :
      marketFlag || demandScore < 45 ? 'falling' :
      'stable';

    return {
      skillName,
      demandScore,
      trend,
      jobPostings: Math.round(demandScore * 12),
    };
  });
}

function deriveSalaryBenchmark(snapshot = {}) {
  const currentLPA = Number(snapshot.currentEstimatedSalaryLPA);
  const nextLPA = Number(snapshot.nextLevelEstimatedSalaryLPA);

  if (!Number.isFinite(currentLPA) || currentLPA <= 0) {
    return null;
  }

  const toINR = (lpa) => Math.round(lpa * 100000);

  const yourEstimate = toINR(currentLPA);
  const marketMedian = toINR(currentLPA * 1.05);
  const marketP25 = toINR(currentLPA * 0.8);
  const marketP75 = Number.isFinite(nextLPA) && nextLPA > 0
    ? toINR((currentLPA + nextLPA) / 2)
    : toINR(currentLPA * 1.25);

  const range = marketP75 - marketP25;
  const percentile = range > 0
    ? Math.round(((yourEstimate - marketP25) / range) * 50 + 25)
    : 50;

  return {
    currency: 'INR',
    yourEstimate,
    marketMedian,
    marketP25,
    marketP75,
    percentile: clamp(percentile, 5, 95),
  };
}

function deriveAutomationRisk(snapshot = {}) {
  const skillVelocity = getDimensionScore(snapshot, 'skillVelocity');
  const marketAlignment = getDimensionScore(snapshot, 'marketAlignment');
  const experienceDepth = getDimensionScore(snapshot, 'experienceDepth');

  const protectionScore = clamp(
    skillVelocity * 0.45 + marketAlignment * 0.35 + experienceDepth * 0.2,
    0,
    100,
  );

  const score = Math.round(clamp(100 - protectionScore, 5, 95));

  let level;
  let recommendation;

  if (score >= 65) {
    level = 'high';
    recommendation =
      'Your skills have significant automation exposure. Prioritise AI-complementary capabilities such as strategic thinking, stakeholder management, and advanced data workflows.';
  } else if (score >= 35) {
    level = 'moderate';
    recommendation =
      'Some of your current skills carry moderate automation exposure. Upskilling in AI tooling and data literacy could materially reduce this risk.';
  } else {
    level = 'low';
    recommendation =
      'Your profile is strongly positioned for the future of work with good protection against automation displacement.';
  }

  return {
    score,
    level,
    recommendation,
    factors: {
      skillVelocity: Math.round(skillVelocity),
      marketAlignment: Math.round(marketAlignment),
      experienceDepth: Math.round(experienceDepth),
    },
  };
}

function enrichSnapshot(snapshot = {}) {
  return {
    ...snapshot,
    isReady: snapshot.chiScore != null,
    lastCalculated: snapshot.generatedAt ?? null,
    skillGaps: Array.isArray(snapshot.skillGaps)
      ? snapshot.skillGaps
      : deriveSkillGaps(snapshot),
    demandMetrics: Array.isArray(snapshot.demandMetrics)
      ? snapshot.demandMetrics
      : deriveDemandMetrics(snapshot),
    salaryBenchmark: snapshot.salaryBenchmark ?? deriveSalaryBenchmark(snapshot),
    automationRisk: snapshot.automationRisk ?? deriveAutomationRisk(snapshot),
    detectedProfession: snapshot.detectedProfession ?? null,
    currentJobTitle: snapshot.currentJobTitle ?? null,
    chiDelta: snapshot.trend?.delta ?? null,
    estimatedExperienceYears:
      snapshot.estimatedExperienceYears ??
      snapshot.resumeExperienceYears ??
      null,
  };
}

function sendCareerHealthResponse(res, payload, plan) {
  return res.status(200).json({
    success: true,
    data: {
      careerHealth: applyTierFilter(payload, plan),
    },
  });
}

async function calculateChi(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return createUnauthorizedResponse(res);

    const resumeId = req?.body?.resumeId ?? null;

    let snapshot;
    try {
      snapshot = await chiService.calculateChi(userId, resumeId);
    } catch (error) {
      if (isNotFoundError(error)) {
        return res.status(422).json({
          success: false,
          message: 'No resume found. Please upload your resume before calculating your Career Health Index.',
          code: 'NO_RESUME',
        });
      }
      throw error;
    }

    return sendCareerHealthResponse(res, enrichSnapshot(snapshot), getUserPlan(req));
  } catch (error) {
    return next(error);
  }
}

async function getLatestChi(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return createUnauthorizedResponse(res);

    let snapshot;
    try {
      snapshot = await chiService.getLatestChi(userId);
    } catch (error) {
      if (isNotFoundError(error)) {
        return res.status(200).json({
          success: true,
          data: { careerHealth: createEmptyChiResponse() },
        });
      }
      throw error;
    }

    return sendCareerHealthResponse(res, enrichSnapshot(snapshot), getUserPlan(req));
  } catch (error) {
    return next(error);
  }
}

async function getChiHistory(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return createUnauthorizedResponse(res);

    const requestedLimit = Number.parseInt(req?.query?.limit ?? `${DEFAULT_HISTORY_LIMIT}`, 10);
    const limit = clamp(
      Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_HISTORY_LIMIT,
      1,
      MAX_HISTORY_LIMIT,
    );

    const result = await chiService.getChiHistory(userId, limit);
    const plan = getUserPlan(req);

    return res.status(200).json({
      success: true,
      data: {
        ...result,
        history: Array.isArray(result?.history)
          ? result.history.map((entry) => applyHistoryTierFilter(entry, plan))
          : [],
        _plan: plan,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getProvisionalChi(req, res, next) {
  try {
    const userId = getUserId(req);
    if (!userId) return createUnauthorizedResponse(res);

    const { data, error } = await supabase
      .from(CHI_TABLE)
      .select('*')
      .eq('userId', userId)
      .eq('analysisSource', 'provisional')
      .eq('softDeleted', false)
      .order('generatedAt', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(200).json({
        success: true,
        data: { careerHealth: createEmptyChiResponse() },
      });
    }

    return sendCareerHealthResponse(res, enrichSnapshot(data), getUserPlan(req));
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  calculateChi,
  getLatestChi,
  getChiHistory,
  getProvisionalChi,
};
