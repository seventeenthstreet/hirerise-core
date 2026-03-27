'use strict';

/**
 * onboarding.intake.service.js — B-01 FIX: Data capture sub-service
 *
 * Extracted from onboarding.service.js (god-object decomposition).
 * Owns: saveConsent, saveQuickStart, saveEducationAndExperience,
 *       saveDraft, getDraft, savePersonalDetails, saveCareerIntent
 *
 * MIGRATED: All Firestore db.collection() calls replaced with supabase.from()
 * FieldValue.serverTimestamp() → new Date().toISOString()
 * FieldValue.arrayUnion()     → mergeStepHistory() helper
 * batch()                     → Promise.all([...])
 */

const supabase = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger          = require('../../utils/logger');
const { getQualificationById } = require('../qualification/qualification.service');
const { validateRolesExist } = require('../roles/roles.service');
const { INDUSTRY_SECTORS } = require('../roles/roles.types');
const {
  MODEL, IDEMPOTENCY_TTL_MS,
  stripHtml,
  sanitiseInput, validateUrl, validateYearOfGraduation,
  validateAndSanitiseResponsibilities, validateAchievements,
  validateExperienceDates, computeExperienceMonths, mergeSkills,
  emitOnboardingEvent, appendStepHistory, mergeStepHistory, scheduleReengagementJob,
  mergeCanonicalSkills, persistCompletionIfReady, buildAIContext,
  triggerProvisionalChi, inferRegion,
  VALID_SENIORITY, EXPERIENCE_TYPE_WEIGHTS, VALID_EXPERIENCE_TYPES,
} = require('./onboarding.helpers');

async function saveConsent(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  logger.info('[Onboarding] saveConsent start', { userId });

  const { consentVersion, consentSource = 'onboarding_step_0',
          // GAP-M8: referralSource — acquisition channel attribution.
          // Stored at consent time (the earliest reliable moment in the funnel) so the
          // product team can compute onboarding completion rates and CHI quality by
          // acquisition channel (e.g. organic vs paid vs referral vs App Store).
          // Validated against a controlled enum so queries don't fragment on typos.
          referralSource = null,
        } = payload;

  const VALID_REFERRAL_SOURCES = new Set([
    'organic_search', 'paid_search', 'social_organic', 'social_paid',
    'referral_link', 'email_campaign', 'app_store', 'direct', 'other',
  ]);

  const sanitisedReferralSource = referralSource
    ? (VALID_REFERRAL_SOURCES.has(String(referralSource).trim())
        ? String(referralSource).trim()
        : 'other')
    : null;

  if (!consentVersion || typeof consentVersion !== 'string' || !consentVersion.trim()) {
    throw new AppError(
      'consentVersion is required (e.g. "1.0"). Pass the version of the Terms & Privacy Policy the user accepted.',
      400, {}, ErrorCodes.VALIDATION_ERROR,
      'Something went wrong loading our Terms & Privacy Policy version. Please refresh and try again.'
    );
  }

  const version = consentVersion.trim();

  // P0-05: Validate consentVersion against the consentVersions collection.
  // This prevents stale or fabricated version strings from being recorded,
  // which would create GDPR audit records that don't map to any real T&C document.
  // The collection is seeded by ops/release scripts whenever T&C are updated.
  // If the collection is empty or the doc is missing, we fall through rather than
  // blocking consent — this prevents a missing seed from bricking onboarding.
  const { data: consentVersionRow, error: consentVersionErr } = await supabase
    .from('consentVersions')
    .select('*')
    .eq('id', version)
    .maybeSingle();
  if (consentVersionErr && consentVersionErr.code !== 'PGRST116') {
    logger.error('[DB] consentVersions.get:', consentVersionErr.message);
  }

  if (consentVersionRow?.deprecated === true) {
    throw new AppError(
      `consentVersion "${version}" is no longer valid. Please use the current version.`,
      400,
      { providedVersion: version },
      ErrorCodes.VALIDATION_ERROR,
      'This version of our Terms & Privacy Policy has been updated. Please refresh the page and accept the latest version.'
    );
  }
  // If the doc doesn't exist at all in consentVersions, we allow it through
  // (graceful degradation) but log a warning for ops to investigate.
  if (!consentVersionRow) {
    logger.warn('[OnboardingService] consentVersion not found in consentVersions collection — allowing through', { userId, version });
  }

  const now = new Date();
  const nowISO = now.toISOString();

  // ── Idempotency: if same version already stored, return existing record ────
  const { data: existingProgress, error: progressErr } = await supabase
    .from('onboardingProgress')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (progressErr && progressErr.code !== 'PGRST116') {
    logger.error('[DB] onboardingProgress.get:', progressErr.message);
  }

  if (existingProgress) {
    if (existingProgress.consentVersion === version && existingProgress.consentGrantedAt) {
      logger.debug('[OnboardingService] Consent already recorded for this version — skipping', { userId, version });
      return {
        userId,
        step:             'consent_saved',
        consentVersion:   version,
        consentGrantedAt: existingProgress.consentGrantedAt,
        alreadyRecorded:  true,
      };
    }
  }

  const consentPayload = {
    consentGrantedAt: nowISO,
    consentVersion:   version,
    consentSource,
    // GAP-M8: referralSource — stored in all three collections so the CHI pipeline
    // and product analytics can segment by acquisition channel without a join.
    ...(sanitisedReferralSource ? { referralSource: sanitisedReferralSource } : {}),
  };

  const stepHistory = await mergeStepHistory(userId, 'consent_saved');

  // Write atomically to all three collections via Promise.all
  await Promise.all([
    supabase.from('users').upsert({
      id: userId,
      ...consentPayload,
      updatedAt: nowISO,
    }),
    supabase.from('userProfiles').upsert({
      id: userId,
      ...consentPayload,
      updatedAt: nowISO,
    }),
    supabase.from('onboardingProgress').upsert({
      id:                  userId,
      userId,
      step:                'consent_saved',
      ...consentPayload,
      stepHistory,
      // SPRINT-4A H12: track last active step for drop-off cohort analysis
      lastActiveStep:      'consent_saved',
      lastActiveAt:        nowISO,
      onboardingStartedAt: nowISO,
      updatedAt:           nowISO,
    }),
  ]);

  logger.info('[OnboardingService] Consent recorded', { userId, version, consentSource });
  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'consent_saved' });

  const result = {
    userId,
    step:             'consent_saved',
    consentVersion:   version,
    consentGrantedAt: nowISO,
    referralSource:   sanitisedReferralSource,
    alreadyRecorded:  false,
  };

  logger.info('[Onboarding] saveConsent complete', { userId, consentVersion: version, referralSource: sanitisedReferralSource });
  return result;
}

async function saveQuickStart(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  logger.info('[Onboarding] saveQuickStart start', { userId });

  const {
    jobTitle,
    company,
    startDate,
    isCurrent      = true,
    endDate        = null,
    expectedRoleIds = [],
    skills          = [],
    // Optional enrichment fields accepted here but not required
    industryId      = null,
    targetRoleFreeText = null, // P1-10: non-validated free text fallback for role picker
  } = payload;

  // ── Required field validation ────────────────────────────────────────────
  if (!jobTitle || !String(jobTitle).trim()) {
    throw new AppError('jobTitle is required.', 400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please enter your current or most recent job title.');
  }
  if (!company || !String(company).trim()) {
    throw new AppError('company is required.', 400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please enter the company name for your current or most recent role.');
  }
  if (!startDate || !String(startDate).trim()) {
    throw new AppError('startDate is required (format: YYYY-MM).', 400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please enter when you started this role (month and year).');
  }
  // startDate format: YYYY-MM
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(startDate).trim())) {
    throw new AppError('startDate must be in YYYY-MM format (e.g. "2021-03").', 400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please enter your start date as YYYY-MM, for example: 2021-03');
  }

  // ── expectedRoleIds: at least one required ───────────────────────────────
  if (!Array.isArray(expectedRoleIds) || expectedRoleIds.length === 0) {
    // Allow targetRoleFreeText as a graceful bypass — P1-10
    if (!targetRoleFreeText || !String(targetRoleFreeText).trim()) {
      throw new AppError(
        'At least one expectedRoleId or a targetRoleFreeText is required.',
        400, {}, ErrorCodes.VALIDATION_ERROR,
        'Please select the role you\'re targeting, or type it in if you don\'t see it in the list.'
      );
    }
    // Free-text path: store as-is without validation, no CHI marketAlignment seeding
  } else {
    // Validate all expectedRoleIds exist in parallel (P0-02 verified this uses Promise.all)
    await validateRolesExist(expectedRoleIds.map(id => String(id).trim()));
  }

  // ── skills: 0-10, each needs a name ─────────────────────────────────────
  const VALID_PROF = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
  const sanitisedSkills = (Array.isArray(skills) ? skills.slice(0, 10) : []).map((s, i) => {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) throw new AppError(`skills[${i}]: name is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR,
      `Skill #${i + 1} is missing a name. Please enter a skill name.`);
    return { name, proficiency: VALID_PROF.has(s?.proficiency) ? s.proficiency : 'intermediate' };
  });

  // ── Build minimal experience entry ──────────────────────────────────────
  const quickExperience = [{
    jobTitle:         stripHtml(String(jobTitle).trim()),
    company:          stripHtml(String(company).trim()),
    startDate:        String(startDate).trim(),
    endDate:          isCurrent ? null : (endDate || null),
    isCurrent:        !!isCurrent,
    industryId:       industryId || null,
    source:           'quick_start',
    responsibilities: [],
    achievements:     [],
  }];

  const now         = new Date();
  const nowISO      = now.toISOString();
  const cleanRoleIds = expectedRoleIds.map(id => String(id).trim());
  const userTier    = 'free'; // tier not available in service — controller must pass if needed

  const stepHistory = await mergeStepHistory(userId, 'quick_start_saved');

  // ── Writes via Promise.all ────────────────────────────────────────────────
  // onboardingProgress — quick-start fields stored under top-level keys so
  // generateCareerReport() can read them directly without a separate lookup
  await Promise.all([
    supabase.from('onboardingProgress').upsert({
      id:                  userId,
      userId,
      step:                'quick_start_saved',
      quickStartCompleted: true,
      experience:          quickExperience,
      skills:              sanitisedSkills,
      expectedRoleIds:     cleanRoleIds,
      targetRoleFreeText:  targetRoleFreeText ? String(targetRoleFreeText).trim().slice(0, 120) : null,
      importSource:        'manual',
      stepHistory,
      lastActiveStep:      'quick_start_saved',
      lastActiveAt:        nowISO,
      onboardingStartedAt: nowISO,
      updatedAt:           nowISO,
    }),
    // userProfiles — mirror expectedRoleIds + skills so CHI service reads work immediately
    supabase.from('userProfiles').upsert({
      id:              userId,
      expectedRoleIds: cleanRoleIds,
      skills:          sanitisedSkills,
      updatedAt:       nowISO,
    }),
  ]);

  // ── Trigger provisional CHI asynchronously ───────────────────────────────
  // Fire-and-forget: quick provisional CHI uses the same triggerProvisionalChi()
  // path but with analysisSource 'quick_provisional'. Non-fatal if it fails.
  const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);
  const progressData = progressRow || {};
  const profileData  = profileRow  || {};

  // Pass null as careerReport — provisional CHI handles this gracefully
  triggerProvisionalChi(userId, progressData, profileData, null, userTier);

  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'quick_start_saved', trackA: true });

  logger.info('[OnboardingService] Quick start saved', {
    userId,
    jobTitle: quickExperience[0].jobTitle,
    roleCount: cleanRoleIds.length,
    skillCount: sanitisedSkills.length,
  });

  const quickStartResult = {
    userId,
    step:                'quick_start_saved',
    quickStartCompleted: true,
    chiStatus:           'generating',
    message:             'Quick start saved. Your Career Health score is being calculated — it will be ready in a few seconds.',
  };

  logger.info('[Onboarding] saveQuickStart complete', { userId, chiStatus: 'generating' });
  return quickStartResult;
}

async function saveEducationAndExperience(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  logger.info('[Onboarding] saveEducationAndExperience start', { userId });

  const {
    education = [],
    experience = [],
    skills = [],
    // SPRINT-1 C1: replaced free-text targetRole with validated targetRoleId + required expectedRoleIds[].
    // The old targetRole string was used directly as a doc ID in the salary band lookup,
    // so "Senior Product Manager" never matched the doc ID "senior_product_manager" — silently
    // breaking salaryTrajectory (15% of CHI) and marketAlignment (25% of CHI) for every user.
    // targetRoleId is now validated against the roles collection. expectedRoleIds is now required.
    targetRoleId      = null,
    expectedRoleIds   = [],
    careerGaps = [],
    currentSalaryLPA  = null,   // CHI salaryTrajectory signal
    expectedSalaryLPA = null,   // CHI salaryTrajectory signal
    // SPRINT-1 C5: self-declared seniority for CHI peerComparison accuracy.
    selfDeclaredSeniority = null,
    // SPRINT-2 C6: preferred work location for CHI region inference.
    preferredWorkLocation = null,
    workMode              = null,  // remote | hybrid | onsite
  } = payload;

  if (!education.length && !experience.length) {
    throw new AppError(
      'Please provide at least one education or experience entry.',
      400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please add at least one job or education entry to continue.'
    );
  }

  // ── SPRINT-1 C1: Validate targetRoleId against the roles collection ─────────
  if (targetRoleId !== null) {
    if (typeof targetRoleId !== 'string' || !targetRoleId.trim()) {
      throw new AppError('targetRoleId must be a non-empty string.', 400, {}, ErrorCodes.VALIDATION_ERROR,
        'The selected target role appears to be invalid. Please choose a role from the list.');
    }
    await validateRolesExist([targetRoleId.trim()]);
  }

  // ── SPRINT-1 C1: Validate expectedRoleIds[] ──────────────────────────────────
  if (!Array.isArray(expectedRoleIds) || expectedRoleIds.length === 0) {
    throw new AppError(
      'Please select at least one target role. This is required for an accurate Career Health score.',
      400,
      { hint: 'Provide expectedRoleIds[] with at least one valid roleId from the /roles endpoint.' },
      ErrorCodes.VALIDATION_ERROR,
      'Please select at least one role you\'re targeting — this is how we personalise your Career Health score.'
    );
  }
  await validateRolesExist(expectedRoleIds.map(id => String(id).trim()));

  // ── P1-02 / P1-03: Salary — now fully optional ───────────────────────────
  const salaryDeclined = payload.salaryDeclined === true;

  if (salaryDeclined) {
    // User explicitly declined — CHI will use market estimation for salaryTrajectory
  } else if (currentSalaryLPA === -1) {
    // Legacy sentinel still accepted for backwards compatibility with existing clients
  } else if (currentSalaryLPA !== null && currentSalaryLPA !== undefined) {
    if (typeof currentSalaryLPA !== 'number' || currentSalaryLPA < 0) {
      throw new AppError(
        'currentSalaryLPA must be a positive number, or omit it if you prefer not to disclose.',
        400, {}, ErrorCodes.VALIDATION_ERROR,
        'Please enter a valid salary amount, or leave it blank to skip.'
      );
    }
  }

  if (expectedSalaryLPA !== null && expectedSalaryLPA !== undefined && expectedSalaryLPA !== -1 &&
      (typeof expectedSalaryLPA !== 'number' || expectedSalaryLPA < 0)) {
    throw new AppError(
      'expectedSalaryLPA must be a positive number, or omit it.',
      400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please enter a valid expected salary amount, or leave it blank.'
    );
  }

  // ── SPRINT-1 C5: Validate selfDeclaredSeniority ───────────────────────────────
  if (selfDeclaredSeniority !== null) {
    if (!VALID_SENIORITY.has(selfDeclaredSeniority)) {
      throw new AppError(
        `selfDeclaredSeniority must be one of: ${[...VALID_SENIORITY].join(', ')}.`,
        400,
        { received: selfDeclaredSeniority },
        ErrorCodes.VALIDATION_ERROR,
        `Please select a valid seniority level: ${[...VALID_SENIORITY].join(', ')}.`
      );
    }
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
      throw new AppError(`${label}: either qualificationId or qualificationName is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR,
        `Education entry ${i + 1}: please enter your degree or qualification name.`);
    }

    if (!String(edu.institution || '').trim()) throw new AppError(`${label}: institution is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR,
      `Education entry ${i + 1}: please enter the name of your university, college, or institution.`);
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
      // SPRINT-2 H3: degree grade/classification — required by UK (2:1, First), US (GPA≥3.5), India (CGPA).
      gradeType:  ['gpa', 'percentage', 'classification', 'cgpa'].includes(edu.gradeType) ? edu.gradeType : null,
      gradeValue: edu.gradeValue ? stripHtml(String(edu.gradeValue)).trim().slice(0, 30) : null,
    });
  }

  // ── Validate experience ────────────────────────────────────────────────────
  for (let i = 0; i < experience.length; i++) {
    if (!experience[i].jobTitle || !experience[i].company) throw new AppError(
      `Experience entry ${i + 1}: jobTitle and company are required.`,
      400, { index: i }, ErrorCodes.VALIDATION_ERROR,
      `Experience entry ${i + 1}: please enter both a job title and a company name.`
    );
  }
  validateExperienceDates(experience);

  // GAP-06: compute total months from validated date ranges
  const totalExperienceMonths = computeExperienceMonths(experience);

  const sanitisedExperience = experience.map((e, i) => {
    const label = `Experience entry ${i + 1} (${e.jobTitle} at ${e.company})`;
    // GAP-07: normalise industry to controlled enum; preserve raw text as industryText
    const industryId   = INDUSTRY_SECTORS[e.industryId] ? e.industryId : (e.industryId ? 'other' : null);
    const industryText = e.industryText || e.industry || null;

    // SPRINT-2 C4: jobFunction controlled enum
    const VALID_JOB_FUNCTIONS = new Set([
      'engineering', 'product', 'design', 'data', 'sales', 'marketing',
      'finance', 'operations', 'hr', 'legal', 'customer_success', 'other',
    ]);
    const jobFunction = VALID_JOB_FUNCTIONS.has(e.jobFunction) ? e.jobFunction : (e.jobFunction ? 'other' : null);

    // SPRINT-2 C7: experienceType
    const experienceType = VALID_EXPERIENCE_TYPES.has(e.experienceType) ? e.experienceType : 'full_time';

    return {
      jobTitle:         stripHtml(e.jobTitle || ''),
      company:          stripHtml(e.company  || ''),
      industryId,
      industryText,
      jobFunction,
      experienceType,
      startDate:        e.startDate  || null,
      endDate:          e.endDate    || null,
      isCurrent:        e.isCurrent  || false,
      responsibilities: validateAndSanitiseResponsibilities(e.responsibilities, label),
      achievements:     validateAchievements(e.achievements, label),
    };
  });

  // SPRINT-2 C2: derive impactScore from structured achievements (0–5 count)
  const impactScore = sanitisedExperience.reduce(
    (sum, e) => sum + (e.achievements?.length || 0), 0
  );

  // ── Validate careerGaps (GAP C4) ──────────────────────────────────────────
  const VALID_GAP_REASONS = new Set(['education', 'personal', 'health', 'relocation', 'other']);
  const sanitisedCareerGaps = (Array.isArray(careerGaps) ? careerGaps : []).map((gap, i) => {
    if (!gap.startDate || !gap.endDate) throw new AppError(`careerGaps[${i}]: startDate and endDate are required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR,
      `Career gap ${i + 1}: please enter both a start date and an end date.`);
    if (gap.startDate >= gap.endDate) throw new AppError(`careerGaps[${i}]: endDate must be after startDate.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR,
      `Career gap ${i + 1}: the end date must be after the start date.`);
    return {
      startDate:   gap.startDate,
      endDate:     gap.endDate,
      reason:      VALID_GAP_REASONS.has(gap.reason) ? gap.reason : 'other',
      description: gap.description ? stripHtml(String(gap.description)).slice(0, 600) : null,
    };
  });

  // ── Validate skills (GAP S1) ──────────────────────────────────────────────
  const VALID_PROF = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
  const sanitisedSkills = (Array.isArray(skills) ? skills : []).map((s, i) => {
    const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
    if (!name) throw new AppError(`skills[${i}]: name is required.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR,
      `Skill #${i + 1} is missing a name. Please enter a skill name or remove it.`);
    return { name, proficiency: VALID_PROF.has(s?.proficiency) ? s.proficiency : 'intermediate' };
  });

  const nowISO = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'education_experience_saved');

  const doc = {
    id:         userId,
    userId,
    step:       'education_experience_saved',
    education:  resolvedEducation,
    experience: sanitisedExperience,
    skills:     sanitisedSkills,
    targetRoleId:     targetRoleId ? targetRoleId.trim() : null,
    expectedRoleIds:  expectedRoleIds.map(id => String(id).trim()),
    careerGaps: sanitisedCareerGaps,
    totalExperienceMonths,
    currentSalaryLPA:     currentSalaryLPA  ?? null,
    expectedSalaryLPA:    expectedSalaryLPA ?? null,
    salaryDeclined:       salaryDeclined,
    selfDeclaredSeniority: selfDeclaredSeniority ?? null,
    impactScore,
    preferredWorkLocation: preferredWorkLocation ? String(preferredWorkLocation).trim().slice(0, 100) : null,
    workMode:              ['remote', 'hybrid', 'onsite'].includes(workMode) ? workMode : null,
    stepHistory,
    // SPRINT-4A H12: track last active step for drop-off cohort analysis
    lastActiveStep: 'education_experience_saved',
    lastActiveAt:   nowISO,
    onboardingStartedAt: nowISO,
    updatedAt:   nowISO,
  };

  const { error: progressErr } = await supabase.from('onboardingProgress').upsert(doc);
  if (progressErr) {
    logger.error('[DB] onboardingProgress.upsert failed', { userId, error: progressErr.message });
    throw progressErr;
  }

  // G-02: Derive dominant industry from experience array and mirror to userProfiles.
  const industryCounts = {};
  for (const exp of sanitisedExperience) {
    if (exp.industryId) industryCounts[exp.industryId] = (industryCounts[exp.industryId] || 0) + 1;
  }
  const dominantIndustryId = Object.keys(industryCounts).length > 0
    ? Object.keys(industryCounts).reduce((a, b) => industryCounts[a] >= industryCounts[b] ? a : b)
    : null;
  const dominantIndustryText = dominantIndustryId ? (INDUSTRY_SECTORS[dominantIndustryId] || null) : null;

  // SPRINT-2 C4: Derive dominant jobFunction
  const fnCounts = {};
  for (const exp of sanitisedExperience) {
    if (exp.jobFunction) fnCounts[exp.jobFunction] = (fnCounts[exp.jobFunction] || 0) + 1;
  }
  const dominantJobFunction = Object.keys(fnCounts).length > 0
    ? Object.keys(fnCounts).reduce((a, b) => fnCounts[a] >= fnCounts[b] ? a : b)
    : null;

  // Mirror skills + salary + industry + Sprint-1 fields to userProfiles
  const { error: profileErr } = await supabase.from('userProfiles').upsert({
    id:                    userId,
    skills:                sanitisedSkills.length > 0 ? sanitisedSkills : undefined,
    currentSalaryLPA:      currentSalaryLPA  ?? null,
    expectedSalaryLPA:     expectedSalaryLPA ?? null,
    industryId:            dominantIndustryId   ?? null,
    industryText:          dominantIndustryText  ?? null,
    jobFunction:           dominantJobFunction   ?? null,
    preferredWorkLocation: preferredWorkLocation ? String(preferredWorkLocation).trim().slice(0, 100) : null,
    workMode:              ['remote', 'hybrid', 'onsite'].includes(workMode) ? workMode : null,
    targetRoleId:          targetRoleId ? targetRoleId.trim() : null,
    expectedRoleIds:       expectedRoleIds.map(id => String(id).trim()),
    selfDeclaredSeniority: selfDeclaredSeniority ?? null,
    updatedAt:             nowISO,
  });
  if (profileErr) {
    logger.error('[DB] userProfiles.upsert failed', { userId, error: profileErr.message });
  }

  const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);
  await persistCompletionIfReady(userId, progressRow || {}, profileRow || {});
  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'education_experience_saved', trackA: true });

  logger.info('[Onboarding] saveEducationAndExperience complete', { userId });
  return { userId, step: 'education_experience_saved', message: 'Education and experience saved. Ready to generate your career report.' };
}

async function saveDraft(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  logger.debug('[Onboarding] saveDraft start', { userId });

  // P3-03: Optimistic concurrency — if client sends draftVersion, reject if it doesn't match.
  const clientVersion = payload._draftVersion !== undefined ? Number(payload._draftVersion) : null;
  const { _draftVersion, ...cleanPayload } = payload;

  if (clientVersion !== null) {
    const { data: existing, error: existErr } = await supabase
      .from('onboardingProgress')
      .select('draftVersion')
      .eq('id', userId)
      .maybeSingle();
    if (existErr && existErr.code !== 'PGRST116') {
      logger.error('[DB] onboardingProgress.get:', existErr.message);
    }
    if (existing) {
      // P3-03: treat missing draftVersion as 0 (first save on an existing doc)
      const serverVersion = existing.draftVersion ?? 0;
      if (serverVersion !== clientVersion) {
        throw new AppError(
          `Draft version conflict: server is at v${serverVersion}, client sent v${clientVersion}.`,
          409,
          { serverVersion, clientVersion },
          ErrorCodes.CONFLICT ?? 'CONFLICT',
          'Your draft was updated elsewhere. Please refresh to get the latest version before saving.'
        );
      }
    }
  }

  // Increment version on every successful save
  const newVersion = (clientVersion ?? 0) + 1;
  const nowISO = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'draft_saved');

  const { error: upsertErr } = await supabase.from('onboardingProgress').upsert({
    id:           userId,
    userId,
    step:         'draft',
    draft:        cleanPayload,
    draftVersion: newVersion,
    draftSavedAt: nowISO,
    lastActiveStep: 'draft',
    lastActiveAt:   nowISO,
    stepHistory,
    onboardingStartedAt: nowISO,
    updatedAt:    nowISO,
  });
  if (upsertErr) {
    logger.error('[DB] onboardingProgress.upsert (draft) failed', { userId, error: upsertErr.message });
    throw upsertErr;
  }

  scheduleReengagementJob(userId);

  logger.debug('[Onboarding] saveDraft complete', { userId, draftVersion: newVersion });
  return { userId, step: 'draft', draftVersion: newVersion, message: 'Draft saved. You can return to continue.' };
}

async function getDraft(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const { data, error } = await supabase
    .from('onboardingProgress')
    .select('draft, draftVersion, draftSavedAt')
    .eq('id', userId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') {
    logger.error('[DB] onboardingProgress.get (draft):', error.message);
  }

  if (!data || !data.draft) {
    return { userId, draft: null, draftVersion: 0, draftSavedAt: null };
  }

  return {
    userId,
    draft:        data.draft,
    draftVersion: data.draftVersion ?? 0,
    draftSavedAt: data.draftSavedAt ?? null,
  };
}

async function savePersonalDetails(userId, payload, authEmail = null) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  logger.info('[Onboarding] savePersonalDetails start', { userId });

  const { fullName, email, phone, city, country, skills = [], workAuthorisation, linkedInUrl, portfolioUrl,
          languages, projects, awards,
          profilePhotoUrl,       // PROMPT-4: profile photo for Gulf/Europe/Asia CV markets
          professionalSummary,   // SPRINT-2 H2: user-edited summary — passed verbatim to CV generation
        } = payload;

  if (!fullName || !email) throw new AppError(
    'Full name and email are required to generate a CV.',
    400, {}, ErrorCodes.VALIDATION_ERROR,
    'Please enter your full name and email address before generating your CV.'
  );

  // SPRINT-4A H5: Duplicate email / account-split detection.
  if (authEmail) {
    const submittedEmail = String(email).trim().toLowerCase();
    const tokenEmail     = String(authEmail).trim().toLowerCase();
    if (submittedEmail !== tokenEmail) {
      logger.warn('[OnboardingService] H5: Email mismatch — submitted email differs from auth token', {
        userId,
        submittedEmail,
        tokenEmail,
        submittedDomain: submittedEmail.split('@')[1] || 'unknown',
        tokenDomain:     tokenEmail.split('@')[1]     || 'unknown',
      });
      // Write a non-blocking audit flag for ops visibility (fire-and-forget — do not delay the save)
      supabase.from('onboardingProgress').upsert({
        id:     userId,
        emailMismatchDetectedAt: new Date().toISOString(),
        emailMismatchNote: 'Submitted email differs from auth email — possible duplicate account risk.',
      }).then(({ error }) => {
        if (error) logger.warn('[OnboardingService] H5: Failed to write emailMismatch flag (non-fatal)', { userId, error: error.message });
      });
    }
  }

  const VALID_WORK_AUTH = new Set(['citizen', 'permanent_resident', 'work_permit', 'require_sponsorship']);

  // SPRINT-2 C8: E.164-compatible phone validation.
  function validatePhone(rawPhone) {
    if (!rawPhone) return null;
    const cleaned = String(rawPhone).replace(/[\s\-().+]/g, '');
    if (!/^\d{7,15}$/.test(cleaned)) {
      throw new AppError(
        'Phone must be a valid number (7–15 digits). ' +
        'Accepted formats: +971501234567 or 07911123456.',
        400,
        { received: rawPhone },
        ErrorCodes.VALIDATION_ERROR
      );
    }
    return String(rawPhone).trim();
  }

  const personalDetails = {
    fullName:          String(fullName).trim(),
    email:             String(email).trim().toLowerCase(),
    phone:             validatePhone(phone),
    city:              city    || null,
    country:           country || null,
    skills:            Array.isArray(skills) ? skills : [],
    workAuthorisation: VALID_WORK_AUTH.has(workAuthorisation) ? workAuthorisation : null,
    linkedInUrl:       validateUrl(linkedInUrl,  'linkedInUrl'),
    portfolioUrl:      validateUrl(portfolioUrl, 'portfolioUrl'),
    profilePhotoUrl:   validateUrl(profilePhotoUrl, 'profilePhotoUrl'),
    languages: Array.isArray(languages) ? languages.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim()) : [],
    projects:  Array.isArray(projects)  ? projects.filter(p => p?.title) : [],
    // GAP-M7: structured award objects { title, issuer, year } replace plain strings.
    awards: Array.isArray(awards)
      ? awards
          .map(a => {
            if (!a) return null;
            if (typeof a === 'string') {
              const t = a.trim();
              return t ? { title: t, issuer: null, year: null } : null;
            }
            const title = stripHtml(String(a.title || '')).trim();
            if (!title) return null;
            const year = a.year ? parseInt(a.year, 10) : null;
            return {
              title,
              issuer: a.issuer ? stripHtml(String(a.issuer)).trim().slice(0, 100) : null,
              year:   year && year >= 1950 && year <= new Date().getFullYear() ? year : null,
            };
          })
          .filter(Boolean)
      : [],
    // SPRINT-2 H2: user-approved professional summary
    professionalSummary: professionalSummary
      ? stripHtml(String(professionalSummary)).trim().slice(0, 800)
      : null,
  };

  const nowISO = new Date().toISOString();
  const stepHistory = await mergeStepHistory(userId, 'personal_details_saved');

  const { error: upsertErr } = await supabase.from('onboardingProgress').upsert({
    id:             userId,
    step:           'personal_details_saved',
    wantsCv:        true,
    personalDetails,
    stepHistory,
    // SPRINT-4A H12: track last active step for drop-off cohort analysis
    lastActiveStep: 'personal_details_saved',
    lastActiveAt:   nowISO,
    updatedAt:      nowISO,
  });
  if (upsertErr) {
    logger.error('[DB] onboardingProgress.upsert (personalDetails) failed', { userId, error: upsertErr.message });
    throw upsertErr;
  }

  // GAP C2: store country for region inference
  if (country) {
    const { error: profileErr } = await supabase.from('userProfiles').upsert({
      id:             userId,
      currentCountry: country,
      updatedAt:      nowISO,
    });
    if (profileErr) {
      logger.warn('[DB] userProfiles.upsert (country) failed', { userId, error: profileErr.message });
    }
  }

  logger.info('[Onboarding] savePersonalDetails complete', { userId });
  return { userId, step: 'personal_details_saved', message: 'Personal details saved. Ready to generate your CV.' };
}

async function saveCareerIntent(userId, payload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  logger.info('[Onboarding] saveCareerIntent start', { userId });

  const { careerHistory, expectedRoleIds, currentCity, currentSalaryLPA, expectedSalaryLPA, jobSearchTimeline, skills,
          noticePeriodDays, workMode, availableFrom } = payload;

  // GAP-09: careerHistory is now optional — allows a lightweight Step 0 call with just
  // expectedRoleIds + optional salary/city, before the full Track B form is completed.
  if (!expectedRoleIds?.length) {
    throw new AppError('expectedRoleIds is required.', 400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please select at least one target role to save your career intent.');
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

      // SPRINT-3 H4: optional startDate/endDate for gap detection in careerMomentum scoring.
      const datePattern = /^\d{4}-(0[1-9]|1[0-2])$/;
      if (entry.startDate && !datePattern.test(entry.startDate)) {
        throw new AppError(`careerHistory[${i}]: startDate must be YYYY-MM format.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
      }
      if (entry.endDate && !datePattern.test(entry.endDate)) {
        throw new AppError(`careerHistory[${i}]: endDate must be YYYY-MM format.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
      }
      if (entry.startDate && entry.endDate && entry.endDate < entry.startDate) {
        throw new AppError(`careerHistory[${i}]: endDate "${entry.endDate}" cannot be before startDate "${entry.startDate}".`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
      }
      if (entry.isCurrent && entry.endDate) {
        throw new AppError(`careerHistory[${i}]: cannot have both isCurrent=true and endDate.`, 400, { index: i }, ErrorCodes.VALIDATION_ERROR);
      }
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

  const nowISO = new Date().toISOString();

  const profileUpdate = {
    id:              userId,
    expectedRoleIds: expectedRoleIds.map(id => String(id).trim()).filter(Boolean),
    updatedAt:       nowISO,
  };

  // GAP-09: only write careerHistory when provided (mini Step 0 omits it)
  if (Array.isArray(careerHistory) && careerHistory.length > 0) {
    profileUpdate.careerHistory = careerHistory.map(r => ({
      roleId:         r.roleId.trim(),
      durationMonths: r.durationMonths,
      description:    r.description || null,
      isCurrent:      r.isCurrent   || false,
      startDate:      r.startDate   || null,
      endDate:        r.endDate     || null,
    }));
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

  const stepHistory = await mergeStepHistory(userId, 'career_intent_saved');

  await Promise.all([
    supabase.from('userProfiles').upsert(profileUpdate),
    supabase.from('onboardingProgress').upsert({
      id:             userId,
      step:           'career_intent_saved',
      stepHistory,
      // SPRINT-4A H12: track last active step for drop-off cohort analysis
      lastActiveStep: 'career_intent_saved',
      lastActiveAt:   nowISO,
      updatedAt:      nowISO,
    }),
  ]);

  const [{ data: progressRow }, { data: profileRow }] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);
  await persistCompletionIfReady(userId, progressRow || {}, profileRow || {});
  emitOnboardingEvent(userId, 'onboarding_step_completed', { step: 'career_intent_saved', trackB: true });

  // GAP S6: log role cross-reference (non-blocking)
  const expTitles = (progressRow?.experience || []).map(e => e.jobTitle).filter(Boolean);
  if (expTitles.length && profileUpdate.expectedRoleIds.length) {
    logger.debug('[OnboardingService] Role cross-reference', { userId, experienceTitles: expTitles, expectedRoleIds: profileUpdate.expectedRoleIds });
  }

  logger.info('[Onboarding] saveCareerIntent complete', { userId, expectedRoleIds: payload.expectedRoleIds });
  return { userId, step: 'career_intent_saved', message: 'Career intent saved.' };
}

module.exports = {
  saveConsent,
  saveQuickStart,
  saveEducationAndExperience,
  saveDraft,
  getDraft,
  savePersonalDetails,
  saveCareerIntent,
};