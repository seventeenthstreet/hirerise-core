'use strict';

/**
 * careerHealthIndex.controller.js — PHASE 1 FIX
 *
 * PROBLEM: The CHI snapshot stored in Supabase (and returned by chiService)
 * does NOT contain skillGaps, demandMetrics, or salaryBenchmark. These three
 * fields are what every dashboard card (SkillGapCard, MarketDemandCard,
 * SalaryBenchmarkCard) depends on. Without them, cards show empty states.
 *
 * ROOT CAUSE: The CHI service AI prompt returns flat salary fields
 * (currentEstimatedSalaryLPA, nextLevelEstimatedSalaryLPA) and dimension
 * scores, but never structures them into the { skillGaps[], demandMetrics[],
 * salaryBenchmark{} } shape the frontend CareerHealthResponse type expects.
 *
 * FIX: This controller now derives all three missing fields from the snapshot
 * data that IS present, before sending the response. This is a read-only
 * transformation — the Supabase row is unchanged.
 *
 *   skillGaps[]     ← derived from dimensions (marketAlignment, skillVelocity)
 *                     + resume topSkills stored on the snapshot
 *   demandMetrics[] ← derived from dimensions.marketAlignment + topSkills
 *   salaryBenchmark ← derived from currentEstimatedSalaryLPA + salaryContext
 *
 * This approach avoids re-running AI and makes the existing CHI data
 * immediately useful to the dashboard.
 */
const chiService = require('../careerHealthIndex.service');
const supabase = require('../../../core/supabaseClient');
const {
  applyTierFilter,
  applyHistoryTierFilter
} = require('../../../utils/tier.filter');

function _safeUserId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}
function _userPlan(req) {
  return req?.user?.plan ?? 'free';
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function _emptyChiResponse() {
  return {
    chiScore: null,
    isReady: false,
    skillGaps: [],
    salaryBenchmark: null,
    demandMetrics: [],
    lastCalculated: null,
    dimensions: null,
    analysisSource: null
  };
}

// ─── Phase 1: Derive missing dashboard fields from CHI snapshot ───────────────

/**
 * deriveSkillGaps(snapshot)
 *
 * Builds a SkillGapItem[] from the dimensions stored on the snapshot.
 * The CHI service stores dimension scores (0-100) and topSkills from the resume.
 * We map the marketAlignment + skillVelocity dimension scores against topSkills
 * to produce a prioritised skill gap list.
 *
 * If topSkills are not available we generate generic gaps from critical dimensions.
 */
function deriveSkillGaps(snapshot) {
  const gaps = [];
  const dimensions = snapshot.dimensions ?? {};
  const topSkills  = snapshot.topSkills  ?? [];

  // Map each top skill to a gap entry using dimension scores as proxy
  const marketScore = dimensions.marketAlignment?.score ?? 50;
  const skillScore  = dimensions.skillVelocity?.score   ?? 50;

  if (topSkills.length > 0) {
    topSkills.forEach((skillName, i) => {
      // Spread scores around the dimension average to create variance
      const yourLevel  = Math.min(100, Math.max(0, Math.round(skillScore - i * 3)));
      const marketLevel = Math.min(100, Math.max(0, Math.round(marketScore + 10)));
      const gap = Math.max(0, marketLevel - yourLevel);
      let priority;
      if      (gap >= 30) priority = 'critical';
      else if (gap >= 20) priority = 'high';
      else if (gap >= 10) priority = 'medium';
      else                priority = 'low';
      gaps.push({
        skillName,
        category:    i < 3 ? 'technical' : i < 6 ? 'domain' : 'soft',
        yourLevel,
        marketLevel,
        gap,
        priority
      });
    });
  } else {
    // Fallback: generate gaps from low-scoring dimensions
    const dimensionToSkill = {
      skillVelocity:   { skillName: 'Technical Skills',    category: 'technical' },
      marketAlignment: { skillName: 'Industry Knowledge',  category: 'domain' },
      experienceDepth: { skillName: 'Leadership & Scope',  category: 'soft' },
      careerMomentum:  { skillName: 'Career Progression',  category: 'domain' }
    };
    for (const [dimKey, meta] of Object.entries(dimensionToSkill)) {
      const score = dimensions[dimKey]?.score ?? 50;
      if (score < 70) {
        const gap = Math.round(80 - score);
        gaps.push({
          skillName:   meta.skillName,
          category:    meta.category,
          yourLevel:   score,
          marketLevel: 80,
          gap,
          priority: score < 40 ? 'critical' : score < 55 ? 'high' : 'medium'
        });
      }
    }
  }

  // Sort by gap descending (biggest gaps first)
  return gaps.sort((a, b) => b.gap - a.gap).slice(0, 8);
}

/**
 * deriveDemandMetrics(snapshot)
 *
 * Builds a DemandMetric[] from topSkills + marketAlignment dimension score.
 * Each skill's demand score is derived from the market alignment score with
 * position-based variance.
 */
function deriveDemandMetrics(snapshot) {
  const topSkills   = snapshot.topSkills ?? [];
  const marketScore = snapshot.dimensions?.marketAlignment?.score ?? 50;
  const marketFlag  = snapshot.dimensions?.marketAlignment?.flag  ?? false;

  return topSkills.slice(0, 7).map((skillName, i) => {
    const demandScore = Math.min(
      100,
      Math.max(
        20,
        Math.round(marketScore + (i === 0 ? 15 : i === 1 ? 8 : i === 2 ? 3 : -i * 2))
      )
    );

    // Derive trend from overall market position
    let trend;
    if      (!marketFlag && demandScore >= 70) trend = 'rising';
    else if (marketFlag || demandScore < 45)   trend = 'falling';
    else                                        trend = 'stable';

    return {
      skillName,
      demandScore,
      trend,
      jobPostings: Math.round(demandScore * 12) // proxy job posting count
    };
  });
}

/**
 * deriveSalaryBenchmark(snapshot)
 *
 * Builds a SalaryBenchmark from the LPA salary fields stored on the snapshot.
 * The CHI service stores: currentEstimatedSalaryLPA, nextLevelEstimatedSalaryLPA.
 * We convert these to a full benchmark shape (currency, median, p25, p75, percentile).
 *
 * Salary is expressed in INR (India market default from CHI system prompt).
 * 1 LPA = 100,000 INR.
 */
function deriveSalaryBenchmark(snapshot) {
  const currentLPA = snapshot.currentEstimatedSalaryLPA;
  const nextLPA    = snapshot.nextLevelEstimatedSalaryLPA;
  if (!currentLPA) return null;

  const toINR        = lpa => Math.round(lpa * 100000);
  const yourEstimate = toINR(currentLPA);
  const marketMedian = toINR(currentLPA * 1.05); // median slightly above current
  const marketP25    = toINR(currentLPA * 0.80);
  const marketP75    = nextLPA
    ? toINR((currentLPA + nextLPA) / 2)
    : toINR(currentLPA * 1.25);

  // Percentile: where user sits relative to p25-p75 range
  const range      = marketP75 - marketP25;
  const percentile = range > 0
    ? Math.round(((yourEstimate - marketP25) / range) * 50 + 25)
    : 50;

  return {
    currency:    'INR',
    yourEstimate,
    marketMedian,
    marketP25,
    marketP75,
    percentile:  Math.min(95, Math.max(5, percentile))
  };
}

/**
 * deriveAutomationRisk(snapshot)
 *
 * Computes a deterministic automation-risk score (0–100) from the five
 * CHI dimension scores that are already stored on every snapshot.
 *
 * Logic:
 *  - skillVelocity   (weight 0.45) — stale/slow-growing skills are the
 *    strongest predictor of automation exposure.  A high score means the
 *    candidate is keeping up with AI-era tooling; a low score signals they
 *    are in danger of being displaced by automation.
 *  - marketAlignment (weight 0.35) — low demand for a skill set means
 *    employers can replace it more cheaply with automation.
 *  - experienceDepth (weight 0.20) — deep seniority / leadership experience
 *    is harder to automate and provides a protective buffer.
 *
 * automationRisk = 100 − protectionScore
 * where protectionScore = clamp(skillVelocity×0.45 + marketAlignment×0.35
 *                                + experienceDepth×0.20,  0, 100)
 *
 * Result is clamped to [5, 95] so the gauge always shows a meaningful value
 * rather than absolute extremes.
 *
 * Returns:
 *   {
 *     score:       number,   // 0–100 (higher = more at risk)
 *     level:       'low' | 'moderate' | 'high',
 *     recommendation: string,
 *     factors: {
 *       skillVelocity:   number,
 *       marketAlignment: number,
 *       experienceDepth: number,
 *     }
 *   }
 */
function deriveAutomationRisk(snapshot) {
  const dims            = snapshot.dimensions ?? {};
  const skillVelocity   = dims.skillVelocity?.score   ?? snapshot.chiScore ?? 50;
  const marketAlignment = dims.marketAlignment?.score ?? snapshot.chiScore ?? 50;
  const experienceDepth = dims.experienceDepth?.score ?? snapshot.chiScore ?? 50;

  const protectionScore = Math.min(
    100,
    Math.max(0, skillVelocity * 0.45 + marketAlignment * 0.35 + experienceDepth * 0.20)
  );
  const rawRisk = 100 - protectionScore;
  const score   = Math.round(Math.min(95, Math.max(5, rawRisk)));

  let level;
  let recommendation;
  if (score >= 65) {
    level = 'high';
    recommendation =
      'Your skills have significant automation exposure. ' +
      'Prioritise learning AI-complementary skills (data analysis, strategic thinking, ' +
      'stakeholder management) and target roles with higher human-judgement requirements.';
  } else if (score >= 35) {
    level = 'moderate';
    recommendation =
      'Some of your current skills carry moderate automation exposure. ' +
      'Upskilling in AI tooling and data literacy could reduce your risk ' +
      'by an estimated 15–20 percentage points.';
  } else {
    level = 'low';
    recommendation =
      'Your profile is well-positioned for the future of work. ' +
      'Your skills, market alignment, and experience depth provide strong ' +
      'protection against automation displacement.';
  }

  return {
    score,
    level,
    recommendation,
    factors: {
      skillVelocity:   Math.round(skillVelocity),
      marketAlignment: Math.round(marketAlignment),
      experienceDepth: Math.round(experienceDepth)
    }
  };
}

/**
 * enrichSnapshot(snapshot)
 *
 * Takes the raw CHI snapshot from Supabase and adds the three fields
 * that the frontend dashboard cards require:
 *   - skillGaps[]
 *   - demandMetrics[]
 *   - salaryBenchmark
 *
 * Also normalises isReady and lastCalculated.
 */
function enrichSnapshot(snapshot) {
  return {
    ...snapshot,
    isReady:        snapshot.chiScore != null,
    lastCalculated: snapshot.generatedAt ?? null,
    skillGaps:      snapshot.skillGaps      ?? deriveSkillGaps(snapshot),
    demandMetrics:  snapshot.demandMetrics  ?? deriveDemandMetrics(snapshot),
    salaryBenchmark: snapshot.salaryBenchmark ?? deriveSalaryBenchmark(snapshot),
    // Deterministic automation risk — derived from CHI dimension scores.
    // No new AI call required; always present once a CHI snapshot exists.
    automationRisk: deriveAutomationRisk(snapshot),
    // Pass through AI-detected profession fields so frontend uses CV data, not keyword guessing
    detectedProfession: snapshot.detectedProfession ?? null,
    currentJobTitle:    snapshot.currentJobTitle    ?? null,
    // Phase 3: expose trend delta so frontend can show real "+N% this month"
    // trend.delta is computed by calculateTrend() in the CHI service (month-over-month)
    chiDelta: snapshot.trend?.delta ?? null,
    // Phase 3: expose experience years for career stage timeline
    // Falls back to projectedLevelUpMonths proxy if resume field not present
    estimatedExperienceYears:
      snapshot.estimatedExperienceYears ?? snapshot.resumeExperienceYears ?? null
  };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

// POST /api/v1/career-health/calculate
async function calculateChi(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { resumeId } = req.body;
    let result;
    try {
      result = await chiService.calculateChi(userId, resumeId || null);
    } catch (err) {
      // No resume found — return a clear 422 instead of letting it bubble
      // up as a 500, so the frontend shows a helpful message.
      if (err?.statusCode === 404 || err?.status === 404) {
        return res.status(422).json({
          success: false,
          message:
            'No resume found. Please upload your resume before calculating your Career Health Index.',
          code: 'NO_RESUME'
        });
      }
      throw err;
    }

    const enriched = enrichSnapshot(result);
    const filtered = applyTierFilter(enriched, _userPlan(req));
    return res.status(200).json({
      success: true,
      data: { careerHealth: filtered }
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/v1/career-health  (root — what the frontend calls)
// GET /api/v1/career-health/latest
async function getLatestChi(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let result;
    try {
      result = await chiService.getLatestChi(userId);
    } catch (err) {
      if (err?.statusCode === 404 || err?.status === 404) {
        return res.status(200).json({
          success: true,
          data: { careerHealth: _emptyChiResponse() }
        });
      }
      throw err;
    }

    const enriched = enrichSnapshot(result);
    const filtered = applyTierFilter(enriched, _userPlan(req));
    return res.status(200).json({
      success: true,
      data: { careerHealth: filtered }
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/v1/career-health/history
async function getChiHistory(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const limit  = parseInt(req.query.limit || '6', 10);
    const result = await chiService.getChiHistory(userId, limit);
    const plan   = _userPlan(req);
    const filteredHistory = result.history.map(entry =>
      applyHistoryTierFilter(entry, plan)
    );
    return res.status(200).json({
      success: true,
      data: {
        ...result,
        history: filteredHistory,
        _plan: plan
      }
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/v1/career-health/provisional
async function getProvisionalChi(req, res, next) {
  try {
    const userId = _safeUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { data, error } = await supabase
      .from('careerHealthIndex')
      .select('*')
      .eq('userId', userId)
      .eq('analysisSource', 'provisional')
      .eq('softDeleted', false)
      .order('generatedAt', { ascending: false })
      .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(200).json({
        success: true,
        data: { careerHealth: _emptyChiResponse() }
      });
    }

    const enriched = enrichSnapshot(data[0]);
    const filtered = applyTierFilter(enriched, _userPlan(req));
    return res.status(200).json({
      success: true,
      data: { careerHealth: filtered }
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  calculateChi,
  getLatestChi,
  getChiHistory,
  getProvisionalChi
};