'use strict';

/**
 * onboarding.linkedin.service.js — B-01 FIX: LinkedIn import sub-service
 *
 * Extracted from onboarding.service.js (god-object decomposition).
 * Owns: importLinkedIn, confirmLinkedInImport
 */

const { db } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { FieldValue } = require('../../config/supabase');
const logger          = require('../../utils/logger');
const { validateRolesExist } = require('../roles/roles.service');
const {
  sanitiseInput, validateUrl, validateYearOfGraduation,
  validateAndSanitiseResponsibilities, validateAchievements,
  validateExperienceDates, computeExperienceMonths,
  emitOnboardingEvent, appendStepHistory, mergeSkills,
  mergeCanonicalSkills, persistCompletionIfReady,
  VALID_SENIORITY, EXPERIENCE_TYPE_WEIGHTS, VALID_EXPERIENCE_TYPES,
} = require('./onboarding.helpers');

async function importLinkedIn(userId, linkedInPayload) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  if (!linkedInPayload || typeof linkedInPayload !== 'object') {
    throw new AppError('LinkedIn profile payload must be a JSON object.', 400, {}, ErrorCodes.VALIDATION_ERROR,
      'Please upload a valid LinkedIn data export. Go to LinkedIn Settings → Data Privacy → Get a copy of your data.');
  }

  // P3-01: Validate payload contains at least one recognisable LinkedIn section.
  // Without this check, an arbitrary JSON object (e.g. a resume parser output or Jira export)
  // would be silently accepted and produce an empty importedProfile — confusing the user.
  // We accept both the LinkedIn export format (capitalised keys) and API format (camelCase).
  const hasEducation  = Array.isArray(linkedInPayload.Education  || linkedInPayload.education)  && (linkedInPayload.Education  || linkedInPayload.education).length  > 0;
  const hasPositions  = Array.isArray(linkedInPayload.Positions  || linkedInPayload.positions  || linkedInPayload.Experience || linkedInPayload.experience) &&
                        (linkedInPayload.Positions || linkedInPayload.positions || linkedInPayload.Experience || linkedInPayload.experience).length > 0;
  const hasSkills     = Array.isArray(linkedInPayload.Skills     || linkedInPayload.skills)     && (linkedInPayload.Skills     || linkedInPayload.skills).length     > 0;

  if (!hasEducation && !hasPositions && !hasSkills) {
    throw new AppError(
      'LinkedIn payload does not contain recognisable Education, Positions, or Skills sections.',
      422,
      { hint: 'Expected keys: Education[], Positions[], Skills[] (LinkedIn export) or education[], positions[], skills[] (API format).' },
      ErrorCodes.VALIDATION_ERROR,
      'This doesn\'t look like a LinkedIn export. Please download your LinkedIn data from Settings → Data Privacy → Get a copy of your data, then upload the JSON file.'
    );
  }

  // ── Map education ─────────────────────────────────────────────────────────
  // LinkedIn export structure: Education[] { school_name, degree_name, field_of_study, start_date, end_date }
  // Alternative API structure: education[] { schoolName, degreeName, fieldOfStudy, timePeriod }
  const rawEducation = linkedInPayload.Education || linkedInPayload.education || [];
  const mappedEducation = rawEducation.map((e, i) => {
    const school = e.school_name || e.schoolName || e.school || '';
    const degree = e.degree_name || e.degreeName || e.degree || '';
    const field  = e.field_of_study || e.fieldOfStudy || e.field || '';

    // Extract graduation year from end_date (YYYY-MM or YYYY or { year: YYYY })
    let gradYear = null;
    const rawEnd = e.end_date || e.endDate || e.timePeriod?.endDate;
    if (rawEnd) {
      const parsed = parseInt(String(rawEnd?.year || rawEnd).split('-')[0], 10);
      if (!isNaN(parsed) && parsed >= 1950 && parsed <= new Date().getFullYear() + 6) gradYear = parsed;
    }

    if (!school) return null; // skip malformed entries
    return {
      qualificationName: degree || 'Degree',
      institution:       school,
      yearOfGraduation:  gradYear,
      specialization:    field || null,
      certifications:    [],
      _source:           'linkedin_import',
      _importIndex:      i,
    };
  }).filter(Boolean);

  // ── Map experience ─────────────────────────────────────────────────────────
  // LinkedIn export: Positions[] { company_name, title, description, started_on, finished_on }
  // LinkedIn API:    positions[]  { companyName, title, description, timePeriod }
  const rawPositions = linkedInPayload.Positions || linkedInPayload.positions
    || linkedInPayload.Experience || linkedInPayload.experience || [];

  const mappedExperience = rawPositions.map((p, i) => {
    const company   = p.company_name || p.companyName || p.company || '';
    const title     = p.title || p.jobTitle || '';
    const desc      = p.description || '';
    const isCurrent = p.isCurrent || !p.finished_on && !p.endDate && !p.timePeriod?.endDate;

    // Parse YYYY-MM start/end from various LinkedIn date shapes
    function toYYYYMM(raw) {
      if (!raw) return null;
      // { year: 2021, month: 6 }
      if (typeof raw === 'object' && raw.year) {
        const m = String(raw.month || 1).padStart(2, '0');
        return `${raw.year}-${m}`;
      }
      // "2021-06" or "2021-06-01"
      const match = String(raw).match(/^(\d{4})-(\d{2})/);
      return match ? `${match[1]}-${match[2]}` : null;
    }

    const startRaw = p.started_on || p.startDate || p.timePeriod?.startDate;
    const endRaw   = p.finished_on || p.endDate   || p.timePeriod?.endDate;

    const startDate = toYYYYMM(startRaw);
    const endDate   = isCurrent ? null : toYYYYMM(endRaw);

    // Convert LinkedIn description into a responsibilities array (split on newlines / bullet chars)
    const responsibilities = desc
      ? desc.split(/\n|•|·/).map(r => r.trim()).filter(r => r.length >= 10).slice(0, 10)
      : [];

    if (!company && !title) return null;
    return {
      jobTitle:         title   || 'Role',
      company:          company || 'Company',
      industryText:     p.industry || null,
      industryId:       null, // user must confirm — we don't guess the enum from raw text
      jobFunction:      null, // same — requires user confirmation
      experienceType:   'full_time', // default; user can change in Step 1
      startDate,
      endDate,
      isCurrent,
      responsibilities,
      achievements:     [], // user must add structured achievements
      _source:          'linkedin_import',
      _importIndex:     i,
    };
  }).filter(Boolean);

  // ── Map skills ────────────────────────────────────────────────────────────
  // LinkedIn export: Skills[] { name } or { skill_name }
  const rawSkills = linkedInPayload.Skills || linkedInPayload.skills || [];
  const mappedSkills = rawSkills.map(s => {
    const name = (typeof s === 'string' ? s : s.name || s.skill_name || '').trim();
    return name ? { name, proficiency: 'intermediate', _source: 'linkedin_import' } : null;
  }).filter(Boolean).slice(0, 50); // cap at 50 to avoid bloat

  // ── Persist to onboardingProgress as importedProfile (not yet confirmed) ──
  // Stored separately so it never overwrites an existing draft.
  // The frontend reads importedProfile to pre-populate Step 1 fields,
  // then sends the full confirmed payload to POST /education-experience.
  const importSummary = {
    educationCount:  mappedEducation.length,
    experienceCount: mappedExperience.length,
    skillsCount:     mappedSkills.length,
    importedAt:      new Date().toISOString(),
  };

  await db.collection('onboardingProgress').doc(userId).set({
    importedProfile: {
      education:  mappedEducation,
      experience: mappedExperience,
      skills:     mappedSkills,
      ...importSummary,
    },
    importSource:   'linkedin',   // P3-09: track whether profile was seeded from LinkedIn or manual entry
    lastActiveStep: 'linkedin_imported',
    lastActiveAt:   FieldValue.serverTimestamp(),
    updatedAt:      FieldValue.serverTimestamp(),
  }, { merge: true });

  logger.info('[OnboardingService] LinkedIn profile imported', { userId, ...importSummary });

  return {
    userId,
    step:    'linkedin_imported',
    message: 'LinkedIn profile imported. Review the pre-populated fields and complete your profile.',
    imported: importSummary,
    // Return the mapped data so the frontend can pre-populate Step 1 without a second read
    profile: {
      education:  mappedEducation,
      experience: mappedExperience,
      skills:     mappedSkills,
    },
  };
}

async function confirmLinkedInImport(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [progressSnap, profileSnap] = await Promise.all([
    db.collection('onboardingProgress').doc(userId).get(),
    db.collection('userProfiles').doc(userId).get(),
  ]);

  if (!progressSnap.exists) {
    throw new AppError(
      'No onboarding data found. Please import your LinkedIn profile first.',
      404, { userId }, ErrorCodes.NOT_FOUND,
      'We couldn\'t find your imported LinkedIn data. Please try importing your profile again.'
    );
  }

  const progress = progressSnap.data();
  const profile  = profileSnap.data() || {};

  if (!progress.importedProfile) {
    throw new AppError(
      'No LinkedIn import found to confirm. Please import your LinkedIn profile first.',
      422, { userId }, ErrorCodes.VALIDATION_ERROR,
      'No LinkedIn import found. Please use the "Import from LinkedIn" button first.'
    );
  }

  const { education, experience, skills } = progress.importedProfile;

  // Build the confirmed payload — strip _source and _importIndex meta fields
  const cleanEducation = (education || []).map(e => {
    const { _source, _importIndex, ...clean } = e;
    return clean;
  });
  const cleanExperience = (experience || []).map(e => {
    const { _source, _importIndex, ...clean } = e;
    return clean;
  });
  const cleanSkills = (skills || []).map(s => {
    const { _source, ...clean } = s;
    return clean;
  });

  // Promote to main fields — merge with any manually-entered data
  // Strategy: LinkedIn data wins for fields it provides, existing manual data kept for others
  const mergedEducation  = cleanEducation.length  > 0 ? cleanEducation  : (progress.education  || []);
  const mergedExperience = cleanExperience.length > 0 ? cleanExperience : (progress.experience || []);
  const mergedSkills     = cleanSkills.length     > 0 ? cleanSkills     : (profile.skills || []);

  // Also extract expectedRoleIds from experience if not already set
  const existingRoleIds = profile.expectedRoleIds || [];

  const batch = db.batch();

  // Write promoted data to onboardingProgress
  batch.set(db.collection('onboardingProgress').doc(userId), {
    education:      mergedEducation,
    experience:     mergedExperience,
    importSource:   'linkedin',        // P3-09: confirm importSource
    importConfirmedAt: new Date().toISOString(),
    step:           'linkedin_confirmed',
    quickStartCompleted: true,         // LinkedIn import counts as quick start
    lastActiveStep: 'linkedin_confirmed',
    lastActiveAt:   FieldValue.serverTimestamp(),
    ...appendStepHistory('linkedin_confirmed'),
    updatedAt:      FieldValue.serverTimestamp(),
  }, { merge: true });

  // Write promoted skills + experience to userProfiles
  batch.set(db.collection('userProfiles').doc(userId), {
    skills:     mergedSkills,
    // Derive totalExperienceYears from imported experience
    totalExperienceYears: _estimateExperienceYears(mergedExperience),
    updatedAt:  FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();

  // Trigger provisional CHI with the confirmed LinkedIn data (no career report yet)
  // calculateProvisionalChi hoisted to top-level (C-09)
  const updatedProgressSnap = await db.collection('onboardingProgress').doc(userId).get();
  const updatedProfileSnap  = await db.collection('userProfiles').doc(userId).get();
  triggerProvisionalChi(
    userId,
    updatedProgressSnap.data() || {},
    updatedProfileSnap.data()  || {},
    null,   // no career report yet
    'free'  // tier — will be overridden once career report runs
  );

  return {
    userId,
    step:            'linkedin_confirmed',
    educationCount:  mergedEducation.length,
    experienceCount: mergedExperience.length,
    skillsCount:     mergedSkills.length,
    quickStartCompleted: true,
    message:         'LinkedIn profile confirmed. Your provisional Career Health score is generating.',
  };
}

module.exports = {
  importLinkedIn,
  confirmLinkedInImport,
};









