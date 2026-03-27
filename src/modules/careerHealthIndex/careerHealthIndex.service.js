'use strict';

/**
 * MIGRATION: db.collection() → supabase.from()
 *
 * All db.collection() shim calls in this file have been replaced with
 * direct supabase.from() calls. Result shapes mirror the Firestore shim:
 *   { data, error } from supabase  →  unwrapped to plain objects
 *   .maybeSingle()  for single-doc reads (returns null not error on 0 rows)
 *   .select('*')    for collection queries
 *
 * Batch writes → Promise.all([supabase.from(T).upsert(...), ...])
 * Transactions → sequential awaits (best-effort, same as shim behaviour)
 */

/**
 * careerHealthIndex.service.js — UPDATED
 *
 * GAP S2:  calculateProvisionalChi() — runs after /career-report without a
 *           scored resume, using onboarding education/experience/skills data.
 *           Stored with analysisSource:'provisional'. Replaced by full CHI
 *           once the user uploads/generates and scores a resume.
 *
 * GAP C1:  buildPrompt() now uses cvContentStructured (structured JSON from
 *           generateCV) when available, avoiding the 3000-char text truncation.
 *
 * GAP C2:  Market region parameterised in CHI_SYSTEM_PROMPT.
 *
 * GAP C3:  Declared currentSalaryLPA + expectedSalaryLPA included in buildPrompt.
 *
 * GAP C4:  careerGaps[] included in prompt context.
 *
 * GAP C5:  jobDemandCount from jobs collection passed as market signal.
 *
 * GAP C6:  CHI trend stability threshold raised from 2 to 5 points.
 */

const crypto = require('crypto');
const supabase = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
// PROMPT-3: import canonical weights from config — single source of truth
const { WEIGHTS, CHI_DIMENSIONS } = require('../../config/careerReadiness.weights');

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';

// HOTFIX: Sonnet model used for free-tier provisional CHI to avoid double Opus spend
const MODEL_FREE_TIER_CHI = process.env.FREE_TIER_CHI_MODEL || 'claude-sonnet-4-20250514';

function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// ─── GAP C6: raised from 2 to 5 ──────────────────────────────────────────────
const TREND_THRESHOLD = 5;

// P2-04: CHI analysisSource state machine.
// Higher rank = higher quality. A snapshot should only replace an existing one
// if the new state's rank is >= the existing state's rank.
// This prevents a quick_provisional from overwriting a full CHI on retry.
const ANALYSIS_SOURCE_RANK = {
  teaser:             0,   // industry average — never stored per user
  quick_provisional:  1,   // from POST /quick-start (4 fields, no career report)
  provisional:        2,   // from POST /career-report (onboarding data, no resume)
  resume_scored:      3,   // resume uploaded + scorer ran
  full:               4,   // resume scored + Track B enrichment
};

// PROMPT-3: weights injected from careerReadiness.weights.js — not hardcoded
function buildChiSystemPrompt(region = 'India') {
  const weightLines = CHI_DIMENSIONS
    .map(d => `- ${d}: ${(WEIGHTS[d] * 100).toFixed(0)}%`)
    .join('\n');

  return `You are a senior career intelligence analyst specialising in the ${region} job market.

Your task is to evaluate a candidate's career health across 5 dimensions and return a structured JSON score.

Rules:
- Be objective and data-driven. No motivational language.
- Base salary estimates on ${region} market rates.
- Be conservative in all estimates.
- If data is insufficient for a dimension, score it 40 and flag it.
- Return JSON only. No markdown. No commentary.

Dimensions to score (0-100 each):
1. skillVelocity      — Are the candidate's skills current and growing relative to market demand?
2. experienceDepth    — Is their career progression strong for their years of experience?
3. marketAlignment    — How well does their profile match current hiring demand in ${region}?
4. salaryTrajectory   — Based on their level and experience, are they on track, underpaid, or above market?
5. careerMomentum     — Is their career moving forward consistently (no long gaps, regular growth)?

Return this exact structure:
{
  "chiScore": <integer 0-100, weighted composite>,
  "detectedProfession": "<the candidate's actual profession/domain detected from their CV — e.g. 'Accountant', 'Software Engineer', 'Doctor', 'HR Manager', 'Data Scientist', 'Nurse', 'Teacher', 'Marketing Manager'. Be specific and accurate — this drives career path suggestions.>",
  "currentJobTitle": "<their most recent job title exactly as written in their CV>",
  "dimensions": {
    "skillVelocity":   { "score": <0-100>, "insight": "<max 15 words>", "flag": <true|false> },
    "experienceDepth": { "score": <0-100>, "insight": "<max 15 words>", "flag": <true|false> },
    "marketAlignment": { "score": <0-100>, "insight": "<max 15 words>", "flag": <true|false> },
    "salaryTrajectory":{ "score": <0-100>, "insight": "<max 15 words>", "flag": <true|false> },
    "careerMomentum":  { "score": <0-100>, "insight": "<max 15 words>", "flag": <true|false> }
  },
  "topStrength": "<single biggest career strength in max 15 words>",
  "criticalGap":  "<single most urgent thing to fix in max 15 words>",
  "marketPosition": "top10 | top25 | top50 | bottom50",
  "peerComparison": "<how they compare to peers at same experience level, max 20 words>",
  "projectedLevelUpMonths": <integer>,
  "currentEstimatedSalaryLPA": <number>,
  "nextLevelEstimatedSalaryLPA": <number>
}

Weighting for chiScore:
${weightLines}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchResumeData(userId, resumeId) {
  if (resumeId) {
    const { data: _rdoc } = await supabase.from('resumes').select('*').eq('id', resumeId).maybeSingle();
    if (_rdoc && _rdoc.userId === userId) return { ..._rdoc, resumeId };
  }

  // Primary: find a fully-scored resume
  const { data: _sdocs } = await supabase.from('resumes').select('*').eq('userId', userId).eq('analysisStatus', 'completed').eq('softDeleted', false).order('scoredAt', {ascending:false}).limit(1);
  if (_sdocs?.length) return { ..._sdocs[0], resumeId: _sdocs[0].id };

  // Fallback: use any non-deleted resume even if scoring is still pending.
  // This handles onboarding-path users whose CV was generated but not yet scored.
  // The CHI AI prompt can still run against cvContentStructured / resumeText.
  const { data: _adocs } = await supabase.from('resumes').select('*').eq('userId', userId).eq('softDeleted', false).order('createdAt', {ascending:false}).limit(1);
  if (_adocs?.length) return { ..._adocs[0], resumeId: _adocs[0].id };

  return null;
}

async function fetchPreviousSnapshot(userId) {
  try {
    const { data: _chiSnap } = await supabase.from('careerHealthIndex').select('*').eq('userId', userId).eq('softDeleted', false).order('generatedAt', {ascending:false}).limit(1);
    if (!_chiSnap?.length) return null;
    return _chiSnap[0];
  } catch { return null; }
}

async function fetchSalaryContext(targetRole) {
  if (!targetRole) return null;
  try {
    const { data: _sb } = await supabase.from('salaryBands').select('*').eq('id', targetRole).maybeSingle();
    return _sb || null;
  } catch { return null; }
}

// GAP C5: fetch job demand count as market signal
async function fetchJobDemandCount(targetRole) {
  if (!targetRole) return null;
  try {
    const { count: _jcount, error: _je } = await supabase.from('jobs').select('*', {count:'exact',head:true}).eq('roleId', targetRole).eq('isActive', true);
    return _jcount || 0;
  } catch { return null; }
}

// GAP C6: trend threshold raised to 5
function calculateTrend(currentScore, previousSnapshot) {
  if (!previousSnapshot) return { direction: 'new', delta: 0, previousScore: null };
  const delta = currentScore - previousSnapshot.chiScore;
  return {
    direction:           delta > TREND_THRESHOLD ? 'up' : delta < -TREND_THRESHOLD ? 'down' : 'stable',
    delta:               Math.round(delta),
    previousScore:       previousSnapshot.chiScore,
    previousGeneratedAt: previousSnapshot.generatedAt,
  };
}

// GAP C1: use structured cvContent when available (avoids 3000-char truncation)
// GAP C3: include declared salary
// GAP C4: include career gaps
// GAP C5: include job demand count
function buildPrompt(resumeData, salaryContext, userProfile = {}, jobDemandCount = null) {

  const parts = [
    'Candidate Profile:',
    `- Resume Score: ${resumeData.score ?? 'not scored'}/100`,
    `- Tier: ${resumeData.tier ?? 'unknown'}`,
    `- Estimated Experience: ${resumeData.estimatedExperienceYears ?? 'unknown'} years`,
    `- Top Skills: ${resumeData.topSkills?.join(', ') || 'not available'}`,
    `- Target Role: ${resumeData.targetRole || 'not specified'}`
  ];

  // GAP-01: User Profile Context — 5 fields that were never read before this fix
  // These unlock real scoring for: market alignment (currentCity, expectedRoleIds),
  // salary trajectory (currentSalaryLPA), skill velocity (skills[]), career momentum (careerHistory[])
  parts.push('', 'User Profile Context:');

  if (userProfile.currentCity)    parts.push(`- Location: ${userProfile.currentCity}`);
  if (userProfile.currentCountry) parts.push(`- Country: ${userProfile.currentCountry}`);

  // expectedRoleIds → market alignment target (which role/band to compare against)
  if (userProfile.expectedRoleIds?.length) {
    parts.push(`- Target Roles: ${userProfile.expectedRoleIds.slice(0, 3).join(', ')}`);
  }
  if (userProfile.industryId) {
    parts.push(`- Primary Industry: ${userProfile.industryText || userProfile.industryId}`);
  }

  // skills[] with proficiency → skill velocity dimension
  // GAP-04: prefer canonicalSkills (merged from all 3 sources) over raw profile.skills
  const skillSource = userProfile.canonicalSkills || userProfile.skills || [];
  if (skillSource.length) {
    const skillList = skillSource
      .slice(0, 15)
      .map(s => s.proficiency ? `${s.name}(${s.proficiency})` : s.name)
      .join(', ');
    const sourceLabel = userProfile.canonicalSkills ? 'canonical' : 'self-declared';
    parts.push(`- Skills (${sourceLabel}): ${skillList}`);
  }

  // GAP-06: server-computed tenure (more reliable than AI-extracted estimatedExperienceYears)
  if (userProfile.totalExperienceYears) {
    parts.push(`- Verified Total Experience: ${userProfile.totalExperienceYears} years`);
  }

  // careerHistory[] → career momentum arc (roleId + durationMonths are the canonical fields)
  // P2-02: careerHistory → career momentum arc.
  // Handles both Track B canonical entries (roleId + durationMonths) and
  // Track A synthetic fallback entries (jobTitle + durationMonths, source: 'track_a_fallback').
  if (userProfile.careerHistory?.length) {
    const histSummary = userProfile.careerHistory
      .slice(0, 5)
      .map(r => {
        const label  = r.roleId || r.jobTitle || 'Unknown Role';
        const months = r.durationMonths ? r.durationMonths + 'mo' : 'duration unknown';
        const current = r.isCurrent ? ' [current]' : '';
        const company = r.company ? ' @ ' + r.company : '';
        return label + company + '(' + months + ')' + current;
      })
      .join(', ');
    const sourceNote = userProfile.careerHistory.some(r => r.source === 'track_a_fallback')
      ? ' [derived from onboarding data]' : '';
    parts.push('- Career History' + sourceNote + ': ' + histSummary);
  }

  if (userProfile.careerStabilityScore !== undefined) {
    parts.push(`- Career Stability Score: ${userProfile.careerStabilityScore}/100`);
  }

  if (userProfile.promotionVelocity) {
    parts.push(`- Promotion Velocity: ${userProfile.promotionVelocity}`);
  }

  if (userProfile.specializationType) {
    parts.push(`- Specialization Pattern: ${userProfile.specializationType}`);
  }

  if (userProfile.impactSignal) {
    parts.push(`- Responsibility Impact Signal: ${userProfile.impactSignal}`);
  }

  // GAP C3: declared salary
  if (userProfile.currentSalaryLPA)  parts.push(`- Declared Current Salary: ${userProfile.currentSalaryLPA} LPA`);
  if (userProfile.expectedSalaryLPA) parts.push(`- Declared Expected Salary: ${userProfile.expectedSalaryLPA} LPA`);

  // GAP C5: job demand signal
  if (jobDemandCount !== null) parts.push(`- Active Job Postings for Target Role: ${jobDemandCount}`);

  // GAP C1: prefer structured cvContent over raw text (no truncation)
  if (resumeData.cvContentStructured) {
    parts.push('', 'Structured CV Data (JSON):');
    parts.push(JSON.stringify(resumeData.cvContentStructured, null, 2).slice(0, 4000));
  } else {
    parts.push('', 'Resume Text (excerpt):');
    parts.push(resumeData.resumeText?.trim().slice(0, 3000) || 'No resume text available');
  }

  if (resumeData.scoreBreakdown) {
    parts.push('', 'Score Breakdown:');
    for (const [key, val] of Object.entries(resumeData.scoreBreakdown)) parts.push(`- ${key}: ${val}/100`);
  }

  // GAP C4: career gaps context
  if (resumeData.careerGaps?.length) {
    parts.push('', 'Declared Career Gaps:');
    for (const gap of resumeData.careerGaps) parts.push(`- ${gap.startDate} to ${gap.endDate}: ${gap.reason}${gap.description ? ' (' + gap.description + ')' : ''}`);
  }

  if (salaryContext?.levels) {
    parts.push('', 'Market Salary Bands (LPA):');
    for (const [level, band] of Object.entries(salaryContext.levels)) parts.push(`- ${level}: ${band.min}L - ${band.max}L`);
  }

  return parts.join('\n');
}
// ─── Deterministic Pre-Score Engine ─────────────────────────────

function calculateDeterministicScore({
  resumeData,
  userProfile,
  jobDemandCount
}) {

  let score = 0;

  // ── Skill Depth (0–25)
  const skillsCount = resumeData.topSkills?.length || 0;
  const skillScore = Math.min(25, skillsCount * 3);
  score += skillScore;

  // ── Experience Depth (0–20)
  const years = resumeData.estimatedExperienceYears || 0;
  const experienceScore =
    years >= 10 ? 20 :
    years >= 6  ? 16 :
    years >= 3  ? 12 :
    years >= 1  ? 8  : 5;
  score += experienceScore;

  // ── Career Stability (0–15)
  const stability = userProfile.careerStabilityScore || 50;
  score += (stability / 100) * 15;

  // ── Market Demand (0–20)
  const demandScore =
    jobDemandCount >= 100 ? 20 :
    jobDemandCount >= 50  ? 15 :
    jobDemandCount >= 20  ? 10 :
    jobDemandCount >= 5   ? 6  : 3;
  score += demandScore;

  // ── Impact Signal (0–10)
  const impactMap = { high: 10, medium: 6, low: 3 };
  score += impactMap[userProfile.impactSignal] || 5;

  // ── Specialization Bonus (0–10)
  const specMap = {
    deep_specialist: 10,
    balanced: 7,
    broad_generalist: 5
  };
  score += specMap[userProfile.specializationType] || 5;

  return Math.round(score);
}
// ─── CHI Confidence Engine ─────────────────────────────

function calculateChiConfidence({
  resumeData,
  userProfile,
  jobDemandCount
}) {

  let confidence = 0;

  // Resume scored
  if (resumeData.score !== null && resumeData.score !== undefined)
    confidence += 20;

  // Structured CV
  if (resumeData.cvContentStructured)
    confidence += 15;

  // Experience years
  if (resumeData.estimatedExperienceYears > 0)
    confidence += 15;

  // Skills depth
  if ((resumeData.topSkills?.length || 0) >= 4)
    confidence += 15;

  // Career history
  if ((userProfile.careerHistory?.length || 0) >= 1)
    confidence += 10;

  // Salary declared
  if (userProfile.currentSalaryLPA || userProfile.expectedSalaryLPA)
    confidence += 10;

  // Market demand signal
  if (jobDemandCount !== null)
    confidence += 10;

  // Target role
  if (resumeData.targetRole)
    confidence += 5;

  return Math.min(100, confidence);
}

/**
 * P2-03: Convert numeric confidence score (0-100) to a labelled tier.
 * Frontend uses the label to decide how to render the score (grey/blue/normal/badge).
 *
 * Thresholds:
 *   < 40  → 'low'       — based on very limited data
 *   40-69 → 'moderate'  — reasonable estimate, more data would help
 *   70-84 → 'high'      — solid data foundation
 *   85+   → 'very_high' — comprehensive profile
 */
function getConfidenceLabel(score) {
  if (score >= 85) return 'very_high';
  if (score >= 70) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

async function calculateChi(userId, resumeId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  try {

    // ── 1. Fetch resume ──────────────────────────────────────────────────────
    const resumeData = await fetchResumeData(userId, resumeId);
    if (!resumeData) {
      throw new AppError(
        'No resume found. Please upload and score a resume first.',
        404, { userId }, ErrorCodes.NOT_FOUND
      );
    }

    // ── 2. Fetch supporting context in parallel ───────────────────────────────
    const [previousSnapshot, salaryContext, userProfile, jobDemandCount] = await Promise.all([
      fetchPreviousSnapshot(userId),
      fetchSalaryContext(resumeData.targetRole),
      supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle().then(({data})=>data||{}),
      fetchJobDemandCount(resumeData.targetRole),
    ]);

    // ── 3. Build prompt ───────────────────────────────────────────────────────
    const region     = _inferRegion(userProfile.currentCountry, userProfile.currentCity);
    const userPrompt = buildPrompt(resumeData, salaryContext, userProfile, jobDemandCount);

    // ── 4. Call Anthropic ─────────────────────────────────────────────────────
    let analysis;
    try {
      const anthropic = getAnthropicClient();
      const response  = await anthropic.messages.create({
        model: MODEL, max_tokens: 1024,
        system: buildChiSystemPrompt(region),
        messages: [{ role: 'user', content: userPrompt }],
      });
      const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      analysis = JSON.parse(stripJson(rawText));
    } catch (aiErr) {
      logger.error('[CHIService] Anthropic call failed', { userId, error: aiErr.message, stack: aiErr.stack });
      throw new AppError(
        'Career Health Index calculation failed. Please try again.',
        502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR
      );
    }

    // ── 5. Blend deterministic score with AI dimensions ───────────────────────
    const deterministicScore = calculateDeterministicScore({ resumeData, userProfile, jobDemandCount });
    const blendedDimensions  = {};

    for (const key of Object.keys(analysis.dimensions ?? {})) {
      const aiScore = analysis.dimensions[key]?.score ?? 50;
      blendedDimensions[key] = {
        score:   Math.min(100, Math.max(0, Math.round((aiScore + deterministicScore) / 2))),
        insight: analysis.dimensions[key]?.insight || '',
        flag:    aiScore < 50,
      };
    }

    if (Object.keys(blendedDimensions).length === 0) {
      Object.assign(blendedDimensions, analysis.dimensions ?? {});
    }

    // ── 6. Compute final weighted CHI score ───────────────────────────────────
    const finalChiScore = CHI_DIMENSIONS.reduce(
      (sum, dim) => sum + (blendedDimensions[dim]?.score ?? analysis.dimensions?.[dim]?.score ?? 0) * WEIGHTS[dim],
      0
    );
    analysis.chiScore   = Math.round(finalChiScore);
    analysis.dimensions = blendedDimensions;

    const chiConfidence = calculateChiConfidence({ resumeData, userProfile, jobDemandCount });

    // ── 7. Build and persist snapshot ────────────────────────────────────────
    const trend      = calculateTrend(analysis.chiScore, previousSnapshot);
    const now        = new Date();
    const snapshotId = crypto.randomUUID();

    const snapshot = {
      snapshotId,
      userId,
      resumeId:                    resumeData.resumeId,
      chiScore:                    analysis.chiScore,
      chiConfidence,
      confidence:                  getConfidenceLabel(chiConfidence),
      dimensions:                  blendedDimensions,
      // CV-derived profession fields — used by frontend for accurate career path suggestions
      detectedProfession:          analysis.detectedProfession ?? null,
      currentJobTitle:             analysis.currentJobTitle ?? null,
      // topSkills from the resume — required by deriveCareerPaths() on the frontend
      // to route to the correct career domain block (accounting, engineering, etc.)
      topSkills:                   resumeData.topSkills ?? [],
      // Phase 3: store experience years so career stage timeline uses real data
      estimatedExperienceYears:    resumeData.estimatedExperienceYears ?? null,
      topStrength:                 analysis.topStrength,
      criticalGap:                 analysis.criticalGap,
      marketPosition:              analysis.marketPosition,
      peerComparison:              analysis.peerComparison,
      projectedLevelUpMonths:      analysis.projectedLevelUpMonths,
      currentEstimatedSalaryLPA:   analysis.currentEstimatedSalaryLPA,
      nextLevelEstimatedSalaryLPA: analysis.nextLevelEstimatedSalaryLPA,
      trend,
      analysisSource:              'full',
      aiModelVersion:              MODEL,
      region,
      generatedAt:                 now,
      softDeleted:                 false,
    };

    try {
      await supabase.from('careerHealthIndex').upsert({id: snapshotId, ...snapshot}, {onConflict: 'id'});
    } catch (persistErr) {
      logger.warn('[CHIService] Failed to persist CHI snapshot', { userId, error: persistErr.message });
    }

    logger.info('[CHIService] CHI calculated successfully', {
      userId, chiScore: analysis.chiScore, snapshotId, region,
    });

    // Phase 3: log activity event for streak tracking (non-blocking)
    try {
      const { logEvent } = require('../userActivity/userActivity.service');
      logEvent(userId, 'chi_calculated', { chiScore: analysis.chiScore, snapshotId });
    } catch { /* non-fatal */ }

    return { ...snapshot, generatedAt: now.toISOString() };

  } catch (err) {
    // Re-throw AppErrors as-is (they have statusCode + isOperational)
    if (err.isOperational) throw err;
    // Wrap any unexpected raw errors so they return 500 with a clean message
    logger.error('[CHIService] Unexpected error in calculateChi', {
      userId, error: err.message, stack: err.stack,
    });
    throw new AppError(
      'Career Health Index calculation failed. Please try again.',
      500, { userId }, ErrorCodes.INTERNAL_ERROR
    );
  }
}

// ─── GAP S2: PROVISIONAL CHI (no resume required) ────────────────────────────

/**
 * calculateProvisionalChi(userId, onboardingData, profileData, careerReport, userTier)
 *
 * Called automatically after /career-report completes.
 * Uses onboarding education, experience, skills, and career report data
 * to generate a CHI score WITHOUT needing a scored resume.
 *
 * Stored with analysisSource:'provisional'.
 * Full CHI (analysisSource:'full') supersedes this when available.
 *
 * HOTFIX: accepts userTier to downgrade model for free users.
 * HOTFIX: idempotency guard — skips if a provisional CHI already exists for this user
 *         generated after the current career report was saved, preventing duplicate
 *         Claude calls on /career-report retries.
 */
async function calculateProvisionalChi(userId, onboardingData, profileData, careerReport, userTier = 'free') {
  if (!userId) return;

  // A-01 FIX: Rank guard — fetch the most recent snapshot of ANY analysisSource.
  // If an existing snapshot has a rank >= the rank we are about to write, skip.
  // This prevents a provisional (rank 2) or quick_provisional (rank 1) write from
  // silently overwriting a resume_scored (rank 3) or full (rank 4) snapshot on retry.
  //
  // Previously this guard only checked .where('analysisSource', '==', 'provisional'),
  // meaning a retry after a full CHI was generated would still overwrite it.
  const newSource = careerReport ? 'provisional' : 'quick_provisional';
  const newRank   = ANALYSIS_SOURCE_RANK[newSource] ?? 0;

  try {
    const { data: _latestDocs } = await supabase.from('careerHealthIndex').select('*').eq('userId', userId).eq('softDeleted', false).order('generatedAt', {ascending:false}).limit(1);
    if (_latestDocs?.length) {
      const existing      = _latestDocs[0];
      const existingRank  = ANALYSIS_SOURCE_RANK[existing.analysisSource] ?? 0;

      // A-01 FIX (corrected): use strict > so the === branch below is reachable.
      // existingRank > newRank  → existing is higher quality, always skip.
      // existingRank === newRank → same quality tier; apply idempotency fence.
      // existingRank < newRank  → we are upgrading quality, proceed.
      if (existingRank > newRank) {
        logger.info('[CHIService] Rank guard — skipping provisional write (existing snapshot has higher quality)', {
          userId,
          existingSource: existing.analysisSource,
          existingRank,
          newSource,
          newRank,
        });
        return;
      }

      // Idempotency fence: same rank — skip only if the existing snapshot was
      // generated AFTER the current career report was saved (prevents double-write on retry).
      if (existingRank === newRank) {
        const reportSavedAt = onboardingData.updatedAt
          ? new Date(onboardingData.updatedAt instanceof Date
              ? onboardingData.updatedAt
              : onboardingData.updatedAt.toDate?.() ?? onboardingData.updatedAt)
          : null;
        const chiGeneratedAt = existing.generatedAt?.toDate?.() ?? new Date(existing.generatedAt);
        if (reportSavedAt && chiGeneratedAt >= reportSavedAt) {
          logger.info('[CHIService] Idempotency fence — provisional CHI already exists for this career report', { userId });
          return;
        }
      }
    }
  } catch (guardErr) {
    // Guard failure is non-fatal — proceed to generate CHI rather than silently drop it.
    logger.warn('[CHIService] Rank guard check failed — proceeding with generation', { userId, error: guardErr.message });
  }

  // HOTFIX FIX-1: Free-tier users use Sonnet instead of Opus for provisional CHI.
  // This prevents the double claude-opus-4-6 spend (careerReport + provisionalCHI)
  // for users who generate zero revenue.
  const resolvedModel = (userTier === 'free')
    ? MODEL_FREE_TIER_CHI
    : MODEL;

  logger.debug('[CHIService] Provisional CHI model selected', { userId, userTier, resolvedModel });

  const region = _inferRegion(profileData.currentCountry, profileData.currentCity);

  // Build a synthetic "resume data" object from onboarding inputs
  const syntheticResumeData = {
    score:                    null,
    tier:                     'provisional',
    estimatedExperienceYears: _estimateExperienceYears(onboardingData.experience || []),
    topSkills:                (onboardingData.skills || []).slice(0, 5).map(s => s.name),
    targetRole:               onboardingData.targetRole || (profileData.expectedRoleIds || [])[0] || null,
    cvContentStructured:      null,
    resumeText:               _buildProvisionalResumeText(onboardingData, profileData, careerReport),
    scoreBreakdown:           null,
    careerGaps:               onboardingData.careerGaps || [],
  };

  const [previousSnapshot, salaryContext, jobDemandCount] = await Promise.all([
    fetchPreviousSnapshot(userId),
    fetchSalaryContext(syntheticResumeData.targetRole),
    fetchJobDemandCount(syntheticResumeData.targetRole),
  ]);

  // P2-01: careerHistory fallback — derive synthetic entries from Track A experience[]
  // when profileData.careerHistory is empty (Track B not yet completed).
  // Without this, careerStabilityScore / promotionVelocity / specializationType are all null
  // inside buildPrompt(), causing those CHI signals to score at 50 (default) for ~80% of users.
  // The synthetic entries use jobTitle as a proxy for roleId — not ideal but prevents null signals.
  const resolvedProfileData = { ...profileData };
  if (!resolvedProfileData.careerHistory?.length) {
    const experience = onboardingData.experience || [];
    if (experience.length > 0) {
      resolvedProfileData.careerHistory = experience.map(exp => {
        // Compute durationMonths from startDate/endDate
        let durationMonths = 0;
        if (exp.startDate) {
          const start = new Date(exp.startDate + '-01');
          const end   = exp.isCurrent ? new Date() : (exp.endDate ? new Date(exp.endDate + '-01') : new Date());
          durationMonths = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24 * 30.44)));
        }
        return {
          roleId:         null,               // unknown — Track B maps this properly
          jobTitle:       exp.jobTitle,        // proxy for roleId
          company:        exp.company,
          durationMonths,
          isCurrent:      exp.isCurrent || false,
          source:         'track_a_fallback',  // P2-01: marks synthetic entries
        };
      });
      logger.debug('[CHIService] P2-01: synthetic careerHistory derived from Track A experience', {
        userId, entryCount: resolvedProfileData.careerHistory.length,
      });
    }
  }

  const userPrompt = buildPrompt(syntheticResumeData, salaryContext, resolvedProfileData, jobDemandCount);

  let analysis;
  try {
    const anthropic = getAnthropicClient();
    const response  = await anthropic.messages.create({
      model: resolvedModel, max_tokens: 1024,
      system: buildChiSystemPrompt(region),
      messages: [{ role: 'user', content: `NOTE: This is a provisional assessment from onboarding data (no resume uploaded yet). Score conservatively.\n\n${userPrompt}` }],
    });
    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    analysis = JSON.parse(stripJson(rawText));
  } catch (err) {
    logger.error('[CHIService] Provisional CHI failed', { userId, error: err.message });
    return; // Non-fatal — provisional CHI is a nice-to-have
  }

  const trend      = calculateTrend(analysis.chiScore, previousSnapshot);
  const now        = new Date();
  const snapshotId = crypto.randomUUID();

  const snapshot = {
    snapshotId, userId,
    resumeId:                    null,
    chiScore:                    analysis.chiScore,
    // P2-03: confidence label — provisional scores are inherently moderate/low
    // since no resume has been scored yet. Compute from available onboarding signals.
    chiConfidence:               Math.max(10, Math.min(60,
      (syntheticResumeData.topSkills?.length || 0) * 5 +
      (syntheticResumeData.estimatedExperienceYears > 0 ? 15 : 0) +
      ((onboardingData.expectedRoleIds || profileData.expectedRoleIds || []).length > 0 ? 15 : 0) +
      (profileData.currentSalaryLPA ? 10 : 0)
    )),
    get confidence() { return getConfidenceLabel(this.chiConfidence); },
    dimensions:                  analysis.dimensions,
    topStrength:                 analysis.topStrength,
    criticalGap:                 analysis.criticalGap,
    marketPosition:              analysis.marketPosition,
    peerComparison:              analysis.peerComparison,
    projectedLevelUpMonths:      analysis.projectedLevelUpMonths,
    currentEstimatedSalaryLPA:   analysis.currentEstimatedSalaryLPA,
    nextLevelEstimatedSalaryLPA: analysis.nextLevelEstimatedSalaryLPA,
    trend,
    // P2-04: analysisSource reflects data quality tier.
    // 'quick_provisional' — triggered from /quick-start before career report exists.
    // 'provisional'       — triggered from /career-report with full onboarding data.
    analysisSource: newSource, // A-01 FIX: reuses newSource computed in rank guard above
    // GAP-M3: store the resolved model so provisional vs full CHI snapshots can be
    // compared against the correct model version baseline.
    aiModelVersion: resolvedModel,
    region,
    generatedAt:    now,
    softDeleted:    false,
  };

  try {
    const { error: _chiErr } = await supabase.from('careerHealthIndex').upsert({id: snapshotId, ...snapshot}, {onConflict: 'id'});
    if (_chiErr) logger.warn('[CHIService] Failed to persist CHI snapshot', { userId, error: _chiErr.message });
    logger.info('[CHIService] Provisional CHI saved', { userId, snapshotId, chiScore: analysis.chiScore });
  } catch (err) {
    logger.warn('[CHIService] Failed to persist provisional CHI snapshot', { userId, error: err.message });
  }

  return { ...snapshot, generatedAt: now.toISOString() };
}

// ─── Provisional CHI helpers ──────────────────────────────────────────────────

function _estimateExperienceYears(experience = []) {
  let totalMonths = 0;
  for (const exp of experience) {
    if (exp.startDate) {
      const start = new Date(exp.startDate + '-01');
      const end   = exp.isCurrent ? new Date() : (exp.endDate ? new Date(exp.endDate + '-01') : new Date());
      const months = (end - start) / (1000 * 60 * 60 * 24 * 30.44);
      if (months > 0) totalMonths += months;
    }
  }
  return Math.round(totalMonths / 12);
}

function _buildProvisionalResumeText(onboardingData, profileData, careerReport) {
  const lines = [];

  if (onboardingData.education?.length) {
    lines.push('EDUCATION:');
    for (const e of onboardingData.education) {
      lines.push(`${e.qualificationName || e.qualificationId} — ${e.institution} (${e.yearOfGraduation || 'n/a'})`);
    }
  }

  if (onboardingData.experience?.length) {
    lines.push('\nEXPERIENCE:');
    for (const e of onboardingData.experience) {
      lines.push(`${e.jobTitle} at ${e.company} (${e.startDate || '?'} - ${e.isCurrent ? 'Present' : (e.endDate || '?')})`);
      if (e.responsibilities?.length) lines.push(...e.responsibilities.map(r => `  - ${r}`));
    }
  }

  if (onboardingData.skills?.length || profileData.skills?.length) {
    lines.push('\nSKILLS:');
    const skills = [...(onboardingData.skills || []), ...(profileData.skills || [])];
    lines.push(skills.map(s => `${s.name} (${s.proficiency})`).join(', '));
  }

  if (careerReport?.overallAssessment) {
    lines.push('\nCARROT REPORT ASSESSMENT:');
    lines.push(careerReport.overallAssessment);
  }

  return lines.join('\n');
}

function _inferRegion(country, city) {
  // P0-03: Match ISO 3166-1 alpha-2 codes FIRST (exact, case-insensitive) before
  // falling through to the broader substring scan.
  // Previously, "US" / "IN" / "GB" would not match "united states" / "india" / "united kingdom"
  // substrings when the caller passed the short country code, causing all Gulf/SEA/Western
  // users to fall through to the India default and break salary benchmarking.
  const iso = (country || '').trim().toUpperCase();
  const ISO_MAP = {
    'AE': 'Gulf (UAE/Saudi)', 'SA': 'Gulf (UAE/Saudi)', 'QA': 'Gulf (UAE/Saudi)',
    'BH': 'Gulf (UAE/Saudi)', 'KW': 'Gulf (UAE/Saudi)', 'OM': 'Gulf (UAE/Saudi)',
    'GB': 'United Kingdom',
    'US': 'United States',
    'SG': 'Singapore',
    'AU': 'Australia',
    'IN': 'India',
  };
  if (ISO_MAP[iso]) return ISO_MAP[iso];

  // Fallback: substring scan for full country names and major city names.
  const c = ((country || '') + ' ' + (city || '')).toLowerCase();
  if (['uae', 'dubai', 'abu dhabi', 'sharjah', 'saudi', 'qatar', 'bahrain', 'kuwait', 'oman'].some(k => c.includes(k))) return 'Gulf (UAE/Saudi)';
  if (['united kingdom', 'london', 'manchester', 'birmingham', 'edinburgh'].some(k => c.includes(k))) return 'United Kingdom';
  if (['united states', 'usa', 'new york', 'san francisco', 'seattle', 'chicago'].some(k => c.includes(k))) return 'United States';
  if (['singapore'].some(k => c.includes(k))) return 'Singapore';
  if (['australia', 'sydney', 'melbourne', 'brisbane'].some(k => c.includes(k))) return 'Australia';
  return 'India';
}

// ─── GET LATEST CHI ───────────────────────────────────────────────────────────

async function getLatestChi(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { data: _chiDocs } = await supabase.from('careerHealthIndex').select('*').eq('userId', userId).eq('softDeleted', false).order('generatedAt', {ascending:false}).limit(1);
  if (!_chiDocs?.length) throw new AppError('No Career Health Index found. Please score a resume first.', 404, { userId }, ErrorCodes.NOT_FOUND);
  const data = _chiDocs[0];
  return { ...data, generatedAt: data.generatedAt instanceof Date ? data.generatedAt.toISOString() : data.generatedAt };
}

// ─── GET CHI HISTORY ──────────────────────────────────────────────────────────

async function getChiHistory(userId, limit = 6) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { data: _histDocs } = await supabase.from('careerHealthIndex').select('*').eq('userId', userId).eq('softDeleted', false).order('generatedAt', {ascending:false}).limit(limit);
  if (!_histDocs?.length) return { userId, history: [], totalSnapshots: 0 };
  const history = (_histDocs).map(d => {
    return {
      snapshotId:     d.snapshotId,
      chiScore:       d.chiScore,
      marketPosition: d.marketPosition,
      trend:          d.trend,
      analysisSource: d.analysisSource || 'full', // expose provisional flag
      region:         d.region,
      generatedAt:    d.generatedAt?.toDate?.()?.toISOString() ?? d.generatedAt,
    };
  });

  return { userId, history, totalSnapshots: history.length };
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  calculateChi,
  calculateProvisionalChi,
  getLatestChi,
  getChiHistory,
  ANALYSIS_SOURCE_RANK,   // P2-04: state machine rank table
};