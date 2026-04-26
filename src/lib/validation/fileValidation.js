'use strict';

/**
 * @file src/lib/validation/fileValidation.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CLIENT-SIDE FILE UPLOAD VALIDATION UTILITY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Single source of truth for all frontend file validation logic.
 * Used by BOTH upload flows:
 *   • Sync:  POST /onboarding/upload-cv
 *   • Async: POST /resumes
 *
 * Mirrors backend constraints in:
 *   • core/api-service/src/shared/validation/index.js
 *   • core/src/modules/onboarding/onboarding.routes.js (multer config)
 *   • core/src/modules/resume/resume.routes.js (multer config)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VALIDATION ORDER (short-circuit: first failure wins)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. File presence  — exactly one file must be provided
 * 2. File integrity — reject 0-byte files
 * 3. File size      — max 10 MB
 * 4. File type      — extension + MIME must both be in the allowlist
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   import { validateFile, UPLOAD_ERROR_CODES } from '@/lib/validation/fileValidation';
 *
 *   const result = validateFile(file);          // file from <input type="file">
 *   if (!result.valid) {
 *     showError(result.message);
 *     return;                                   // ← DO NOT call API
 *   }
 *   // safe to proceed with upload
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum allowed file size in bytes (10 MB) */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum allowed file size, human-readable label */
export const MAX_FILE_SIZE_LABEL = '10MB';

/**
 * Allowed MIME types and their canonical file extensions.
 * Key   = MIME type (as reported by File.type in the browser)
 * Value = array of accepted extensions (lowercase, with leading dot)
 *
 * Must stay in sync with backend ALLOWED_MIME_TYPES sets in:
 *   • onboarding.routes.js → ALLOWED_ONBOARDING_MIMES
 *   • resume.routes.js     → ALLOWED_MIME_TYPES
 *   • shared/validation    → ALLOWED_MIME
 */
export const ALLOWED_FILE_TYPES = Object.freeze({
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
});

/** Flat set of all allowed MIME types (for fast lookup) */
export const ALLOWED_MIMES = new Set(Object.keys(ALLOWED_FILE_TYPES));

/** Flat set of all allowed extensions (for fast lookup) */
export const ALLOWED_EXTENSIONS = new Set(
  Object.values(ALLOWED_FILE_TYPES).flat()
);

// ─────────────────────────────────────────────────────────────────────────────
// ERROR CODES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frontend validation error codes.
 * These are distinct from backend error codes (NO_FILE, VALIDATION_ERROR, etc.)
 * and are used to drive UI state (error message, highlight, etc.).
 */
export const UPLOAD_ERROR_CODES = Object.freeze({
  NO_FILE:       'NO_FILE',          // no file selected
  EMPTY_FILE:    'EMPTY_FILE',       // 0-byte file
  FILE_TOO_LARGE: 'FILE_TOO_LARGE', // exceeds MAX_FILE_SIZE_BYTES
  INVALID_TYPE:  'INVALID_TYPE',     // extension or MIME not in allowlist
});

// ─────────────────────────────────────────────────────────────────────────────
// USER-FACING ERROR MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline error messages shown beneath the file input.
 * Written to be actionable — tells the user exactly what to do.
 */
export const UPLOAD_ERROR_MESSAGES = Object.freeze({
  [UPLOAD_ERROR_CODES.NO_FILE]:
    'Please upload a resume file.',

  [UPLOAD_ERROR_CODES.EMPTY_FILE]:
    'This file appears to be empty. Please upload a valid resume.',

  [UPLOAD_ERROR_CODES.FILE_TOO_LARGE]:
    `File exceeds the ${MAX_FILE_SIZE_LABEL} limit. Please compress or re-export your resume.`,

  [UPLOAD_ERROR_CODES.INVALID_TYPE]:
    'The selected file type is not supported or does not match its format. Please upload a valid PDF, DOC, DOCX, or TXT file.',
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the lowercase file extension (with leading dot) from a filename.
 * Returns empty string if filename has no extension.
 *
 * @param {string} filename
 * @returns {string}   e.g. '.pdf', '.docx', ''
 */
function getExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE VALIDATION FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateFile(file)
 *
 * Validates a browser File object before upload. Returns a result object.
 * Callers MUST check result.valid before calling any upload API.
 *
 * Validation order (short-circuit):
 *   1. File presence   → NO_FILE
 *   2. File integrity  → EMPTY_FILE
 *   3. File size       → FILE_TOO_LARGE
 *   4. File type       → INVALID_TYPE  (extension checked first, then MIME)
 *
 * @param   {File|null|undefined} file  — File object from <input type="file">
 * @returns {{ valid: boolean, code?: string, message?: string }}
 *
 * Success:  { valid: true }
 * Failure:  { valid: false, code: UPLOAD_ERROR_CODES.*, message: string }
 *
 * @example
 *   const result = validateFile(inputRef.current.files[0]);
 *   if (!result.valid) {
 *     setError(result.message);          // show inline error
 *     setSubmitDisabled(true);           // disable submit button
 *     return;                            // bail — do NOT call API
 *   }
 *   await uploadFile(file);              // safe to proceed
 */
export function validateFile(file) {
  // ── 1. Presence ────────────────────────────────────────────────────────────
  if (!file || !(file instanceof File)) {
    return {
      valid: false,
      code: UPLOAD_ERROR_CODES.NO_FILE,
      message: UPLOAD_ERROR_MESSAGES[UPLOAD_ERROR_CODES.NO_FILE],
    };
  }

  // ── 2. Integrity (0-byte guard) ─────────────────────────────────────────
  if (file.size === 0) {
    return {
      valid: false,
      code: UPLOAD_ERROR_CODES.EMPTY_FILE,
      message: UPLOAD_ERROR_MESSAGES[UPLOAD_ERROR_CODES.EMPTY_FILE],
    };
  }

  // ── 3. Size ─────────────────────────────────────────────────────────────
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      code: UPLOAD_ERROR_CODES.FILE_TOO_LARGE,
      message: UPLOAD_ERROR_MESSAGES[UPLOAD_ERROR_CODES.FILE_TOO_LARGE],
    };
  }

  // ── 4. Type (extension + MIME) ───────────────────────────────────────────
  const ext = getExtension(file.name);
  const mime = (file.type || '').toLowerCase();

  const isExtAllowed = ALLOWED_EXTENSIONS.has(ext);
  const isMimeAllowed = ALLOWED_MIMES.has(mime);

  // Both extension AND MIME must be in the allowlist.
  // A mismatch (e.g. a .exe renamed to .pdf) fails even if one side passes.
  if (!isExtAllowed || !isMimeAllowed) {
    return {
      valid: false,
      code: UPLOAD_ERROR_CODES.INVALID_TYPE,
      message: UPLOAD_ERROR_MESSAGES[UPLOAD_ERROR_CODES.INVALID_TYPE],
    };
  }

  // ── All checks passed ────────────────────────────────────────────────────
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKEND ERROR → UI MESSAGE MAPPING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps backend error codes returned by the API to UI-safe messages.
 * Used in the upload handler's catch block to translate API errors.
 *
 * Backend codes come from:
 *   • resume.controller.js  → 'NO_FILE', 'VALIDATION_ERROR', 'UNAUTHORIZED'
 *   • resume.service.js     → 'PROCESSING_FAILED'
 *   • error.middleware.js   → catch-all for unhandled errors
 *
 * @param {string|null} code    — e.g. response.data.code or response.data.error
 * @param {string|null} message — backend message (used when code === 'VALIDATION_ERROR')
 * @returns {string}            — UI-safe message to show the user
 */
export function mapBackendError(code, message = null) {
  switch (code) {
    case 'NO_FILE':
      // Backend received no file — should be caught client-side first,
      // but handle defensively in case client validation is bypassed.
      return 'Please upload a resume file.';

    case 'VALIDATION_ERROR':
      // Backend supplies a specific validation message — surface it directly.
      // e.g. "Unsupported mimeType: application/exe"
      return message || 'The file could not be validated. Please check the file and try again.';

    case 'UNAUTHORIZED':
      // Trigger auth redirect — caller should handle navigation.
      // Return a message in case the caller renders it before redirecting.
      return 'Your session has expired. Redirecting to login…';

    case 'PROCESSING_FAILED':
    case 'SCORING_FAILED':
      return 'Resume processing failed. Please try again.';

    default:
      return 'Something went wrong. Please try again.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD HANDLER INTEGRATION EXAMPLE
// ─────────────────────────────────────────────────────────────────────────────
//
// Both sync and async upload handlers follow the same pattern:
//
//   async function handleUpload(file, apiCall) {
//     // 1. Validate before touching the API
//     const validation = validateFile(file);
//     if (!validation.valid) {
//       setError(validation.message);
//       setSubmitDisabled(true);
//       return;
//     }
//
//     // 2. Proceed with upload
//     setLoading(true);
//     setSubmitDisabled(true);
//     setError(null);
//
//     try {
//       await apiCall(file);
//     } catch (err) {
//       const code    = err?.response?.data?.code ?? err?.response?.data?.error ?? null;
//       const message = err?.response?.data?.message ?? null;
//
//       if (code === 'UNAUTHORIZED') {
//         router.push('/login');
//         return;
//       }
//
//       setError(mapBackendError(code, message));
//     } finally {
//       setLoading(false);
//       setSubmitDisabled(false);
//     }
//   }