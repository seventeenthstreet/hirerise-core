'use strict';

/**
 * @file shared/hirerise-resume.schema.js
 *
 * HireRise Resume Schema — v1
 *
 * This is the single source of truth for the parsed resume structure
 * used across backend (normalization, scoring) and frontend (onboarding UI).
 *
 * IMPORTANT: This module is infrastructure-agnostic. No Supabase, no Express.
 * It can be required in any Node.js service or bundled into the frontend.
 */

// ─── Schema Constants ─────────────────────────────────────────────────────────

const EXPERIENCE_TYPES = Object.freeze({
  JOB:        'job',
  INTERNSHIP: 'internship',
  PROJECT:    'project',
});

const SCHEMA_VERSION = '1.0.0';

// ─── Empty/default Resume ─────────────────────────────────────────────────────

/**
 * Returns a safe, fully-typed empty Resume object.
 * Use as the base before merging parsed fields.
 *
 * @param {string} resumeId
 * @param {string} userId
 * @returns {HireRiseResume}
 */
function emptyResume(resumeId = '', userId = '') {
  return {
    id:     resumeId,
    userId: userId,

    core: {
      fullName: '',
      email:    null,
      phone:    null,
      location: null,
      title:    null,
      summary:  null,
    },

    experience: [],
    education:  [],
    skills:     [],

    additionalSections: [],

    metadata: {
      parsingConfidence:  0,
      completenessScore:  0,
      missingFields:      [],
      detectedDomain:     null,
      schemaVersion:      SCHEMA_VERSION,
      parsedAt:           new Date().toISOString(),
    },
  };
}

// ─── Metadata Computation ─────────────────────────────────────────────────────

/**
 * Computes missingFields[] and completenessScore (0–100) from a Resume object.
 * The scoring is intentionally lenient — partial profiles still show progress.
 *
 * @param {HireRiseResume} resume
 * @returns {{ missingFields: string[], completenessScore: number }}
 */
function computeMetadata(resume) {
  const missing = [];
  let score = 0;

  // Core fields
  if (resume.core.fullName?.trim()) { score += 15; }
  else                              { missing.push('fullName'); }

  if (resume.core.email?.trim())    { score += 15; }
  else                              { missing.push('email'); }

  if (resume.core.phone?.trim())    { score += 8; }
  else                              { missing.push('phone'); }

  if (resume.core.location?.trim()) { score += 5; }
  else                              { missing.push('location'); }

  if (resume.core.summary?.trim())  { score += 10; }
  else                              { missing.push('summary'); }

  if (resume.core.title?.trim())    { score += 5; }
  else                              { missing.push('title'); }

  // Skills
  if (resume.skills.length >= 5)    { score += 15; }
  else if (resume.skills.length > 0) { score += 7; missing.push('moreSkills'); }
  else                              { missing.push('skills'); }

  // Experience
  if (resume.experience.length >= 2) { score += 15; }
  else if (resume.experience.length === 1) { score += 8; }
  else                              { missing.push('experience'); }

  // Education
  if (resume.education.length > 0)  { score += 7; }
  else                              { missing.push('education'); }

  // Additional sections bonus
  if (resume.additionalSections.length > 0) { score += 5; }

  return {
    missingFields:     missing,
    completenessScore: Math.min(100, Math.round(score)),
  };
}

// ─── Safe Accessor Helpers ────────────────────────────────────────────────────

/**
 * Null-safe read from a Resume object.
 * Prevents crashes when parsedData arrives with missing fields.
 */
const safe = {
  fullName:   (r) => r?.core?.fullName  ?? '',
  email:      (r) => r?.core?.email     ?? '',
  phone:      (r) => r?.core?.phone     ?? '',
  location:   (r) => r?.core?.location  ?? '',
  title:      (r) => r?.core?.title     ?? '',
  summary:    (r) => r?.core?.summary   ?? '',
  skills:     (r) => Array.isArray(r?.skills)     ? r.skills     : [],
  experience: (r) => Array.isArray(r?.experience) ? r.experience : [],
  education:  (r) => Array.isArray(r?.education)  ? r.education  : [],
  additionalSections: (r) =>
    Array.isArray(r?.additionalSections) ? r.additionalSections : [],
  confidence: (r) => r?.metadata?.parsingConfidence  ?? 0,
  completeness: (r) => r?.metadata?.completenessScore ?? 0,
  missingFields: (r) => r?.metadata?.missingFields    ?? [],
  domain:     (r) => r?.metadata?.detectedDomain     ?? null,
  skillNames: (r) =>
    (safe.skills(r)).map(s =>
      typeof s === 'string' ? s : (s?.name ?? '')
    ).filter(Boolean),
};

module.exports = Object.freeze({
  EXPERIENCE_TYPES,
  SCHEMA_VERSION,
  emptyResume,
  computeMetadata,
  safe,
});