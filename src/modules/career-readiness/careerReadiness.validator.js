'use strict';

/**
 * careerReadiness.validator.js
 *
 * Pure JavaScript validation — no Joi dependency.
 * Preserves all original rules including GAP T6 fix:
 *   candidateId uses min(20)/max(40) not UUID format,
 *   because user IDs are 28-char alphanumeric strings.
 */

const VALID_EDUCATION = new Set([
  'none', 'associates', 'bachelors', 'masters', 'phd',
  'diploma', 'certificate', 'undergraduate', 'postgraduate', 'doctorate',
]);

function validateCandidateProfile(data) {
  if (!data || typeof data !== 'object') {
    throw new ValidationError('Invalid candidate profile', ['profile must be an object']);
  }

  const errors = [];

  // candidateId — GAP T6: user ID (28-char alphanumeric), not UUID
  const id = data.candidateId;
  if (!id || typeof id !== 'string' || id.length < 20 || id.length > 40) {
    errors.push('candidateId must be a string between 20 and 40 characters');
  }

  // skills
  if (!Array.isArray(data.skills) || data.skills.length < 1) {
    errors.push('skills must be a non-empty array');
  } else if (!data.skills.every(s => typeof s === 'string')) {
    errors.push('skills must be an array of strings');
  }

  // totalYearsExperience
  const yoe = data.totalYearsExperience;
  if (typeof yoe !== 'number' || isNaN(yoe) || yoe < 0 || yoe > 60) {
    errors.push('totalYearsExperience must be a number between 0 and 60');
  }

  // workHistory
  if (!Array.isArray(data.workHistory)) {
    errors.push('workHistory must be an array');
  } else {
    data.workHistory.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`workHistory[${i}] must be an object`);
        return;
      }
      if (!entry.title || typeof entry.title !== 'string') {
        errors.push(`workHistory[${i}].title is required`);
      }
      if (typeof entry.years !== 'number' || isNaN(entry.years) || entry.years < 0) {
        errors.push(`workHistory[${i}].years must be a non-negative number`);
      }
      if (entry.skills !== undefined && !Array.isArray(entry.skills)) {
        errors.push(`workHistory[${i}].skills must be an array`);
      }
    });
  }

  // highestEducation
  if (!data.highestEducation || !VALID_EDUCATION.has(data.highestEducation)) {
    errors.push(`highestEducation must be one of: ${[...VALID_EDUCATION].join(', ')}`);
  }

  // currentSalary
  const sal = data.currentSalary;
  if (typeof sal !== 'number' || isNaN(sal) || sal < 0) {
    errors.push('currentSalary must be a non-negative number');
  }

  // targetRoleId
  if (!data.targetRoleId || typeof data.targetRoleId !== 'string') {
    errors.push('targetRoleId is required');
  }

  if (errors.length) {
    throw new ValidationError('Invalid candidate profile', errors);
  }

  // Return normalised value (apply defaults for optional fields)
  return {
    candidateId:          data.candidateId,
    skills:               data.skills,
    totalYearsExperience: data.totalYearsExperience,
    workHistory:          data.workHistory.map(e => ({
      title:  e.title,
      years:  e.years,
      skills: Array.isArray(e.skills) ? e.skills : [],
    })),
    certifications:   Array.isArray(data.certifications) ? data.certifications : [],
    highestEducation: data.highestEducation,
    currentSalary:    data.currentSalary,
    targetRoleId:     data.targetRoleId,
  };
}

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name       = 'ValidationError';
    this.details    = details;
    this.statusCode = 422;
  }
}

module.exports = { validateCandidateProfile, ValidationError };








