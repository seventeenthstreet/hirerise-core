'use strict';

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
const { db } = require('../../config/firebase');
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
    const doc = await db.collection('resumes').doc(resumeId).get();
    if (doc.exists && doc.data().userId === userId) return { ...doc.data(), resumeId };
  }
  const snap = await db.collection('resumes')
    .where('userId', '==', userId)
    .where('analysisStatus', '==', 'completed')
    .where('softDeleted', '==', false)
    .orderBy('scoredAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { ...snap.docs[0].data(), resumeId: snap.docs[0].id };
}

async function fetchPreviousSnapshot(userId) {
  try {
    const snap = await db.collection('careerHealthIndex')
      .where('userId', '==', userId)
      .where('softDeleted', '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].data();
  } catch { return null; }
}

async function fetchSalaryContext(targetRole) {
  if (!targetRole) return null;
  try {
    const doc = await db.collection('salaryBands').doc(targetRole).get();
    return doc.exists ? doc.data() : null;
  } catch { return null; }
}

// GAP C5: fetch job demand count as market signal
async function fetchJobDemandCount(targetRole) {
  if (!targetRole) return null;
  try {
    const snap = await db.collection('jobs')
      .where('roleId', '==', targetRole)
      .where('isActive', '==', true)
      .limit(1)
      .get();
    // Use count() if supported, otherwise estimate from snapshot
    if (!snap.empty) {
      // Full count query
      const countSnap = await db.collection('jobs').where('roleId', '==', targetRole).where('isActive', '==', true).count().get();
      return countSnap.data().count;
    }
    return 0;
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
  if (userProfile.careerHistory?.length) {
    const histSummary = userProfile.careerHistory
      .slice(0, 5)
      .map(r => `${r.roleId}(${r.durationMonths}mo)${r.isCurrent ? ' [current]' : ''}`)
      .join(', ');
    parts.push(`- Career History: ${histSummary}`);
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
// ─── CALCULATE CHI (full — requires scored resume) ────────────────────────────

async function calculateChi(userId, resumeId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const resumeData = await fetchResumeData(userId, resumeId);
  if (!resumeData) throw new AppError('No scored resume found. Please upload and score a resume first.', 404, { userId }, ErrorCodes.NOT_FOUND);

  // GAP C3/C5: fetch profile and job demand in parallel
  const [previousSnapshot, salaryContext, userProfile, jobDemandCount] = await Promise.all([
    fetchPreviousSnapshot(userId),
    fetchSalaryContext(resumeData.targetRole),
    db.collection('userProfiles').doc(userId).get().then(s => s.exists ? s.data() : {}),
    fetchJobDemandCount(resumeData.targetRole),
  ]);

  // GAP C2: infer region from profile
  const region    = _inferRegion(userProfile.currentCountry, userProfile.currentCity);
  const userPrompt = buildPrompt(resumeData, salaryContext, userProfile, jobDemandCount);

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

/* ──────────────────────────────────────────────────────────────
   Deterministic Dimension Engine
────────────────────────────────────────────────────────────── */

const deterministic = calculateDeterministicDimensions({
  resumeData,
  userProfile,
  jobDemandCount
});

/* ──────────────────────────────────────────────────────────────
   Blend Each Dimension (60% deterministic / 40% AI)
────────────────────────────────────────────────────────────── */

const blendedDimensions = {};

for (const key of Object.keys(deterministic)) {

  const aiScore = analysis.dimensions?.[key]?.score ?? 50;
  const deterministicScore = deterministic[key];

  const blendedScore = Math.round(
    (deterministicScore * 0.6) +
    (aiScore * 0.4)
  );

  blendedDimensions[key] = {
    score: blendedScore,
    insight: analysis.dimensions?.[key]?.insight || '',
    flag: blendedScore < 50
  };
}

/* ──────────────────────────────────────────────────────────────
   Compute Final Weighted CHI Score (System-Controlled)
────────────────────────────────────────────────────────────── */

// PROMPT-3: compute final score from config WEIGHTS — no hardcoded values
const finalChiScore = CHI_DIMENSIONS.reduce(
  (sum, dim) => sum + (blendedDimensions[dim]?.score ?? 0) * WEIGHTS[dim],
  0
);

analysis.chiScore = Math.round(finalChiScore);
analysis.dimensions = blendedDimensions;
const chiConfidence = calculateChiConfidence({
  resumeData,
  userProfile,
  jobDemandCount
});
    // ── Deterministic Score Layer ─────────────────────────

const deterministicScore = calculateDeterministicScore({
  resumeData,
  userProfile,
  jobDemandCount
});

// 50/50 blend
const blendedScore = Math.round(
  (analysis.chiScore * 0.5) +
  (deterministicScore * 0.5)
);

analysis.chiScore = blendedScore;
analysis.deterministicScore = deterministicScore;
analysis.aiScore = analysis.chiScore;
  } catch (err) {
    logger.error('[CHIService] Claude CHI analysis failed', { userId, error: err.message });
    throw new AppError('Career Health Index calculation failed. Please try again.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }

  const trend      = calculateTrend(analysis.chiScore, previousSnapshot);
  const now        = new Date();
  const snapshotId = crypto.randomUUID();

  const snapshot = {
  snapshotId,
  userId,
  resumeId: resumeData.resumeId,

  chiScore: analysis.chiScore,
  chiConfidence,                // ✅ NEW
  dimensions: blendedDimensions,
  deterministicDimensions: deterministic,

  topStrength: analysis.topStrength,
  criticalGap: analysis.criticalGap,
  marketPosition: analysis.marketPosition,
  peerComparison: analysis.peerComparison,
  projectedLevelUpMonths: analysis.projectedLevelUpMonths,
  currentEstimatedSalaryLPA: analysis.currentEstimatedSalaryLPA,
  nextLevelEstimatedSalaryLPA: analysis.nextLevelEstimatedSalaryLPA,

  trend,
  analysisSource: 'full',
  region,
  generatedAt: now,
  softDeleted: false,
};

  try {
    await db.collection('careerHealthIndex').doc(snapshotId).set(snapshot);
  } catch (err) {
    logger.warn('[CHIService] Failed to persist CHI snapshot', { userId, error: err.message });
  }

  return { ...snapshot, generatedAt: now.toISOString() };
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

  // HOTFIX FIX-4: Idempotency guard — skip if a provisional CHI already exists
  // that was generated after the career report was saved to onboardingProgress.
  // Uses the careerReport's updatedAt as a reference fence.
  try {
    const existingSnap = await db.collection('careerHealthIndex')
      .where('userId', '==', userId)
      .where('analysisSource', '==', 'provisional')
      .where('softDeleted', '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const existing = existingSnap.docs[0].data();
      // careerReportSavedAt is set by generateCareerReport before triggerProvisionalChi fires.
      // If a provisional CHI already exists from after the report was saved, skip.
      const reportSavedAt = onboardingData.updatedAt
        ? new Date(onboardingData.updatedAt instanceof Date
            ? onboardingData.updatedAt
            : onboardingData.updatedAt.toDate?.() ?? onboardingData.updatedAt)
        : null;
      const chiGeneratedAt = existing.generatedAt?.toDate?.() ?? new Date(existing.generatedAt);

      if (reportSavedAt && chiGeneratedAt >= reportSavedAt) {
        logger.info('[CHIService] Provisional CHI already exists for current career report — skipping', { userId });
        return;
      }
    }
  } catch (guardErr) {
    // Guard failure is non-fatal — proceed to generate CHI
    logger.warn('[CHIService] Provisional CHI idempotency check failed — proceeding', { userId, error: guardErr.message });
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

  const userPrompt = buildPrompt(syntheticResumeData, salaryContext, profileData, jobDemandCount);

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
    dimensions:                  analysis.dimensions,
    topStrength:                 analysis.topStrength,
    criticalGap:                 analysis.criticalGap,
    marketPosition:              analysis.marketPosition,
    peerComparison:              analysis.peerComparison,
    projectedLevelUpMonths:      analysis.projectedLevelUpMonths,
    currentEstimatedSalaryLPA:   analysis.currentEstimatedSalaryLPA,
    nextLevelEstimatedSalaryLPA: analysis.nextLevelEstimatedSalaryLPA,
    trend,
    analysisSource: 'provisional', // Key distinction from full CHI
    region,
    generatedAt:    now,
    softDeleted:    false,
  };

  try {
    await db.collection('careerHealthIndex').doc(snapshotId).set(snapshot);
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
  const c = ((country || '') + ' ' + (city || '')).toLowerCase();
  if (['ae', 'uae', 'dubai', 'abu dhabi', 'sharjah', 'saudi', 'qatar', 'bahrain', 'kuwait', 'oman'].some(k => c.includes(k))) return 'Gulf (UAE/Saudi)';
  if (['uk', 'gb', 'united kingdom', 'london', 'manchester'].some(k => c.includes(k))) return 'United Kingdom';
  if (['us', 'usa', 'united states'].some(k => c.includes(k))) return 'United States';
  if (['sg', 'singapore'].some(k => c.includes(k))) return 'Singapore';
  if (['au', 'australia'].some(k => c.includes(k))) return 'Australia';
  return 'India';
}

// ─── GET LATEST CHI ───────────────────────────────────────────────────────────

async function getLatestChi(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const snap = await db.collection('careerHealthIndex')
    .where('userId', '==', userId)
    .where('softDeleted', '==', false)
    .orderBy('generatedAt', 'desc')
    .limit(1)
    .get();

  if (snap.empty) throw new AppError('No Career Health Index found. Please score a resume first.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const data = snap.docs[0].data();
  return { ...data, generatedAt: data.generatedAt?.toDate?.()?.toISOString() ?? data.generatedAt };
}

// ─── GET CHI HISTORY ──────────────────────────────────────────────────────────

async function getChiHistory(userId, limit = 6) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const snap = await db.collection('careerHealthIndex')
    .where('userId', '==', userId)
    .where('softDeleted', '==', false)
    .orderBy('generatedAt', 'desc')
    .limit(limit)
    .get();

  if (snap.empty) return { userId, history: [], totalSnapshots: 0 };

  const history = snap.docs.map(doc => {
    const d = doc.data();
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

  return { userId, history, totalSnapshots: snap.size };
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  calculateChi,
  calculateProvisionalChi,
  getLatestChi,
  getChiHistory,
};