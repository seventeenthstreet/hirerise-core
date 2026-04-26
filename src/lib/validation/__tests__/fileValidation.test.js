/**
 * @file src/lib/validation/__tests__/fileValidation.test.js
 *
 * Unit tests for validateFile() and mapBackendError().
 * Run with: jest src/lib/validation/__tests__/fileValidation.test.js
 */

import {
  validateFile,
  mapBackendError,
  UPLOAD_ERROR_CODES,
  MAX_FILE_SIZE_BYTES,
} from '../fileValidation';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock File object for testing.
 * Browser File constructor: new File([content], filename, { type })
 */
function makeFile({ name = 'resume.pdf', type = 'application/pdf', size = null } = {}) {
  // Build content that produces the desired size
  const content = size !== null
    ? new Uint8Array(size)
    : new Uint8Array(1024); // 1KB default

  const file = new File([content], name, { type });
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateFile — file presence
// ─────────────────────────────────────────────────────────────────────────────

describe('validateFile — file presence', () => {
  test('returns NO_FILE when file is null', () => {
    const result = validateFile(null);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.NO_FILE);
    expect(result.message).toBeTruthy();
  });

  test('returns NO_FILE when file is undefined', () => {
    const result = validateFile(undefined);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.NO_FILE);
  });

  test('returns NO_FILE when given a plain object (not a File)', () => {
    const result = validateFile({ name: 'resume.pdf', size: 1024 });
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.NO_FILE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateFile — file integrity (0-byte guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateFile — file integrity', () => {
  test('returns EMPTY_FILE when file.size is 0', () => {
    const file   = makeFile({ size: 0 });
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.EMPTY_FILE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateFile — file size
// ─────────────────────────────────────────────────────────────────────────────

describe('validateFile — file size', () => {
  test('accepts file exactly at 10MB limit', () => {
    const file   = makeFile({ size: MAX_FILE_SIZE_BYTES });
    const result = validateFile(file);
    // Type check will run next; size itself is fine
    // (If type is valid this should be valid)
    if (result.code) {
      expect(result.code).not.toBe(UPLOAD_ERROR_CODES.FILE_TOO_LARGE);
    }
  });

  test('returns FILE_TOO_LARGE when file exceeds 10MB', () => {
    const file   = makeFile({ size: MAX_FILE_SIZE_BYTES + 1 });
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.FILE_TOO_LARGE);
    expect(result.message).toMatch(/10MB/i);
  });

  test('returns FILE_TOO_LARGE for a 50MB file', () => {
    const file   = makeFile({ size: 50 * 1024 * 1024 });
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.FILE_TOO_LARGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateFile — allowed types
// ─────────────────────────────────────────────────────────────────────────────

describe('validateFile — allowed file types', () => {
  const VALID_FILES = [
    { name: 'resume.pdf',  type: 'application/pdf' },
    { name: 'resume.doc',  type: 'application/msword' },
    {
      name: 'resume.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { name: 'resume.txt',  type: 'text/plain' },
  ];

  VALID_FILES.forEach(({ name, type }) => {
    test(`accepts ${name} (${type})`, () => {
      const file   = makeFile({ name, type });
      const result = validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.code).toBeUndefined();
    });
  });

  const INVALID_FILES = [
    { name: 'resume.exe',  type: 'application/octet-stream',  label: '.exe' },
    { name: 'resume.png',  type: 'image/png',                 label: '.png' },
    { name: 'resume.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: '.xlsx' },
    { name: 'resume.html', type: 'text/html',                 label: '.html' },
    { name: 'resume.zip',  type: 'application/zip',           label: '.zip' },
  ];

  INVALID_FILES.forEach(({ name, type, label }) => {
    test(`rejects ${label} file (${type})`, () => {
      const file   = makeFile({ name, type });
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.code).toBe(UPLOAD_ERROR_CODES.INVALID_TYPE);
    });
  });

  test('rejects mismatched extension + MIME (e.g. .pdf with text/plain MIME)', () => {
    // A legitimate .pdf should not report text/plain
    const file   = makeFile({ name: 'resume.pdf', type: 'text/plain' });
    const result = validateFile(file);
    // Extension .pdf is valid but MIME text/plain doesn't map to .pdf
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.INVALID_TYPE);
  });

  test('rejects valid MIME with wrong extension (.txt renamed to .exe)', () => {
    const file   = makeFile({ name: 'resume.exe', type: 'text/plain' });
    const result = validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.INVALID_TYPE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateFile — validation order (short-circuit)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateFile — validation order', () => {
  test('reports EMPTY_FILE (not FILE_TOO_LARGE) for a 0-byte oversized file', () => {
    // Size = 0 should be caught by EMPTY_FILE before size check
    const file   = makeFile({ size: 0 });
    const result = validateFile(file);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.EMPTY_FILE);
  });

  test('reports FILE_TOO_LARGE (not INVALID_TYPE) for an oversized .exe', () => {
    // Size check comes before type check in validation order
    const file   = makeFile({ name: 'resume.exe', type: 'application/octet-stream', size: MAX_FILE_SIZE_BYTES + 1 });
    const result = validateFile(file);
    expect(result.code).toBe(UPLOAD_ERROR_CODES.FILE_TOO_LARGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapBackendError
// ─────────────────────────────────────────────────────────────────────────────

describe('mapBackendError', () => {
  test('NO_FILE → asks user to upload a file', () => {
    expect(mapBackendError('NO_FILE')).toMatch(/upload/i);
  });

  test('VALIDATION_ERROR → surfaces backend message when provided', () => {
    const msg = 'Unsupported mimeType: application/exe';
    expect(mapBackendError('VALIDATION_ERROR', msg)).toBe(msg);
  });

  test('VALIDATION_ERROR → returns fallback when backend message is null', () => {
    const result = mapBackendError('VALIDATION_ERROR', null);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('UNAUTHORIZED → message contains redirect intent', () => {
    const result = mapBackendError('UNAUTHORIZED');
    expect(result).toMatch(/login|session/i);
  });

  test('PROCESSING_FAILED → tells user to try again', () => {
    expect(mapBackendError('PROCESSING_FAILED')).toMatch(/try again/i);
  });

  test('SCORING_FAILED → same as PROCESSING_FAILED', () => {
    expect(mapBackendError('SCORING_FAILED')).toMatch(/try again/i);
  });

  test('unknown code → generic fallback', () => {
    expect(mapBackendError('TOTALLY_UNKNOWN_CODE')).toMatch(/went wrong/i);
  });

  test('null code → generic fallback', () => {
    expect(mapBackendError(null)).toMatch(/went wrong/i);
  });
});