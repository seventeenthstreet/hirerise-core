'use strict';

// FIX: Converted from ESM to CJS to match the rest of the codebase.

// ─── Field Validators ─────────────────────────────────────────────────────────

function validateRequired(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length > 0) {
    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
  }
  return { valid: true };
}

function sanitizeString(value, maxLength = 10000) {
  if (typeof value !== 'string') return null;
  return value
    .trim()
    .slice(0, maxLength)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // strip control chars
}

function sanitizeObject(obj, allowedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => allowedKeys.includes(k))
      .map(([k, v]) => [k, typeof v === 'string' ? sanitizeString(v) : v])
  );
}

function isValidFirestoreId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 1500) return false;
  return !/[\/\x00]/.test(id);
}

// ─── Resume Submission Validator ─────────────────────────────────────────────

function validateResumeSubmission(body) {
  const ALLOWED_MIME = ['application/pdf', 'text/plain', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

  const required = validateRequired(body, ['resumeStoragePath', 'fileName', 'mimeType']);
  if (!required.valid) return required;

  if (!ALLOWED_MIME.includes(body.mimeType)) {
    return { valid: false, error: `Unsupported mimeType: ${body.mimeType}` };
  }

  if (typeof body.resumeStoragePath !== 'string' || body.resumeStoragePath.length > 1024) {
    return { valid: false, error: 'Invalid resumeStoragePath' };
  }

  return { valid: true };
}

// ─── Salary Request Validator ─────────────────────────────────────────────────

function validateSalaryRequest(body) {
  const required = validateRequired(body, ['jobTitle', 'location', 'yearsExperience']);
  if (!required.valid) return required;

  if (typeof body.yearsExperience !== 'number' || body.yearsExperience < 0 || body.yearsExperience > 60) {
    return { valid: false, error: 'yearsExperience must be a number between 0 and 60' };
  }

  return { valid: true };
}

// ─── Career Path Request Validator ───────────────────────────────────────────

function validateCareerPathRequest(body) {
  return validateRequired(body, ['currentTitle', 'targetTitle', 'userId']);
}

module.exports = {
  validateRequired,
  sanitizeString,
  sanitizeObject,
  isValidFirestoreId,
  validateResumeSubmission,
  validateSalaryRequest,
  validateCareerPathRequest,
};