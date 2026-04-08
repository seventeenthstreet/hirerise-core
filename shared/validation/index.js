'use strict';

/**
 * shared/validation/validators.js
 *
 * Validation layer — production hardened
 *
 * ✅ Zero Firebase legacy
 * ✅ Better whitespace validation
 * ✅ Stronger sanitization
 * ✅ Numeric normalization
 * ✅ Safer MIME validation
 * ✅ Better API compatibility
 * ✅ Predictable error contracts
 */

function buildError(message, code = 'VALIDATION_ERROR', field = null) {
  const err = new Error(message);
  err.code = code;
  err.field = field;

  return {
    valid: false,
    error: err,
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function validateRequired(obj, fields = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return buildError('Invalid request body');
  }

  const missing = fields.filter((field) => {
    const value = obj[field];

    if (value === undefined || value === null) return true;

    if (typeof value === 'string' && value.trim().length === 0) {
      return true;
    }

    return false;
  });

  if (missing.length > 0) {
    return buildError(
      `Missing required fields: ${missing.join(', ')}`,
      'VALIDATION_ERROR'
    );
  }

  return { valid: true };
}

// ─────────────────────────────────────────────
// Sanitization
// ─────────────────────────────────────────────
function sanitizeString(value, maxLength = 1000) {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);

  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeObject(obj, allowedKeys = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {};
  }

  const result = {};

  for (const key of allowedKeys) {
    if (!(key in obj)) continue;

    const value = obj[key];

    result[key] =
      typeof value === 'string' ? sanitizeString(value) : value;
  }

  return result;
}

function parseSafeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

// ─────────────────────────────────────────────
// Generic ID Validator
// ─────────────────────────────────────────────
function isValidId(id) {
  if (typeof id !== 'string') return false;

  const trimmed = id.trim();

  if (!trimmed || trimmed.length > 128) return false;

  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

// ─────────────────────────────────────────────
// Resume Submission
// ─────────────────────────────────────────────
function validateResumeSubmission(body) {
  const ALLOWED_MIME = new Set([
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]);

  const required = validateRequired(body, [
    'resumeStoragePath',
    'fileName',
    'mimeType',
  ]);

  if (!required.valid) return required;

  const resumeStoragePath = sanitizeString(body.resumeStoragePath, 1024);
  const fileName = sanitizeString(body.fileName, 255);
  const mimeType = sanitizeString(body.mimeType, 200)?.toLowerCase();

  if (!resumeStoragePath) {
    return buildError('Invalid resumeStoragePath', 'VALIDATION_ERROR', 'resumeStoragePath');
  }

  if (!fileName) {
    return buildError('Invalid fileName', 'VALIDATION_ERROR', 'fileName');
  }

  if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
    return buildError(`Unsupported mimeType: ${body.mimeType}`, 'VALIDATION_ERROR', 'mimeType');
  }

  return {
    valid: true,
    data: {
      resumeStoragePath,
      fileName,
      mimeType,
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
  const yearsExperience = parseSafeNumber(body.yearsExperience);

  if (!jobTitle) {
    return buildError('Invalid jobTitle', 'VALIDATION_ERROR', 'jobTitle');
  }

  if (!location) {
    return buildError('Invalid location', 'VALIDATION_ERROR', 'location');
  }

  if (
    yearsExperience === null ||
    yearsExperience < 0 ||
    yearsExperience > 60
  ) {
    return buildError(
      'yearsExperience must be between 0 and 60',
      'VALIDATION_ERROR',
      'yearsExperience'
    );
  }

  return {
    valid: true,
    data: {
      jobTitle,
      location,
      yearsExperience,
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
  const userId = sanitizeString(body.userId, 128);

  if (!currentTitle) {
    return buildError('Invalid currentTitle', 'VALIDATION_ERROR', 'currentTitle');
  }

  if (!targetTitle) {
    return buildError('Invalid targetTitle', 'VALIDATION_ERROR', 'targetTitle');
  }

  if (!isValidId(userId)) {
    return buildError('Invalid userId', 'VALIDATION_ERROR', 'userId');
  }

  return {
    valid: true,
    data: {
      currentTitle,
      targetTitle,
      userId,
    },
  };
}

module.exports = {
  validateRequired,
  sanitizeString,
  sanitizeObject,
  parseSafeNumber,
  isValidId,
  validateResumeSubmission,
  validateSalaryRequest,
  validateCareerPathRequest,
};