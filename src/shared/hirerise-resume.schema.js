'use strict';

/**
 * @file src/shared/hirerise-resume.schema.js
 *
 * HireRise canonical Resume schema — v1.0.0
 *
 * Defines:
 *   - EXPERIENCE_TYPES  — enum for classifying experience entries
 *   - emptyResume()     — factory that produces a blank HireRiseResume object
 *   - computeMetadata() — derives completenessScore + missingFields from a resume
 *
 * This is a PURE data-shape module — no I/O, no DB, no HTTP.
 */

// ─── Experience Type Enum ─────────────────────────────────────────────────────

/**
 * @enum {string}
 */
const EXPERIENCE_TYPES = Object.freeze({
  JOB:        'job',
  INTERNSHIP: 'internship',
  PROJECT:    'project',
});

// ─── Empty Resume Factory ─────────────────────────────────────────────────────

/**
 * Returns a blank HireRiseResume with every field initialised to a safe default.
 *
 * Shape:
 * {
 *   resumeId:           string,
 *   userId:             string,
 *   core: {
 *     fullName:         string,
 *     email:            string | null,
 *     phone:            string | null,
 *     location:         string | null,
 *     title:            string | null,   // detected / stated job title
 *     summary:          string | null,
 *   },
 *   skills:             Array<{ name: string }>,
 *   experience:         Array<{
 *                         role:        string,
 *                         company:     string,
 *                         startDate:   string | null,
 *                         endDate:     string | null,
 *                         current:     boolean,
 *                         description: string | null,
 *                         type:        'job' | 'internship' | 'project',
 *                       }>,
 *   education:          Array<{
 *                         degree:      string,
 *                         institution: string,
 *                         startYear:   number | null,
 *                         endYear:     number | null,
 *                       }>,
 *   additionalSections: Array<{
 *                         title: string,
 *                         items: Array<{ name: string }>,
 *                       }>,
 *   metadata: {
 *     parsingConfidence:  number,   // 0–1
 *     completenessScore:  number,   // 0–1
 *     missingFields:      string[],
 *     detectedDomain:     string | null,
 *     schemaVersion:      string,
 *     parsedAt:           string,   // ISO-8601
 *   },
 * }
 *
 * @param {string} resumeId
 * @param {string} userId
 * @returns {HireRiseResume}
 */
function emptyResume(resumeId, userId) {
  return {
    resumeId: resumeId ?? '',
    userId:   userId   ?? '',

    core: {
      fullName: '',
      email:    null,
      phone:    null,
      location: null,
      title:    null,
      summary:  null,
    },

    skills:             [],
    experience:         [],
    education:          [],
    additionalSections: [],

    metadata: {
      parsingConfidence: 0,
      completenessScore: 0,
      missingFields:     [],
      detectedDomain:    null,
      schemaVersion:     '1.0.0',
      parsedAt:          new Date().toISOString(),
    },
  };
}

// ─── Metadata Computation ─────────────────────────────────────────────────────

/**
 * Core fields checked for completeness (in priority order).
 * Each entry: { field: string, weight: number, check: (resume) => boolean }
 */
const COMPLETENESS_CHECKS = [
  {
    field:  'fullName',
    weight: 0.15,
    check:  r => Boolean(r.core?.fullName?.trim()),
  },
  {
    field:  'email',
    weight: 0.10,
    check:  r => Boolean(r.core?.email),
  },
  {
    field:  'phone',
    weight: 0.05,
    check:  r => Boolean(r.core?.phone),
  },
  {
    field:  'location',
    weight: 0.05,
    check:  r => Boolean(r.core?.location),
  },
  {
    field:  'summary',
    weight: 0.10,
    check:  r => Boolean(r.core?.summary?.trim()),
  },
  {
    field:  'skills',
    weight: 0.15,
    check:  r => Array.isArray(r.skills) && r.skills.length > 0,
  },
  {
    field:  'experience',
    weight: 0.25,
    check:  r => Array.isArray(r.experience) && r.experience.length > 0,
  },
  {
    field:  'education',
    weight: 0.15,
    check:  r => Array.isArray(r.education) && r.education.length > 0,
  },
];

/**
 * Derives `completenessScore` (0–1) and `missingFields` (string[]) from a resume.
 *
 * @param {HireRiseResume} resume
 * @returns {{ completenessScore: number, missingFields: string[] }}
 */
function computeMetadata(resume) {
  let score         = 0;
  const missingFields = [];

  for (const { field, weight, check } of COMPLETENESS_CHECKS) {
    if (check(resume)) {
      score += weight;
    } else {
      missingFields.push(field);
    }
  }

  // Round to 2 decimal places
  const completenessScore = Math.round(score * 100) / 100;

  return { completenessScore, missingFields };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  EXPERIENCE_TYPES,
  emptyResume,
  computeMetadata,
});
