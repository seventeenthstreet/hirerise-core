'use strict';

/**
 * duplicate.error.js — Domain Error for Duplicate Dataset Records
 *
 * Extends the existing AppError pattern used throughout HireRise.
 * Produces the canonical error envelope:
 *
 *   {
 *     "success": false,
 *     "error": {
 *       "code": "DUPLICATE_RECORD",
 *       "message": "A skill with this name already exists."
 *     },
 *     "details": {
 *       "field": "name",
 *       "value": "JavaScript",
 *       "normalizedValue": "javascript",
 *       "existingId": "skill_abc123",
 *       "datasetType": "skills"
 *     }
 *   }
 *
 * Usage:
 *   const { DuplicateError } = require('../../shared/errors/duplicate.error');
 *   throw new DuplicateError('skills', 'JavaScript', 'skill_abc123');
 */

const { AppError } = require('../../middleware/errorHandler');

// ── Error code constant ────────────────────────────────────────────────────────
const DUPLICATE_RECORD = 'DUPLICATE_RECORD';

/**
 * DuplicateError — thrown when a dataset entry already exists.
 *
 * @param {string} datasetType  — 'skills' | 'roles' | 'jobFamilies' | 'educationLevels' | 'salaryBenchmarks'
 * @param {string} value        — The original (non-normalized) value that conflicted
 * @param {string} existingId   — Firestore document ID of the existing record
 * @param {object} [extra]      — Optional extra context (e.g. { field: 'normalizedName' })
 */
class DuplicateError extends AppError {
  constructor(datasetType, value, existingId, extra = {}) {
    const message = `A ${datasetType.replace(/([A-Z])/g, ' $1').toLowerCase().trim()} with this name already exists.`;

    super(
      message,
      409,                  // HTTP 409 Conflict
      {
        datasetType,
        value,
        existingId,
        ...extra,
      },
      DUPLICATE_RECORD,     // machine-readable error code
      `"${value}" already exists in the ${datasetType} dataset.`
    );

    this.name        = 'DuplicateError';
    this.datasetType = datasetType;
    this.existingId  = existingId;
  }
}

module.exports = { DuplicateError, DUPLICATE_RECORD };








