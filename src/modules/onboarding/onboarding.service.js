'use strict';

/**
 * onboarding.service.js — FULL GAP-REMEDIATION REWRITE
 *
 * Original fixes G-01..G-12 carried forward plus new gaps S1-S10, F1-F7,
 * C1-C6, T1-T7 as identified in the audit report.
 *
 * See inline comments for each fix.
 */

const crypto    = require('crypto');
const { db, storage } = require('../../config/firebase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { FieldValue }  = require('firebase-admin/firestore');
const logger          = require('../../utils/logger');
const { getQualificationById } = require('../qualification/qualification.service');
const { logAIInteraction }     = require('../../infrastructure/aiLogger');
const { getRemainingQuota }    = require('../../middleware/tierquota.middleware');
const { conversionEventService } = require('../conversion');
const { INDUSTRY_SECTORS }     = require('../roles/roles.types'); // GAP-07

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHI_TREND_THRESHOLD = 5;   // GAP C6

// PROMPT-2: Re-engagement notification fired 24h after a draft save
// if the user has not progressed beyond the draft step.
const DRAFT_REENGAGEMENT_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours
const NOTIFICATION_TOPIC = process.env.PUBSUB_TOPIC_NOTIFICATION
  || 'hirerise.notification.requested.v1';

const getAnthropicClient = () => {
  if (process.env.NODE_ENV === 'test') return null;
  return require('../../config/anthropic.client');
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function stripJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// GAP T3: strip HTML tags from free-text fields
function stripHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

// GAP S8: URL validation
function validateUrl(url, fieldName) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Bad protocol');
    return url.trim();
  } catch {
    throw new AppError(
      `${fieldName} must be a valid URL (e.g. https://linkedin.com/in/yourname).`,
      400, { fieldName, url }, ErrorCodes.VALIDATION_ERROR
    );
  }
}

// GAP S10: graduation year range validation
function validateYearOfGraduation(year, label) {
  if (year == null) return null;
  const y = parseInt(year, 10);
  const minY = 1950, maxY = new Date().getFullYear() + 6;
  if (isNaN(y) || y < minY || y > maxY) {
    throw new AppError(
      `${label}: yearOfGraduation "${year}" must be between ${minY} and ${maxY}.`,
      400, { label, year }, ErrorCodes.VALIDATION_ERROR
    );
  }
  return y;
}

// GAP T3: validate and sanitise responsibilities array
function validateAndSanitiseResponsibilities(responsibilities, label) {
  if (!Array.isArray(responsibilities)) return [];
  const sanitised = responsibilities.map(r => stripHtml(String(r || ''))).filter(r => r.length > 0);
  if (sanitised.length === 0) return [];
  if (sanitised.length > 10) throw new AppError(`${label}: Maximum 10 responsibility bullets allowed (got ${sanitised.length}).`, 400, { label }, ErrorCodes.VALIDATION_ERROR);
  for (let i = 0; i < sanitised.length; i++) {
    if (sanitised[i].length < 10) throw new AppError(`${label}: Bullet ${i+1} too short (min 10 chars). Try: "Led API migration reducing latency by 30%"`, 400, { label, index: i }, ErrorCodes.VALIDATION_ERROR);
    if (sanitised[i].length > 500) throw new AppError(`${label}: Bullet ${i+1} too long (max 500 chars, got ${sanitised[i].length}).`, 400, { label, index: i }, ErrorCodes.VALIDATION_ERROR);
  }
  return sanitised;
}

// GAP T4: idempotency key management
async function checkIdempotencyKey(userId, operation, key) {
  if (!key) return null;
  try {
    const ref  = db.collection('idempotencyKeys').doc(`${userId}:${operation}:${key}`);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (Date.now() - new Date(data.createdAt).getTime() > IDEMPOTENCY_TTL_MS) {
      await ref.delete().catch(() => {});
      return null;
    }
    return data.result;
  } catch { return null; }
}

async function saveIdempotencyKey(userId, operation, key, result) {
  if (!key) return;
  try {
    await db.collection('idempotencyKeys').doc(`${userId}:${operation}:${key}`)
      .set({ userId, operation, key, result, createdAt: new Date().toISOString() });
  } catch (err) {
    logger.warn('[OnboardingService] Idempotency key save failed', { userId, operation, error: err.message });
  }
}

// GAP S5: merge skills from Track A and Track B — Track B wins on duplicate name
function mergeSkills(trackBSkills = [], trackASkills = []) {
  const map = new Map();
  for (const s of trackASkills) {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) continue;
    map.set(name.toLowerCase(), { name, proficiency: s?.proficiency || 'intermediate' });
  }
  for (const s of trackBSkills) {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) continue;
    map.set(name.toLowerCase(), { name, proficiency: s?.proficiency || 'intermediate' });
  }
  return Array.from(map.values());
}

// GAP-06: Compute total experience months from Track A date ranges (server-side)
// Handles isCurrent:true entries by using today as endDate.
// YYYY-MM strings are converted to the 1st of that month for arithmetic.
function computeExperienceMonths(experience = []) {
  const now = new Date();
  let total = 0;
  for (const exp of experience) {
    if (!exp.startDate) continue;
    const start = new Date(exp.startDate + '-01');
    const end   = exp.isCurrent
      ? now
      : exp.endDate ? new Date(exp.endDate + '-01') : null;
    if (!end || end < start) continue;
    const months = (end.getFullYear() - start.getFullYear()) * 12
                 + (end.getMonth()    - start.getMonth());
    total += Math.max(0, months);
  }
  return total;
}

// GAP C2: infer user market region from country/city
function inferRegion(country, city) {
  const c = ((country || '') + ' ' + (city || '')).toLowerCase();
  if (['ae', 'uae', 'dubai', 'abu dhabi', 'sharjah', 'saudi', 'qatar', 'bahrain', 'kuwait', 'oman'].some(k => c.includes(k))) return 'Gulf (UAE/Saudi)';
  if (['uk', 'gb', 'united kingdom', 'london', 'manchester'].some(k => c.includes(k))) return 'United Kingdom';
  if (['us', 'usa', 'united states'].some(k => c.includes(k))) return 'United States';
  if (['sg', 'singapore'].some(k => c.includes(k))) return 'Singapore';
  if (['au', 'australia'].some(k => c.includes(k))) return 'Australia';
  return 'India';
}

// ─── Background task helpers ──────────────────────────────────────────────────

// FIX G-01 + GAP T2: Background resume scoring — Pub/Sub preferred, setTimeout fallback
function triggerResumeScoring(userId, resumeId) {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.PUBSUB_TOPIC_RESUME_SCORE) {
    try {
      const { publishEvent } = require('../../shared/pubsub');
      publishEvent(process.env.PUBSUB_TOPIC_RESUME_SCORE, { userId, resumeId, triggeredBy: 'onboarding' })
        .catch(err => logger.error('[OnboardingService] Pub/Sub resume-score publish failed', { userId, resumeId, error: err.message }));
      return;
    } catch (err) {
      logger.error('[OnboardingService] Pub/Sub import failed — fallback to setTimeout', { error: err.message });
    }
  }
  setTimeout(async () => {
    try {
      const { scoreResume } = require('../resume/resume.service');
      await scoreResume(userId, resumeId);
      logger.info('[OnboardingService] Auto-scoring complete', { userId, resumeId });
    } catch (err) {
      logger.error('[OnboardingService] Auto-scoring failed (non-fatal)', { userId, resumeId, error: err.message });
    }
  }, 3000);
}

// GAP S2: Provisional CHI after career report
// HOTFIX: accepts userTier so CHI service can downgrade model for free users
function triggerProvisionalChi(userId, onboardingData, profileData, careerReport, userTier) {
  if (process.env.NODE_ENV === 'test') return;
  setTimeout(async () => {
    try {
      const { calculateProvisionalChi } = require('../careerHealthIndex/careerHealthIndex.service');
      await calculateProvisionalChi(userId, onboardingData, profileData, careerReport, userTier);
      logger.info('[OnboardingService] Provisional CHI complete', { userId });
    } catch (err) {
      logger.error('[OnboardingService] Provisional CHI failed (non-fatal)', { userId, error: err.message });
    }
  }, 2000);
}

// ─── Step history + events ────────────────────────────────────────────────────

function appendStepHistory(step) {
  return { stepHistory: FieldValue.arrayUnion({ step, at: new Date().toISOString() }) };
}

async function emitOnboardingEvent(userId, eventName, metadata = {}) {
  try {
    await conversionEventService.recordEvent(
      userId, eventName,
      { source: 'onboarding', ...metadata },
      `${userId}:${eventName}:${metadata.step || eventName}`
    );
  } catch (err) {
    logger.warn('[OnboardingService] Event emission failed (non-fatal)', { userId, eventName, error: err.message });
  }
}

// ─── Credits ──────────────────────────────────────────────────────────────────

async function deductCredits(userId, amount) {
  if (!amount || amount <= 0) return;
  try {
    await db.runTransaction(async (txn) => {
      const ref = db.collection('users').doc(userId);
      const doc = await txn.get(ref);
      if (!doc.exists) return;
      const current = doc.data().aiCreditsRemaining ?? 0;
      txn.update(ref, { aiCreditsRemaining: Math.max(0, current - amount), updatedAt: new Date() });
    });
  } catch (err) {
    logger.error('[OnboardingService] Credit deduction failed', { userId, amount, error: err.message });
  }
}

// ─── AI context builder ───────────────────────────────────────────────────────
function calculateCareerWeights(careerHistory = []) {
  if (!careerHistory.length) return [];

  const totalMonths = careerHistory.reduce(
    (sum, r) => sum + (r.durationMonths || 0),
    0
  );

  return careerHistory.map((role, idx) => {
    const tenureRatio = totalMonths > 0
      ? (role.durationMonths || 0) / totalMonths
      : 0;

    const recencyBonus =
      idx === careerHistory.length - 1 ? 0.15 : 0;

    const currentBonus =
      role.isCurrent ? 0.2 : 0;

    const weight =
      Math.min(
        1,
        tenureRatio * 0.7 +
        recencyBonus +
        currentBonus
      );

    return {
      ...role,
      weight: Math.round(weight * 100) / 100
    };
  });
}


function buildAIContext(onboarding = {}, profile = {}) {
  const mergedSkills = mergeSkills(profile.skills || [], onboarding.skills || []);
  const country = profile.currentCountry || onboarding.personalDetails?.country || null;
  const city    = profile.currentCity    || onboarding.personalDetails?.city    || null;

  const careerHistory  = profile.careerHistory || [];
  const weightedHistory = calculateCareerWeights(careerHistory);

  const careerStabilityScore = (() => {
    if (careerHistory.length <= 1) return 1;
    const avgDuration =
      careerHistory.reduce((s, r) => s + (r.durationMonths || 0), 0)
      / careerHistory.length;

    if (avgDuration >= 36) return 1;
    if (avgDuration >= 18) return 0.7;
    if (avgDuration >= 9)  return 0.4;
    return 0.2;
  })();

  const promotionVelocity = (() => {
    if (careerHistory.length < 2) return 'steady';
    const durations = careerHistory.map(r => r.durationMonths || 0);
    const avg = durations.reduce((a,b)=>a+b,0)/durations.length;

    if (avg < 12) return 'rapid';
    if (avg < 24) return 'moderate';
    return 'steady';
  })();

  const impactSignal = (() => {
    const impactRegex = /\d+%|\$\d+|\d+\s?(users|clients|teams|projects)/i;
    return (onboarding.experience || []).some(exp =>
      exp.responsibilities?.some(r => impactRegex.test(r))
    ) ? 1 : 0;
  })();

  const specializationType = (() => {
    if (!weightedHistory.length) return 'generalist';
    const dominant = weightedHistory.reduce(
      (max, r) => r.weight > (max.weight || 0) ? r : max,
      {}
    );
    return dominant.weight >= 0.6 ? 'specialist' : 'generalist';
  })();

  return {
    city,
    country,
    currentSalary:         profile.currentSalaryLPA         || null,
    expectedSalary:        profile.expectedSalaryLPA        || null,
    timeline:              profile.jobSearchTimeline        || null,
    careerIntent:          profile.expectedRoleIds          || [],
    // GAP-02: fall back to expectedRoleIds[0] so CHI salary bands always resolve
    targetRole:            onboarding.targetRole            || profile.expectedRoleIds?.[0] || null,
    workAuthorisation:     onboarding.personalDetails?.workAuthorisation || null,
    linkedInUrl:           onboarding.personalDetails?.linkedInUrl       || null,
    portfolioUrl:          onboarding.personalDetails?.portfolioUrl      || null,

    weightedCareerHistory: weightedHistory,

    // 🔥 CHI Intelligence Signals
    careerStabilityScore,
    promotionVelocity,
    impactSignal,
    specializationType,

    skillsWithProficiency: mergedSkills,
    careerGaps:            onboarding.careerGaps || [],
    userRegion:            inferRegion(country, city),
  };
}
// ─── Completion logic ─────────────────────────────────────────────────────────

function evaluateCompletion(progress = {}, profile = {}) {
  const trackA =
    !!(progress.education?.length || progress.experience?.length) &&
    !!progress.careerReport;

  const trackB =
    !!(profile.careerHistory?.length) &&
    !!(profile.expectedRoleIds?.length);

  // SIMPLIFIED COMPLETION LOGIC:
  // Track A determines onboarding completion.
  // Track B is enrichment-only and must not block completion.
  return { isComplete: trackA, trackA, trackB };
}

// GAP-04: Merge fragmented skills from three sources into canonicalSkills[]
// Priority: Track B (declared + proficiency) > AI topSkills (inferred) > Track A flat strings
// Fire-and-forget — never blocks onboarding completion.
async function mergeCanonicalSkills(userId, progressData, profileData) {
  try {
    // Source 1: Track B skills (name + proficiency, highest priority)
    const trackBSkills = (profileData.skills || []).map(s => ({
      name: s.name, proficiency: s.proficiency || 'intermediate', source: 'declared',
    }));

    // Source 2: AI-extracted topSkills from latest scored resume
    const resumeSnap = await db.collection('resumes')
      .where('userId',          '==', userId)
      .where('analysisStatus',  '==', 'completed')
      .where('softDeleted',     '==', false)
      .orderBy('scoredAt', 'desc').limit(1).get();

    const topSkills = resumeSnap.empty ? [] :
      (resumeSnap.docs[0].data().topSkills || []).map(name => ({
        name, proficiency: 'intermediate', source: 'inferred',
      }));

    // Source 3: CV personal details skills (flat strings, lowest priority)
    const cvSkills = (progressData.personalDetails?.skills || []).map(name => ({
      name: typeof name === 'string' ? name : String(name?.name || ''),
      proficiency: 'intermediate', source: 'declared',
    }));

    // Deduplicate: first entry wins per lowercase name; upgrade inferred → declared if matched
    const seen = new Map();
    for (const s of [...trackBSkills, ...topSkills, ...cvSkills]) {
      const key = s.name.toLowerCase().trim();
      if (!key) continue;
      if (!seen.has(key)) {
        seen.set(key, s);
      } else if (s.source === 'declared' && seen.get(key).source === 'inferred') {
        seen.set(key, s); // upgrade source quality
      }
    }

    const canonicalSkills = [...seen.values()];
    await db.collection('userProfiles').doc(userId).set(
      { canonicalSkills, canonicalSkillsUpdatedAt: new Date() },
      { merge: true }
    );
    logger.info('[OnboardingService] canonicalSkills merged', { userId, count: canonicalSkills.length });
  } catch (err) {
    logger.warn('[OnboardingService] canonicalSkills merge failed (non-fatal)', { userId, error: err.message });
  }
}

async function persistCompletionIfReady(userId, progressData, profileData) {
  if (profileData.onboardingCompleted === true) return;
  const { isComplete } = evaluateCompletion(progressData, profileData);
  if (!isComplete) return;
  const batch = db.batch();
  batch.set(db.collection('userProfiles').doc(userId), {
    onboardingCompleted: true, onboardingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(db.collection('onboardingProgress').doc(userId), {
    completedAt: FieldValue.serverTimestamp(), ...appendStepHistory('onboarding_completed'),
  }, { merge: true });
  await batch.commit();

  // GAP-06: reconcile Track A (date ranges) vs Track B (durationMonths) — take the max
  const trackBMonths = (profileData.careerHistory || [])
    .reduce((sum, r) => sum + (r.durationMonths || 0), 0);
  const totalMonths = Math.max(progressData.totalExperienceMonths || 0, trackBMonths);
  if (totalMonths > 0) {
    // Fire-and-forget — non-blocking
    db.collection('userProfiles').doc(userId).set(
      { totalExperienceYears: +(totalMonths / 12).toFixed(1), updatedAt: new Date() },
      { merge: true }
    ).catch(err => logger.warn('[OnboardingService] totalExperienceYears write failed', { userId, error: err.message }));
  }

  // GAP-04: merge canonicalSkills fire-and-forget
  mergeCanonicalSkills(userId, progressData, profileData);

  const { trackA, trackB } = evaluateCompletion(progressData, profileData);
  emitOnboardingEvent(userId, 'onboarding_completed', { trackA, trackB });
  logger.info('[OnboardingService] Onboarding marked complete', { userId });
}

// ─── FIX G-12: Date validation ────────────────────────────────────────────────

function validateExperienceDates(experience) {
  if (!Array.isArray(experience) || !experience.length) return;
  const now       = new Date();
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentRoles = [];

  for (let i = 0; i < experience.length; i++) {
    const exp   = experience[i];
    const label = `Experience entry ${i + 1} (${exp.jobTitle || 'untitled'} at ${exp.company || 'unknown'})`;
    const { startDate: start, endDate: end, isCurrent } = exp;
    const isCur = Boolean(isCurrent);

    if (start && start > currentYM) throw new AppError(`${label}: startDate "${start}" cannot be in the future.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (end   && end   > currentYM) throw new AppError(`${label}: endDate "${end}" cannot be in the future.`,     400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (start && end   && end < start) throw new AppError(`${label}: endDate "${end}" cannot be before startDate "${start}".`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (isCur && end) throw new AppError(`${label}: cannot have both isCurrent=true and an endDate.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (isCur) currentRoles.push(i);
  }
  if (currentRoles.length > 1) throw new AppError(`Only one experience entry can have isCurrent=true. Found ${currentRoles.length} at indices: ${currentRoles.join(', ')}.`, 400, { indices: currentRoles }, ErrorCodes.VALIDATION_ERROR);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0 — SAVE CONSENT  (PROMPT-2)
//
// Must be called before any personal data is collected (i.e. before Step 1).
// Stores an explicit, timestamped consent record in:
//   users/{userId}        — consentGrantedAt, consentVersion
//   userProfiles/{userId} — consentGrantedAt, consentVersion (for CHI / CV pipeline)
//   onboardingProgress/{userId} — step marker for progress tracking
//
// GDPR Art. 6(1)(a) / UAE PDPL Art. 8 compliance:
//   - consentGrantedAt: exact ISO timestamp of the user action
//   - consentVersion:   links to the T&C / Privacy Policy version shown
//   - consentSource:    'onboarding_step_0' — audit trail of where consent was given
//
// Idempotent: calling again with a newer consentVersion updates the record.
// Calling again with the same version is a no-op (returns existing record).
// ─────────────────────────────────────────────────────────────────────────────

async function saveConsent(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { consentVersion, consentSource = 'onboarding_step_0' } = payload;

  if (!consentVersion || typeof consentVersion !== 'string' || !consentVersion.trim()) {
    throw new AppError(
      'consentVersion is required (e.g. "1.0"). Pass the version of the Terms & Privacy Policy the user accepted.',
      400, {}, ErrorCodes.VALIDATION_ERROR
    );
  }

  const version = consentVersion.trim();
  const now     = new Date();

  // ── Idempotency: if same version already stored, return existing record ────
  const progressSnap = await db.collection('onboardingProgress').doc(userId).get();
  if (progressSnap.exists) {
    const existing = progressSnap.data();
    if (existing.consentVersion === version && existing.consentGrantedAt) {
      logger.debug('[OnboardingService] Consent already recorded for this version — skipping', { userId, version });
      return {
        userId,
        step:             'consent_saved',
        consentVersion:   version,
        consentGrantedAt: existing.consentGrantedAt,
        alreadyRecorded:  true,
      };
    }
  }

  const consentPayload = {
    consentGrantedAt: now.toISOString(),
    consentVersion:   version,
    consentSource,
  };

  // Write atomically to all three collections
  const batch = db.batch();

  batch.set(db.collection('users').doc(userId), {
    ...consentPayload,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  batch.set(db.collection('userProfiles').doc(userId), {
    ...consentPayload,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  batch.set(db.collection('onboardingProgress').doc(userId), {
    userId,
    step: 'consent_saved',
    ...consentPayload,
    ...appendStepHistory('consent_saved'),
    onboardingStartedAt: now,
    updatedAt: now,
  }, { merge: true });

  await batch.commit();

  logger.info('[OnboardingService] Consent recorded', { userId, version, consentSource });
  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'consent_saved' });

  return {
    userId,
    step:             'consent_saved',
    consentVersion:   version,
    consentGrantedAt: now.toISOString(),
    alreadyRecorded:  false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — SAVE EDUCATION & EXPERIENCE
// GAP S1: skills[] + proficiency
// GAP S4: targetRole
// GAP C4: careerGaps[]
// GAP S3/T3: responsibilities validated
// GAP S10: yearOfGraduation validated
// ─────────────────────────────────────────────────────────────────────────────

async function saveEducationAndExperience(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { 
    education = [], 
    experience = [], 
    skills = [], 
    targetRole = null, 
    careerGaps = [],
    currentSalaryLPA  = null,   // CHI salaryTrajectory signal
    expectedSalaryLPA = null,   // CHI salaryTrajectory signal
  } = payload;

  if (!education.length && !experience.length) {
    throw new AppError('Please provide at least one education or experience entry.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  // ── Validate salary fields ────────────────────────────────────────────────
  if (currentSalaryLPA !== null && (typeof currentSalaryLPA !== 'number' || currentSalaryLPA < 0)) {
    throw new AppError('currentSalaryLPA must be a positive number.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }
  if (expectedSalaryLPA !== null && (typeof expectedSalaryLPA !== 'number' || expectedSalaryLPA < 0)) {
    throw new AppError('expectedSalaryLPA must be a positive number.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  // ── Validate education ────────────────────────────────────────────────────
  const resolvedEducation = [];
  for (let i = 0; i < education.length; i++) {
    const edu = education[i];
    const label = `Education entry ${i + 1}`;

    // GAP-10: accept either a known qualificationId OR a free-text qualificationName
    const hasQualId   = edu.qualificationId   && typeof edu.qualificationId   === 'string' && edu.qualificationId.trim();
    const hasQualName = edu.qualificationName  && typeof edu.qualificationName === 'string' && edu.qualificationName.trim();

    if (!hasQualId && !hasQualName) {
      throw new AppError(`${label}: either qualificationId or qualificationName is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    }

    if (!String(edu.institution || '').trim()) throw new AppError(`${label}: institution is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    const validatedYear = validateYearOfGraduation(edu.yearOfGraduation, label); // GAP S10

    let resolvedQualId   = null;
    let resolvedQualName = edu.qualificationName?.trim() || null;

    if (hasQualId) {
      // Existing path: resolve from qualifications collection — canonical name wins
      const qualification = await getQualificationById(edu.qualificationId.trim());
      resolvedQualId   = qualification.id;
      resolvedQualName = qualification.name;
    }

    resolvedEducation.push({
      qualificationId:   resolvedQualId,   // null when free-text path taken
      qualificationName: resolvedQualName, // always present
      institution:       String(edu.institution).trim(),
      yearOfGraduation:  validatedYear,
      specialization:    edu.specialization || null,
      certifications:    Array.isArray(edu.certifications)
        ? edu.certifications.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
        : [],
    });
  }

  // ── Validate experience ────────────────────────────────────────────────────
  for (let i = 0; i < experience.length; i++) {
    if (!experience[i].jobTitle || !experience[i].company) throw new AppError(`Experience entry ${i + 1}: jobTitle and company are required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
  }
  validateExperienceDates(experience);

  // GAP-06: compute total months from validated date ranges
  const totalExperienceMonths = computeExperienceMonths(experience);

  const sanitisedExperience = experience.map((e, i) => {
    const label = `Experience entry ${i + 1} (${e.jobTitle} at ${e.company})`;
    // GAP-07: normalise industry to controlled enum; preserve raw text as industryText
    const industryId   = INDUSTRY_SECTORS[e.industryId] ? e.industryId : (e.industryId ? 'other' : null);
    const industryText = e.industryText || e.industry || null;
    return {
      jobTitle:         stripHtml(e.jobTitle || ''),
      company:          stripHtml(e.company  || ''),
      industryId,                                        // GAP-07: controlled enum key
      industryText,                                      // GAP-07: raw text fallback
      startDate:        e.startDate  || null,
      endDate:          e.endDate    || null,
      isCurrent:        e.isCurrent  || false,
      responsibilities: validateAndSanitiseResponsibilities(e.responsibilities, label), // GAP S3/T3
    };
  });

  // ── Validate careerGaps (GAP C4) ──────────────────────────────────────────
  const VALID_GAP_REASONS = new Set(['education', 'personal', 'health', 'relocation', 'other']);
  const sanitisedCareerGaps = (Array.isArray(careerGaps) ? careerGaps : []).map((gap, i) => {
    if (!gap.startDate || !gap.endDate) throw new AppError(`careerGaps[${i}]: startDate and endDate are required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    if (gap.startDate >= gap.endDate) throw new AppError(`careerGaps[${i}]: endDate must be after startDate.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    return {
      startDate:   gap.startDate,
      endDate:     gap.endDate,
      reason:      VALID_GAP_REASONS.has(gap.reason) ? gap.reason : 'other',
      description: gap.description ? stripHtml(String(gap.description)).slice(0, 300) : null,
    };
  });

  // ── Validate skills (GAP S1) ──────────────────────────────────────────────
  const VALID_PROF = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
  const sanitisedSkills = (Array.isArray(skills) ? skills : []).map((s, i) => {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) throw new AppError(`skills[${i}]: name is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    return { name, proficiency: VALID_PROF.has(s?.proficiency) ? s.proficiency : 'intermediate' };
  });

  const doc = {
    userId,
    step:       'education_experience_saved',
    education:  resolvedEducation,
    experience: sanitisedExperience,
    skills:     sanitisedSkills,       // GAP S1
    targetRole: targetRole ? String(targetRole).trim().slice(0, 100) : null, // GAP S4
    careerGaps: sanitisedCareerGaps,   // GAP C4
    totalExperienceMonths,             // GAP-06: verified tenure from date ranges
    currentSalaryLPA:  currentSalaryLPA  ?? null,   // CHI salaryTrajectory signal
    expectedSalaryLPA: expectedSalaryLPA ?? null,   // CHI salaryTrajectory signal
    ...appendStepHistory('education_experience_saved'),
    onboardingStartedAt: new Date(),
    updatedAt:   new Date(),
  };

  await db.collection('onboardingProgress').doc(userId).set(doc, { merge: true });

  // G-02: Derive dominant industry from experience array and mirror to userProfiles.
  // Uses the most frequently occurring industryId across all roles — if tied,
  // the most recent role's industry wins (last entry in the sorted array).
  // Stored as industryId (enum key) + industryText (human label) for CHI market alignment.
  const industryCounts = {};
  for (const exp of sanitisedExperience) {
    if (exp.industryId) industryCounts[exp.industryId] = (industryCounts[exp.industryId] || 0) + 1;
  }
  const dominantIndustryId = Object.keys(industryCounts).length > 0
    ? Object.keys(industryCounts).reduce((a, b) => industryCounts[a] >= industryCounts[b] ? a : b)
    : null;
  const dominantIndustryText = dominantIndustryId ? (INDUSTRY_SECTORS[dominantIndustryId] || null) : null;

  // Mirror skills + salary + industry to userProfiles so Track B / CHI can see them immediately
  await db.collection('userProfiles').doc(userId).set(
    {
      skills:              sanitisedSkills.length > 0 ? sanitisedSkills : undefined,
      currentSalaryLPA:    currentSalaryLPA  ?? null,
      expectedSalaryLPA:   expectedSalaryLPA ?? null,
      // G-02: aggregated sector — enables CHI marketAlignment salary band lookup
      industryId:          dominantIndustryId   ?? null,
      industryText:        dominantIndustryText  ?? null,
      updatedAt:           FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);
  await persistCompletionIfReady(userId, progressSnap.data() || {}, profileSnap.data() || {});
  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'education_experience_saved', trackA: true });

  return { userId, step: 'education_experience_saved', message: 'Education and experience saved. Ready to generate your career report.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1b — DRAFT SAVE (GAP F5)
// PROMPT-2: fires a re-engagement notification via Pub/Sub after 24h
// if the user has not progressed past this step.
// ─────────────────────────────────────────────────────────────────────────────

async function saveDraft(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  await db.collection('onboardingProgress').doc(userId).set({
    userId, step: 'draft', draft: payload,
    ...appendStepHistory('draft_saved'),
    onboardingStartedAt: new Date(), updatedAt: new Date(),
  }, { merge: true });

  // PROMPT-2: Schedule a re-engagement notification after 24h.
  // Uses setTimeout as a lightweight scheduler — acceptable here because:
  //   1. The notification is non-critical (nice-to-have nudge, not a transaction)
  //   2. If the process restarts before 24h, the user simply doesn't get the nudge
  //      — no data loss, no broken state.
  // For production at scale, replace setTimeout with a Cloud Tasks HTTP target
  // pointing at POST /internal/notifications/draft-reengagement.
  if (process.env.NODE_ENV !== 'test') {
    setTimeout(async () => {
      try {
        // Re-read progress — if user has moved past draft, skip the notification
        const snap = await db.collection('onboardingProgress').doc(userId).get();
        if (!snap.exists) return;

        const current = snap.data();

        // User progressed beyond draft — no nudge needed
        const progressedSteps = ['education_experience_saved', 'career_report_generated',
          'personal_details_saved', 'cv_generated', 'cv_uploaded', 'completed_without_cv'];
        const hasProgressed = (current.stepHistory || [])
          .some(h => progressedSteps.includes(h.step));

        if (hasProgressed) {
          logger.info('[OnboardingService] Re-engagement skipped — user progressed', { userId });
          return;
        }

        // User is still on draft — fire the notification via Pub/Sub
        const { publishEvent } = require('../../shared/pubsub');
        await publishEvent(
          NOTIFICATION_TOPIC,
          'NOTIFICATION_REQUESTED',
          {
            userId,
            notificationType: 'ONBOARDING_DRAFT_REENGAGEMENT',
            data: {
              actionUrl: '/onboarding',
              message:   'You left your profile unfinished. Complete it to unlock your Career Health Score.',
            },
          }
        );

        logger.info('[OnboardingService] Draft re-engagement notification sent', { userId });
      } catch (err) {
        // Non-fatal — never block the draft save response
        logger.warn('[OnboardingService] Draft re-engagement notification failed', {
          userId, error: err.message,
        });
      }
    }, DRAFT_REENGAGEMENT_DELAY_MS);
  }

  return { userId, step: 'draft', message: 'Draft saved. You can return to continue.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — GENERATE CAREER REPORT
// GAP C2: region-aware prompt
// GAP S4: targetRole in context
// GAP C4: careerGaps in context
// GAP T4: idempotency
// GAP S2: triggers provisional CHI
// ─────────────────────────────────────────────────────────────────────────────

function buildCareerReportPrompt(region) {
  return `You are a senior career counsellor with 20 years of experience in ${region}'s job market.

Analyse the provided education and work experience and return a structured career report.

You MUST respond with ONLY valid JSON — no preamble, no explanation, no markdown fences.

Return this exact structure:
{
  "overallAssessment": "<2-3 sentence summary of the candidate's profile>",
  "educationGaps": [
    { "gap": "<gap>", "recommendation": "<recommendation>" }
  ],
  "experienceGaps": [
    { "gap": "<gap>", "recommendation": "<recommendation>" }
  ],
  "skillRecommendations": [
    { "skill": "<skill name>", "reason": "<why relevant in ${region}>", "priority": "high|medium|low" }
  ],
  "careerOpportunities": [
    { "role": "<title>", "fit": "strong|good|possible", "reason": "<why this fits>" }
  ],
  "nextSteps": ["<step 1>", "<step 2>", "<step 3>"],
  "marketInsight": "<1-2 sentences about this profile in the ${region} market>"
}`;
}

async function generateCareerReport(userId, creditCost, idempotencyKey = null, userTier = 'free') {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  // GAP T4: idempotency
  const cached = await checkIdempotencyKey(userId, 'careerReport', idempotencyKey);
  if (cached) return cached;

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);

  if (!progressSnap.exists) throw new AppError('No onboarding data found. Please complete Step 1 first.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const data    = progressSnap.data();
  const profile = profileSnap.data() || {};

  if (!data.education?.length && !data.experience?.length) {
    throw new AppError('No education or experience data found. Please complete Step 1 first.', 422, { userId }, ErrorCodes.VALIDATION_ERROR);
  }

  // PROMPT-1 FIX: Require at least one expectedRoleId before running the career report.
  // Without a target role, CHI marketAlignment (25% weight) and salaryTrajectory (15% weight)
  // cannot resolve against salary bands — producing a 40% incomplete score on first session.
  // Users must call POST /career-intent with at least one expectedRoleId first.
  const expectedRoleIds = profile.expectedRoleIds || [];
  if (!expectedRoleIds.length) {
    throw new AppError(
      'Please add at least one target role before generating your career report. This helps us give you an accurate Career Health score.',
      422,
      { userId, hint: 'Call POST /onboarding/career-intent with expectedRoleIds first.' },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const aiContext = buildAIContext(data, profile);

  const educationText = data.education?.length
    ? data.education.map((e, i) => `Education ${i + 1}:\n  Qualification: ${e.qualificationName || e.qualificationId}\n  Institution: ${e.institution}\n  Year: ${e.yearOfGraduation || 'Not specified'}\n  Specialization: ${e.specialization || 'Not specified'}\n  Certifications: ${e.certifications?.join(', ') || 'None'}`).join('\n\n')
    : 'No education provided';

  const experienceText = data.experience?.length
    ? data.experience.map((e, i) => `Experience ${i + 1}:\n  Role: ${e.jobTitle} at ${e.company}\n  Industry: ${e.industryText || (e.industryId ? INDUSTRY_SECTORS[e.industryId] || e.industryId : null) || e.industry || 'Not specified'}\n  Period: ${e.startDate || '?'} - ${e.isCurrent ? 'Present' : (e.endDate || '?')}\n  Responsibilities:\n${e.responsibilities?.map(r => `    - ${r}`).join('\n') || '    Not specified'}`).join('\n\n')
    : 'No experience provided';

  const contextLines = [];
  if (aiContext.targetRole)                    contextLines.push(`Target Role: ${aiContext.targetRole}`);
  if (aiContext.city)                          contextLines.push(`City: ${aiContext.city}`);
  if (aiContext.currentSalary)                 contextLines.push(`Current Salary: ${aiContext.currentSalary} LPA`);
  if (aiContext.expectedSalary)                contextLines.push(`Expected Salary: ${aiContext.expectedSalary} LPA`);
  if (aiContext.timeline)                      contextLines.push(`Job Search Timeline: ${aiContext.timeline}`);
  if (aiContext.careerIntent?.length)          contextLines.push(`Target Role IDs: ${aiContext.careerIntent.join(', ')}`);
  if (aiContext.skillsWithProficiency?.length) contextLines.push(`Skills: ${aiContext.skillsWithProficiency.map(s => `${s.name}(${s.proficiency})`).join(', ')}`);
  if (aiContext.careerGaps?.length)            contextLines.push(`Career Gaps: ${aiContext.careerGaps.map(g => `${g.startDate}--${g.endDate} (${g.reason})`).join(', ')}`);

  const userPrompt = `EDUCATION:\n${educationText}\n\nWORK EXPERIENCE:\n${experienceText}${contextLines.length ? '\n\nADDITIONAL CONTEXT:\n' + contextLines.join('\n') : ''}`;

  let report;
  const startMs = Date.now();

  try {
    const anthropic = getAnthropicClient();
    const response  = await anthropic.messages.create({
      model: MODEL, max_tokens: 2048,
      system: buildCareerReportPrompt(aiContext.userRegion || 'India'),
      messages: [{ role: 'user', content: userPrompt }],
    });
    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    report = JSON.parse(stripJson(rawText));
    if (creditCost) await deductCredits(userId, creditCost);
    logAIInteraction({ module: 'onboarding.careerReport', model: MODEL, usage: response.usage ?? {}, latencyMs: Date.now() - startMs, status: 'success', userId });
  } catch (err) {
    logAIInteraction({ module: 'onboarding.careerReport', model: MODEL, latencyMs: Date.now() - startMs, status: 'error', error: err, userId });
    throw new AppError('Failed to generate career report. Please try again.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }

  await db.collection('onboardingProgress').doc(userId).set({
    step: 'career_report_generated', careerReport: report,
    ...appendStepHistory('career_report_generated'), updatedAt: new Date(),
  }, { merge: true });

  const [updatedProgressSnap, updatedProfileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);
  await persistCompletionIfReady(userId, updatedProgressSnap.data() || {}, updatedProfileSnap.data() || {});

  // GAP S2: trigger provisional CHI immediately — no resume needed
  triggerProvisionalChi(userId, data, profile, report, userTier);

  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'career_report_generated', trackA: true, aiUsed: true });

  const result = { userId, step: 'career_report_generated', careerReport: report, prompt: 'Would you like us to build your professional CV?' };
  await saveIdempotencyKey(userId, 'careerReport', idempotencyKey, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — SAVE PERSONAL DETAILS
// GAP S7: workAuthorisation
// GAP S8: linkedInUrl + portfolioUrl
// GAP S9: careerObjective removed
// ─────────────────────────────────────────────────────────────────────────────

async function savePersonalDetails(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { fullName, email, phone, city, country, skills = [], workAuthorisation, linkedInUrl, portfolioUrl,
          languages, projects, awards,
          profilePhotoUrl,  // PROMPT-4: profile photo for Gulf/Europe/Asia CV markets
        } = payload; // GAP-03: international CV fields
  // GAP S9: careerObjective is intentionally not read — AI writes professionalSummary

  if (!fullName || !email) throw new AppError('Full name and email are required to generate a CV.', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const VALID_WORK_AUTH = new Set(['citizen', 'permanent_resident', 'work_permit', 'require_sponsorship']);

  const personalDetails = {
    fullName:          String(fullName).trim(),
    email:             String(email).trim().toLowerCase(),
    phone:             phone   || null,
    city:              city    || null,
    country:           country || null,
    skills:            Array.isArray(skills) ? skills : [],
    workAuthorisation: VALID_WORK_AUTH.has(workAuthorisation) ? workAuthorisation : null, // GAP S7
    linkedInUrl:       validateUrl(linkedInUrl,  'linkedInUrl'),   // GAP S8
    portfolioUrl:      validateUrl(portfolioUrl, 'portfolioUrl'),  // GAP S8
    // PROMPT-4: profile photo — validated URL, stored as-is (frontend handles upload to Storage)
    profilePhotoUrl:   validateUrl(profilePhotoUrl, 'profilePhotoUrl'),
    // GAP-03: international CV fields — all optional, omitted from PDF when absent
    languages: Array.isArray(languages) ? languages.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim()) : [],
    projects:  Array.isArray(projects)  ? projects.filter(p => p?.title) : [],
    awards:    Array.isArray(awards)    ? awards.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()) : [],
  };

  await db.collection('onboardingProgress').doc(userId).set({
    step: 'personal_details_saved', wantsCv: true, personalDetails,
    ...appendStepHistory('personal_details_saved'), updatedAt: new Date(),
  }, { merge: true });

  // GAP C2: store country for region inference
  if (country) {
    await db.collection('userProfiles').doc(userId).set({ currentCountry: country, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  return { userId, step: 'personal_details_saved', message: 'Personal details saved. Ready to generate your CV.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// CV PREVIEW — returns HTML without PDF (GAP F4)
// ─────────────────────────────────────────────────────────────────────────────

async function getCvPreview(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);

  if (!progressSnap.exists) throw new AppError('No onboarding data found.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const data    = progressSnap.data();
  const profile = profileSnap.data() || {};

  if (!data.personalDetails?.fullName) throw new AppError('Personal details not found. Complete Step 3 first.', 422, { userId }, ErrorCodes.VALIDATION_ERROR);

  const aiContext = buildAIContext(data, profile);

  const previewContent = {
    professionalSummary: data.careerReport?.overallAssessment || '',
    experience: (data.experience || []).map(e => ({
      jobTitle: e.jobTitle, company: e.company,
      industry: e.industryText || (e.industryId ? INDUSTRY_SECTORS[e.industryId] || e.industryId : null) || e.industry || null,
      period: `${e.startDate || '?'} - ${e.isCurrent ? 'Present' : (e.endDate || '?')}`,
      responsibilities: e.responsibilities || [],
    })),
    education: (data.education || []).map(e => ({
      degree: e.qualificationName, institution: e.institution,
      year: e.yearOfGraduation ? String(e.yearOfGraduation) : '', specialization: e.specialization,
    })),
    skills:         aiContext.skillsWithProficiency.map(s => s.name),
    certifications: (data.education || []).flatMap(e => e.certifications || []),
  };

  const html = buildCvHtml(data.personalDetails, previewContent, aiContext);
  return { userId, step: 'cv_preview', html, isPreview: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// CV HTML BUILDER (shared by preview + generateCV)
// GAP S7: workAuthorisation in header
// GAP S8: LinkedIn + portfolio links
// GAP S9: No careerObjective — uses professionalSummary
// GAP C2: region used in ATS hint comment
// ─────────────────────────────────────────────────────────────────────────────

function buildCvHtml(personal, cvContent, aiContext = {}) {
  // PROMPT-4: skill proficiency badges — show level pill next to each skill
  // Source: aiContext.skillsWithProficiency (has proficiency) vs cvContent.skills (flat strings)
  const PROFICIENCY_COLOURS = {
    expert:       { bg: '#e8f5e9', text: '#2e7d32' },
    advanced:     { bg: '#e3f2fd', text: '#1565c0' },
    intermediate: { bg: '#e8f0fa', text: '#2c5f8a' },
    beginner:     { bg: '#fafafa', text: '#757575' },
  };

  const skillsHtml = (() => {
    const structured = aiContext.skillsWithProficiency || [];
    if (structured.length > 0) {
      return structured.map(s => {
        const prof  = s.proficiency?.toLowerCase() || 'intermediate';
        const col   = PROFICIENCY_COLOURS[prof] || PROFICIENCY_COLOURS.intermediate;
        const label = prof.charAt(0).toUpperCase() + prof.slice(1);
        return `<span class="skill-tag" style="background:${col.bg};color:${col.text}">` +
               `${s.name}<span class="skill-level">${label}</span></span>`;
      }).join('');
    }
    return cvContent.skills?.map(s => `<span class="skill-tag">${s}</span>`).join('') || '';
  })();

  const certsHtml = cvContent.certifications?.length
    ? `<section><h2>Certifications</h2><ul>${cvContent.certifications.map(c => `<li>${c}</li>`).join('')}</ul></section>`
    : '';

  // GAP-03: Languages section
  const langHtml = (personal.languages?.length || cvContent.languages?.length)
    ? `<section><h2>Languages</h2><div class="skills-wrap">${
        [...(personal.languages || []), ...(cvContent.languages || [])]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map(l => `<span class="skill-tag">${l}</span>`).join('')
      }</div></section>`
    : '';

  // GAP-03: Projects section
  const projectsHtml = cvContent.projects?.length
    ? `<section><h2>Projects</h2>${cvContent.projects.map(pr => `
    <div class="entry">
      <div class="entry-header"><span class="entry-title">${pr.title}</span></div>
      <p>${pr.description}</p>
      ${pr.tech?.length ? `<div class="skills-wrap">${pr.tech.map(t => `<span class="skill-tag">${t}</span>`).join('')}</div>` : ''}
    </div>`).join('')}</section>`
    : '';

  // GAP-03: Awards & Achievements
  const allAwards = [...(personal.awards || []), ...(cvContent.awards || [])].filter(Boolean);
  const awardsHtml = allAwards.length
    ? `<section><h2>Awards &amp; Achievements</h2><ul>${allAwards.map(a => `<li>${a}</li>`).join('')}</ul></section>`
    : '';

  const experienceHtml = cvContent.experience?.map(exp => `
    <div class="entry">
      <div class="entry-header"><span class="entry-title">${exp.jobTitle}</span><span class="entry-period">${exp.period || ''}</span></div>
      <div class="entry-subtitle">${exp.company}${exp.industry ? ` · ${exp.industry}` : ''}</div>
      <ul>${exp.responsibilities?.map(r => `<li>${r}</li>`).join('') || ''}</ul>
    </div>`).join('') || '';

  const educationHtml = cvContent.education?.map(edu => `
    <div class="entry">
      <div class="entry-header"><span class="entry-title">${edu.degree}${edu.specialization ? ` — ${edu.specialization}` : ''}</span><span class="entry-period">${edu.year || ''}</span></div>
      <div class="entry-subtitle">${edu.institution}</div>
    </div>`).join('') || '';

  const location = [personal.city, personal.country].filter(Boolean).join(', ');

  // GAP S8 + GAP-03: profile links
  const linkedInUrl  = personal.linkedInUrl  || aiContext.linkedInUrl;
  const portfolioUrl = personal.portfolioUrl || aiContext.portfolioUrl;
  const profileLinksHtml = [
    linkedInUrl  ? `<span><a href="${linkedInUrl}">LinkedIn</a></span>`   : '',
    portfolioUrl ? `<span><a href="${portfolioUrl}">Portfolio</a></span>` : '',
  ].filter(Boolean).join('');

  // GAP S7: work authorisation badge (hidden for citizens)
  const WORK_AUTH_LABELS = { permanent_resident: 'Permanent Resident', work_permit: 'Work Permit', require_sponsorship: 'Requires Sponsorship' };
  const workAuthHtml = aiContext.workAuthorisation && aiContext.workAuthorisation !== 'citizen'
    ? `<span>${WORK_AUTH_LABELS[aiContext.workAuthorisation] || aiContext.workAuthorisation}</span>`
    : '';

  // PROMPT-4: profile photo — shown in header when present.
  // Required in Gulf, Europe, and most Asia markets. Omitted when absent
  // so ATS-only CVs (US/Canada) remain clean without any code change.
  const photoUrl  = personal.profilePhotoUrl || null;
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" alt="Profile photo" class="profile-photo" />`
    : '';

  // PROMPT-4: GDPR footer — shown only for EU/UK region CVs.
  const region = aiContext.userRegion || 'India';
  const EU_REGIONS = new Set(['United Kingdom', 'European Union']);
  const gdprFooter = EU_REGIONS.has(region)
    ? `<footer class="gdpr-footer">
        This CV was prepared for job application purposes. Personal data included herein is provided
        under GDPR Article 6(1)(b) (performance of a contract / pre-contractual steps). The candidate
        may request erasure or correction of their data at any time.
       </footer>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- ATS-optimised CV · Market: ${region} -->
<style>
  /* PROMPT-4: Noto Sans — covers Arabic, Malayalam, Hindi, Tamil, Bengali + all Latin scripts */
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;700&family=Noto+Sans+Arabic:wght@400;600;700&family=Noto+Sans+Malayalam:wght@400;600&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Sans', 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; line-height: 1.5; padding: 36px 48px; max-width: 800px; margin: 0 auto; }
  .header { border-bottom: 2px solid #2c5f8a; padding-bottom: 14px; margin-bottom: 20px; display: flex; align-items: flex-start; gap: 18px; }
  .header-text { flex: 1; }
  .profile-photo { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; border: 2px solid #d0e4f0; flex-shrink: 0; }
  .name { font-size: 24pt; font-weight: 700; color: #2c5f8a; }
  .contact { font-size: 9.5pt; color: #555; margin-top: 4px; }
  .contact span { margin-right: 16px; }
  h2 { font-size: 11pt; font-weight: 700; color: #2c5f8a; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #d0e4f0; padding-bottom: 4px; margin: 18px 0 10px; }
  p { margin-bottom: 8px; }
  .entry { margin-bottom: 12px; }
  .entry-header { display: flex; justify-content: space-between; align-items: baseline; }
  .entry-title { font-weight: 600; font-size: 11pt; }
  .entry-period { font-size: 9.5pt; color: #666; white-space: nowrap; margin-left: 8px; }
  .entry-subtitle { font-size: 9.5pt; color: #555; margin-bottom: 4px; }
  ul { padding-left: 16px; }
  ul li { margin-bottom: 3px; font-size: 10.5pt; }
  .skills-wrap { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .skill-tag { background: #e8f0fa; color: #2c5f8a; padding: 2px 10px; border-radius: 12px; font-size: 9.5pt; font-weight: 500; display: inline-flex; align-items: center; gap: 5px; }
  .skill-level { font-size: 8pt; font-weight: 400; opacity: 0.75; }
  a { color: #2c5f8a; text-decoration: none; }
  .gdpr-footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #e0e0e0; font-size: 8pt; color: #999; line-height: 1.4; }
</style>
</head>
<body>
  <div class="header">
    ${photoHtml}
    <div class="header-text">
      <div class="name">${personal.fullName}</div>
      <div class="contact">
        ${personal.email  ? `<span>&#9993; ${personal.email}</span>`  : ''}
        ${personal.phone  ? `<span>&#128222; ${personal.phone}</span>` : ''}
        ${location        ? `<span>&#128205; ${location}</span>`       : ''}
        ${profileLinksHtml}
        ${workAuthHtml}
      </div>
    </div>
  </div>
  ${cvContent.professionalSummary ? `<section><h2>Professional Summary</h2><p>${cvContent.professionalSummary}</p></section>` : ''}
  ${cvContent.experience?.length  ? `<section><h2>Work Experience</h2>${experienceHtml}</section>` : ''}
  ${cvContent.education?.length   ? `<section><h2>Education</h2>${educationHtml}</section>` : ''}
  ${(aiContext.skillsWithProficiency?.length || cvContent.skills?.length) ? `<section><h2>Skills</h2><div class="skills-wrap">${skillsHtml}</div></section>` : ''}
  ${certsHtml}
  ${langHtml}
  ${projectsHtml}
  ${awardsHtml}
  ${gdprFooter}
</body>
</html>`;
}
// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — GENERATE CV PDF
// GAP S5: mergeSkills
// GAP C1: structured cvContent stored for CHI
// GAP C2: region-aware prompt
// GAP T4: idempotency
// ─────────────────────────────────────────────────────────────────────────────

function buildCvContentPrompt(region) {
  return `You are a professional CV writer specialising in ATS-friendly resumes for the ${region} job market.

Given the candidate's profile, write polished, professional CV content.

You MUST respond with ONLY valid JSON — no preamble, no explanation, no markdown fences.

Return this exact structure:
{
  "professionalSummary": "<3-4 sentence summary, no first-person pronouns>",
  "experience": [
    { "jobTitle": "<title>", "company": "<company>", "industry": "<industry>", "period": "<start> - <end or Present>", "responsibilities": ["<action verb + what + impact>", "<bullet 2>"] }
  ],
  "education": [
    { "degree": "<degree>", "institution": "<institution>", "year": "<year>", "specialization": "<specialization or null>" }
  ],
  "skills": ["<skill 1>", "<skill 2>"],
  "certifications": ["<cert 1>"],
  "languages": ["<language (level)>"],
  "projects": [{ "title": "<project title>", "description": "<1-2 sentence impact-focused description>", "tech": ["<tech 1>", "<tech 2>"] }],
  "awards": ["<award or achievement>"]
}

Only populate languages, projects, and awards if the candidate profile includes relevant information. Return empty arrays [] if no data is available for those sections.`;
}

async function generateCV(userId, creditCost, idempotencyKey = null) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  // GAP T4: idempotency
  const cached = await checkIdempotencyKey(userId, 'generateCV', idempotencyKey);
  if (cached) return cached;

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);

  if (!progressSnap.exists) throw new AppError('No onboarding data found.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const data    = progressSnap.data();
  const profile = profileSnap.data() || {};

  if (!data.personalDetails?.fullName) throw new AppError('Personal details not found. Please complete Step 3 first.', 422, { userId }, ErrorCodes.VALIDATION_ERROR);

  const aiContext   = buildAIContext(data, profile);
  const mergedSkills = aiContext.skillsWithProficiency; // GAP S5: already merged in buildAIContext

  const profileText = JSON.stringify({
    personal:   { ...data.personalDetails, linkedInUrl: aiContext.linkedInUrl, portfolioUrl: aiContext.portfolioUrl, workAuthorisation: aiContext.workAuthorisation },
    education:  data.education  || [],
    experience: data.experience || [],
    skills:     mergedSkills,
    targetRole: aiContext.targetRole,
    careerGaps: aiContext.careerGaps,
    context: { currentSalary: aiContext.currentSalary, expectedSalary: aiContext.expectedSalary, timeline: aiContext.timeline },
  }, null, 2);

  let cvContent;
  const startMs = Date.now();

  try {
    const anthropic = getAnthropicClient();
    const response  = await anthropic.messages.create({
      model: MODEL, max_tokens: 2048,
      system: buildCvContentPrompt(aiContext.userRegion || 'India'),
      messages: [{ role: 'user', content: `Candidate Profile:\n${profileText}` }],
    });
    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    cvContent = JSON.parse(stripJson(rawText));
    if (creditCost) await deductCredits(userId, creditCost);
    logAIInteraction({ module: 'onboarding.generateCV', model: MODEL, usage: response.usage ?? {}, latencyMs: Date.now() - startMs, status: 'success', userId });
  } catch (err) {
    logAIInteraction({ module: 'onboarding.generateCV', model: MODEL, latencyMs: Date.now() - startMs, status: 'error', error: err, userId });
    throw new AppError('Failed to generate CV content. Please try again.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }

  const html = buildCvHtml(data.personalDetails, cvContent, aiContext);
  let pdfBuffer;

  try {
    // GAP T1: prefer Gotenberg over Puppeteer if configured
    pdfBuffer = process.env.GOTENBERG_URL
      ? await _renderPdfWithGotenberg(html)
      : await _renderPdfWithPuppeteer(html);
  } catch (err) {
    throw new AppError('Failed to render CV PDF. Please try again.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }

  const resumeId    = crypto.randomUUID();
  const storagePath = `resumes/${userId}/${resumeId}.pdf`;
  let fileUrl = null, signedUrlExpiresAt = null;

  if (process.env.NODE_ENV !== 'test') {
    try {
      const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const file   = bucket.file(storagePath);
      await file.save(pdfBuffer, { metadata: { contentType: 'application/pdf' }, resumable: false });
      signedUrlExpiresAt = new Date(Date.now() + URL_TTL_MS);
      const [signedUrl]  = await file.getSignedUrl({ action: 'read', expires: signedUrlExpiresAt.getTime() });
      fileUrl = signedUrl;
    } catch (err) {
      throw new AppError('CV generated but failed to upload. Please try again.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
    }
  }

  const now      = new Date();
  const fileName = `${data.personalDetails.fullName.replace(/\s+/g, '_')}_CV.pdf`;

  const resumeDoc = {
    userId, fileName, fileUrl, storagePath, signedUrlExpiresAt,
    mimetype: 'application/pdf',
    resumeText:          JSON.stringify(cvContent),
    cvContentStructured: cvContent,   // GAP C1: structured JSON for CHI (no truncation)
    targetRole:          aiContext.targetRole || null,
    analysisStatus:      'pending',
    generatedFromOnboarding: true,
    score: null, tier: null, scoreBreakdown: null,
    strengths: [], improvements: [], topSkills: [],
    estimatedExperienceYears: null,
    createdAt: now, updatedAt: now, softDeleted: false,
  };

  // FIX G-10: version chain
  const previousCvId = data.cvResumeId || null;
  const batch = db.batch();
  batch.set(db.collection('resumes').doc(resumeId), resumeDoc);
  if (previousCvId) {
    batch.set(db.collection('resumes').doc(previousCvId), {
      softDeleted: true, softDeletedAt: now, supersededBy: resumeId, updatedAt: now,
    }, { merge: true });
  }
  batch.set(db.collection('onboardingProgress').doc(userId), {
    step: 'cv_generated', cvResumeId: resumeId,
    ...(previousCvId ? { previousCvIds: FieldValue.arrayUnion(previousCvId) } : {}),
    ...appendStepHistory('cv_generated'), updatedAt: now,
  }, { merge: true });
  await batch.commit();

  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'cv_generated', trackA: true, aiUsed: true });
  triggerResumeScoring(userId, resumeId); // FIX G-01

  const result = { userId, resumeId, fileName, fileUrl, signedUrlExpiresAt: signedUrlExpiresAt?.toISOString() || null, step: 'cv_generated', message: 'Your professional CV has been generated successfully.' };
  await saveIdempotencyKey(userId, 'generateCV', idempotencyKey, result);
  return result;
}

async function _renderPdfWithPuppeteer(html) {
  const puppeteer = require('puppeteer');
  const browser   = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page      = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const buf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await browser.close();
  return buf;
}

async function _renderPdfWithGotenberg(html) {
  const fetch    = require('node-fetch');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('files', Buffer.from(html), { filename: 'index.html', contentType: 'text/html' });
  const res = await fetch(`${process.env.GOTENBERG_URL}/forms/chromium/convert/html`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Gotenberg error: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP T5: Get / refresh signed CV URL
// ─────────────────────────────────────────────────────────────────────────────

async function getCvSignedUrl(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const progressSnap = await db.collection('onboardingProgress').doc(userId).get();
  if (!progressSnap.exists) throw new AppError('No onboarding data found.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const { cvResumeId } = progressSnap.data();
  if (!cvResumeId) throw new AppError('No CV generated yet.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const resumeSnap = await db.collection('resumes').doc(cvResumeId).get();
  if (!resumeSnap.exists) throw new AppError('Resume record not found.', 404, { userId }, ErrorCodes.NOT_FOUND);

  const resume    = resumeSnap.data();
  const now       = Date.now();
  const expiresAt = resume.signedUrlExpiresAt?.toMillis?.() || new Date(resume.signedUrlExpiresAt || 0).getTime();

  // Return if not expired (more than 1 hour left)
  if (expiresAt && (expiresAt - now) > 60 * 60 * 1000 && resume.fileUrl) {
    return { userId, resumeId: cvResumeId, fileUrl: resume.fileUrl, signedUrlExpiresAt: new Date(expiresAt).toISOString(), refreshed: false };
  }

  try {
    const bucket         = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const file           = bucket.file(resume.storagePath);
    const newExpiresAt   = new Date(now + URL_TTL_MS);
    const [newSignedUrl] = await file.getSignedUrl({ action: 'read', expires: newExpiresAt.getTime() });
    await db.collection('resumes').doc(cvResumeId).update({ fileUrl: newSignedUrl, signedUrlExpiresAt: newExpiresAt, updatedAt: new Date() });
    return { userId, resumeId: cvResumeId, fileUrl: newSignedUrl, signedUrlExpiresAt: newExpiresAt.toISOString(), refreshed: true };
  } catch (err) {
    throw new AppError('Failed to refresh signed URL.', 502, { userId }, ErrorCodes.EXTERNAL_SERVICE_ERROR);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SKIP CV
// ─────────────────────────────────────────────────────────────────────────────

async function skipCv(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  await db.collection('onboardingProgress').doc(userId).set({
    step: 'completed_without_cv', wantsCv: false,
    ...appendStepHistory('completed_without_cv'), updatedAt: new Date(),
  }, { merge: true });
  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);
  await persistCompletionIfReady(userId, progressSnap.data() || {}, profileSnap.data() || {});
  return { userId, step: 'completed_without_cv', message: 'Onboarding complete. You can always generate a CV later.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACK B — SAVE CAREER INTENT (unchanged logic, GAP S6 logging added)
// ─────────────────────────────────────────────────────────────────────────────

async function saveCareerIntent(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { careerHistory, expectedRoleIds, currentCity, currentSalaryLPA, expectedSalaryLPA, jobSearchTimeline, skills,
          noticePeriodDays, workMode, availableFrom } = payload; // GAP-08: recruiter-critical fields

  // GAP-09: careerHistory is now optional — allows a lightweight Step 0 call with just
  // expectedRoleIds + optional salary/city, before the full Track B form is completed.
  // Full careerHistory can be provided later in the complete Track B submission.
  if (!expectedRoleIds?.length) {
    throw new AppError('expectedRoleIds is required.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  // GAP-08: validate new optional fields
  const VALID_WORK_MODES = new Set(['remote', 'hybrid', 'onsite', 'flexible']);
  if (workMode !== undefined && workMode !== null && !VALID_WORK_MODES.has(workMode)) {
    throw new AppError(`workMode must be one of: ${[...VALID_WORK_MODES].join(', ')}.`, 400, {}, ErrorCodes.VALIDATION_ERROR);
  }
  if (noticePeriodDays !== undefined && noticePeriodDays !== null &&
      (typeof noticePeriodDays !== 'number' || noticePeriodDays < 0)) {
    throw new AppError('noticePeriodDays must be a non-negative number.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (Array.isArray(careerHistory) && careerHistory.length > 0) {
    for (let i = 0; i < careerHistory.length; i++) {
      const entry = careerHistory[i];
      if (!entry.roleId?.trim()) throw new AppError(`careerHistory[${i}]: roleId is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
      if (typeof entry.durationMonths !== 'number' || entry.durationMonths < 0) throw new AppError(`careerHistory[${i}]: durationMonths must be a non-negative number.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    }
  }

  const VALID_PROF = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
  if (Array.isArray(skills)) {
    for (let i = 0; i < skills.length; i++) {
      const s = skills[i];
      if (!s.name) throw new AppError(`skills[${i}]: name is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
      if (s.proficiency && !VALID_PROF.has(s.proficiency)) throw new AppError(`skills[${i}]: proficiency must be one of ${[...VALID_PROF].join(', ')}.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
    }
  }

  const profileUpdate = {
    expectedRoleIds: expectedRoleIds.map(id => String(id).trim()).filter(Boolean),
    updatedAt: FieldValue.serverTimestamp(),
  };

  // GAP-09: only write careerHistory when provided (mini Step 0 omits it)
  if (Array.isArray(careerHistory) && careerHistory.length > 0) {
    profileUpdate.careerHistory = careerHistory.map(r => ({ roleId: r.roleId.trim(), durationMonths: r.durationMonths, description: r.description || null, isCurrent: r.isCurrent || false }));
  }

  if (currentCity       !== undefined) profileUpdate.currentCity       = currentCity       || null;
  if (currentSalaryLPA  !== undefined) profileUpdate.currentSalaryLPA  = currentSalaryLPA  ?? null;
  if (expectedSalaryLPA !== undefined) profileUpdate.expectedSalaryLPA = expectedSalaryLPA ?? null;
  if (jobSearchTimeline !== undefined) profileUpdate.jobSearchTimeline  = jobSearchTimeline || null;
  if (Array.isArray(skills)) profileUpdate.skills = skills.map(s => ({ name: String(s.name).trim(), proficiency: VALID_PROF.has(s.proficiency) ? s.proficiency : 'intermediate' }));
  // GAP-08: recruiter-critical availability fields
  if (noticePeriodDays !== undefined) profileUpdate.noticePeriodDays = noticePeriodDays ?? null;
  if (workMode         !== undefined) profileUpdate.workMode         = workMode         || null;
  if (availableFrom    !== undefined) profileUpdate.availableFrom    = availableFrom    || null;

  await Promise.all([
    db.collection('userProfiles').doc(userId).set(profileUpdate, { merge: true }),
    db.collection('onboardingProgress').doc(userId).set({
      ...appendStepHistory('career_intent_saved'), step: 'career_intent_saved', updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);
  await persistCompletionIfReady(userId, progressSnap.data() || {}, profileSnap.data() || {});
  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'career_intent_saved', trackB: true });

  // GAP S6: log role cross-reference (non-blocking)
  const expTitles = (progressSnap.data()?.experience || []).map(e => e.jobTitle).filter(Boolean);
  if (expTitles.length && profileUpdate.expectedRoleIds.length) {
    logger.debug('[OnboardingService] Role cross-reference', { userId, experienceTitles: expTitles, expectedRoleIds: profileUpdate.expectedRoleIds });
  }

  return { userId, step: 'career_intent_saved', message: 'Career intent saved.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// G-14: GET CHI EXPLAINER
// Returns static dimension descriptions + user's current chiDataCompleteness
// nudges. Called by the frontend BEFORE showing the CHI score so users
// understand what they're about to see. No AI calls, no writes — read-only.
// ─────────────────────────────────────────────────────────────────────────────

const CHI_DIMENSION_DESCRIPTIONS = Object.freeze({
  skillVelocity: {
    label:       'Skill Velocity',
    weight:      '25%',
    description: 'Are your skills current and growing relative to what the market is hiring for right now?',
    improveWith: 'Add skills with proficiency levels, keep them up to date with your current role.',
  },
  experienceDepth: {
    label:       'Experience Depth',
    weight:      '20%',
    description: 'Is your career progression strong for your years of experience?',
    improveWith: 'Add quantified achievements and responsibilities to each role.',
  },
  marketAlignment: {
    label:       'Market Alignment',
    weight:      '25%',
    description: 'How well does your profile match what employers in your target market are hiring for?',
    improveWith: 'Set at least one target role and add your current location.',
  },
  salaryTrajectory: {
    label:       'Salary Trajectory',
    weight:      '15%',
    description: 'Based on your level and experience, are you on track, underpaid, or above market?',
    improveWith: 'Add your current and expected salary so we can benchmark against market rates.',
  },
  careerMomentum: {
    label:       'Career Momentum',
    weight:      '15%',
    description: 'Is your career moving forward consistently — no long unexplained gaps, regular growth?',
    improveWith: 'Add career gap reasons and ensure experience dates are complete.',
  },
});

async function getChiExplainer(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);

  const progress = progressSnap.exists  ? progressSnap.data() : {};
  const profile  = profileSnap.exists   ? profileSnap.data()  : {};

  // Reuse the existing completeness scorer so nudges are always in sync
  const { score, missing } = computeChiCompleteness(progress, profile);

  // Surface any existing CHI score so the frontend can show "your last score was X"
  let lastScore = null;
  try {
    const chiSnap = await db.collection('careerHealthIndex')
      .where('userId', '==', userId)
      .where('softDeleted', '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();
    if (!chiSnap.empty) {
      const d = chiSnap.docs[0].data();
      lastScore = {
        chiScore:       d.chiScore,
        analysisSource: d.analysisSource,
        marketPosition: d.marketPosition,
        generatedAt:    d.generatedAt?.toDate?.()?.toISOString() ?? d.generatedAt,
      };
    }
  } catch {
    // Non-fatal — explainer still works without last score
  }

  return {
    userId,
    dimensions:          CHI_DIMENSION_DESCRIPTIONS,
    scoringModel: {
      totalDimensions: 5,
      scoreRange:      '0–100',
      bands: [
        { min: 85, label: 'Highly Ready' },
        { min: 70, label: 'Ready' },
        { min: 55, label: 'Moderately Ready' },
        { min: 40, label: 'Partially Ready' },
        { min: 0,  label: 'Not Ready' },
      ],
    },
    dataReadiness: {
      completenessScore: score,
      missingFields:     missing,
      isReadyForChi:     score >= 60,
      message:           score >= 60
        ? 'Your profile has enough data for a reliable Career Health Score.'
        : `Complete ${missing.length} more field${missing.length !== 1 ? 's' : ''} to unlock a reliable score.`,
    },
    lastScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET PROGRESS
// GAP F2: nextRequiredStep
// GAP F7: progressPercent + completedSteps
// FIX G-04/G-11: remainingQuota + quotaExhausted
// ─────────────────────────────────────────────────────────────────────────────

// GAP-05: Compute CHI data completeness score (0-100) and missing field nudges.
// Does NOT change the completion gate — purely informational signal for the frontend.
function computeChiCompleteness(progress, profile) {
  const checks = [
    // [field present?, weight, label, nudge message]
    [!!profile.expectedRoleIds?.length,  20, 'Target Roles',    'Add your target role'],
    [!!profile.currentSalaryLPA,         20, 'Current Salary',  'Add your current salary'],
    [!!profile.currentCity,              15, 'Location',        'Add your city'],
    [!!profile.skills?.length,           20, 'Skills',          'Add your skills'],
    [!!(progress.education?.length),     10, 'Education',       'Add education history'],
    [!!(progress.experience?.length),    10, 'Work Experience', 'Add work experience'],
    [!!profile.totalExperienceYears,      5, 'Tenure',          'Add dates to your experience entries'],
  ];
  let score = 0;
  const missing = [];
  for (const [present, weight, label, nudge] of checks) {
    if (present) score += weight;
    else missing.push({ field: label, nudge, improvementPts: weight });
  }
  return { score: Math.min(100, score), missing };
}

async function getProgress(userId, tier) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [progressSnap, profileSnap, remainingQuota] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
    tier === 'free' ? getRemainingQuota(userId, 'free').catch(() => null) : Promise.resolve(null),
  ]);

  const upgradeUrl   = process.env.UPGRADE_URL ?? '/pricing';
  let quotaExhausted = null;

  if (tier === 'free' && remainingQuota) {
    quotaExhausted = {
      careerReport: (remainingQuota.careerReport ?? 1) <= 0,
      generateCV:   (remainingQuota.generateCV   ?? 1) <= 0,
      upgradeUrl,
    };
  }

  if (!progressSnap.exists) {
    return { userId, step: 'not_started', nextRequiredStep: 'education_experience', data: null, remainingQuota, quotaExhausted, progressPercent: 0, totalSteps: 4, completedSteps: 0 };
  }

  const progress = progressSnap.data();
  const profile  = profileSnap.data() || {};
  const { isComplete, trackA, trackB } = evaluateCompletion(progress, profile);

  // GAP-05: CHI data completeness nudge signal
  const chiCompleteness = computeChiCompleteness(progress, profile);

  // GAP F2: next required step
let nextRequiredStep = null;

if (!progress.education?.length && !progress.experience?.length) {
  nextRequiredStep = 'education_experience';
}
else if (!progress.careerReport) {
  nextRequiredStep = 'career_report';
}
// career_intent is enrichment-only and does NOT gate completion

  // GAP F7: progress percentage
  let completedSteps = 0;

if (progress.education?.length || progress.experience?.length) completedSteps++;
if (progress.careerReport)   completedSteps++;
if (isComplete)              completedSteps++;

const totalSteps = 3;
const progressPercent =
  Math.round((Math.min(completedSteps, totalSteps) / totalSteps) * 100);

  return {
    userId,
    step:                progress.step,
    onboardingCompleted: profile.onboardingCompleted === true,
    tracks:              { trackA, trackB, isComplete },
    stepHistory:         progress.stepHistory || [],
    onboardingStartedAt:   progress.onboardingStartedAt   || null,
    onboardingCompletedAt: profile.onboardingCompletedAt  || null,
    remainingQuota,
    quotaExhausted,
    previousCvIds:       progress.previousCvIds || [],
    nextRequiredStep,     // GAP F2
    progressPercent,      // GAP F7
    totalSteps,
    completedSteps,
    chiDataCompleteness: chiCompleteness.score,   // GAP-05: 0-100 enrichment score
    chiDataMissing:      chiCompleteness.missing, // GAP-05: nudge array for frontend
    draft:               progress.draft || null, // GAP F5: expose saved draft
    data:                progress,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  saveConsent,
  saveEducationAndExperience,
  saveDraft,
  generateCareerReport,
  savePersonalDetails,
  getCvPreview,
  generateCV,
  getCvSignedUrl,
  skipCv,
  getProgress,
  getChiExplainer,
  saveCareerIntent,
  calculateCareerWeights,
  buildAIContext,
  mergeSkills,
  buildCvHtml,
  CHI_TREND_THRESHOLD,
  appendStepHistory,        // GAP-11: used by uploadCvDuringOnboarding controller
  persistCompletionIfReady, // GAP-11: used by uploadCvDuringOnboarding controller
};