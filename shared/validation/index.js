'use strict';

/**
 * validators.js — HARDENED VERSION
 *
 * ✅ Firebase naming removed
 * ✅ Strong sanitization
 * ✅ Type safety
 * ✅ Length limits
 * ✅ Consistent error format
 */

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function error(message, code = 'VALIDATION_ERROR') {
  const err = new Error(message);
  err.code = code;
  return { valid: false, error: err };
}

function validateRequired(obj, fields) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return error('Invalid request body');
  }

  const missing = fields.filter(
    (f) => obj[f] === undefined || obj[f] === null || obj[f] === ''
  );

  if (missing.length > 0) {
    return error(`Missing required fields: ${missing.join(', ')}`);
  }

  return { valid: true };
}

// ─────────────────────────────────────────────
// Sanitization
// ─────────────────────────────────────────────

function sanitizeString(value, maxLength = 1000) {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .trim()
    .slice(0, maxLength)
    .replace(/[\x00-\x1F\x7F]/g, '');

  return cleaned.length ? cleaned : null;
}

function sanitizeObject(obj, allowedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};

  const result = {};

  for (const key of allowedKeys) {
    if (obj[key] !== undefined) {
      result[key] =
        typeof obj[key] === 'string'
          ? sanitizeString(obj[key])
          : obj[key];
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// Generic ID Validator (FIXED)
// ─────────────────────────────────────────────

function isValidId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 128) return false;
  return /^[a-zA-Z0-9_\-]+$/.test(id);
}

// ─────────────────────────────────────────────
// Resume Submission
// ─────────────────────────────────────────────

function validateResumeSubmission(body) {
  const ALLOWED_MIME = [
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  const required = validateRequired(body, [
    'resumeStoragePath',
    'fileName',
    'mimeType',
  ]);
  if (!required.valid) return required;

  const resumeStoragePath = sanitizeString(body.resumeStoragePath, 1024);
  const fileName = sanitizeString(body.fileName, 255);

  if (!resumeStoragePath) {
    return error('Invalid resumeStoragePath');
  }

  if (!fileName) {
    return error('Invalid fileName');
  }

  if (!ALLOWED_MIME.includes(body.mimeType)) {
    return error(`Unsupported mimeType: ${body.mimeType}`);
  }

  return {
    valid: true,
    data: {
      resumeStoragePath,
      fileName,
      mimeType: body.mimeType,
    },
  };
}

// ─────────────────────────────────────────────
// Salary Request
// ─────────────────────────────────────────────

function validateSalaryRequest(body) {
  const required = validateRequired(body, [
    'jobTitle',
    'location',
    'yearsExperience',
  ]);
  if (!required.valid) return required;

  const jobTitle = sanitizeString(body.jobTitle, 200);
  const location = sanitizeString(body.location, 200);

  if (!jobTitle || !location) {
    return error('Invalid jobTitle or location');
  }

  if (
    typeof body.yearsExperience !== 'number' ||
    body.yearsExperience < 0 ||
    body.yearsExperience > 60
  ) {
    return error('yearsExperience must be between 0 and 60');
  }

  return {
    valid: true,
    data: {
      jobTitle,
      location,
      yearsExperience: body.yearsExperience,
    },
  };
}

// ─────────────────────────────────────────────
// Career Path
// ─────────────────────────────────────────────

function validateCareerPathRequest(body) {
  const required = validateRequired(body, [
    'currentTitle',
    'targetTitle',
    'userId',
  ]);
  if (!required.valid) return required;

  const currentTitle = sanitizeString(body.currentTitle, 200);
  const targetTitle = sanitizeString(body.targetTitle, 200);

  if (!currentTitle || !targetTitle) {
    return error('Invalid titles');
  }

  if (!isValidId(body.userId)) {
    return error('Invalid userId');
  }

  return {
    valid: true,
    data: {
      currentTitle,
      targetTitle,
      userId: body.userId,
    },
  };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  validateRequired,
  sanitizeString,
  sanitizeObject,
  isValidId,
  validateResumeSubmission,
  validateSalaryRequest,
  validateCareerPathRequest,
};