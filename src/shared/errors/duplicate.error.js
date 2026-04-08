'use strict';

/**
 * @file src/shared/errors/duplicate.error.js
 * @description
 * Domain error for duplicate dataset records.
 *
 * Datastore-agnostic and optimized for Supabase/Postgres-era services.
 * Produces a canonical API error envelope compatible with AppError.
 */

const { AppError } = require('../../middleware/errorHandler');

const DUPLICATE_RECORD = 'DUPLICATE_RECORD';

/**
 * Builds a readable singular dataset label.
 *
 * @param {string} datasetType
 * @returns {string}
 */
function formatDatasetLabel(datasetType) {
  if (!datasetType || typeof datasetType !== 'string') {
    return 'record';
  }

  return datasetType
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/s$/, '');
}

/**
 * DuplicateError
 *
 * Thrown when a unique dataset entry already exists.
 *
 * @param {string} datasetType
 * @param {string} value
 * @param {string|null} existingId
 * @param {object} [extra]
 */
class DuplicateError extends AppError {
  constructor(datasetType, value, existingId = null, extra = {}) {
    const safeDatasetType =
      typeof datasetType === 'string' && datasetType.trim()
        ? datasetType.trim()
        : 'records';

    const safeValue =
      value === undefined || value === null
        ? ''
        : String(value).trim();

    const safeExtra =
      extra && typeof extra === 'object' && !Array.isArray(extra)
        ? extra
        : {};

    const label = formatDatasetLabel(safeDatasetType);

    super(
      `A ${label} with this name already exists.`,
      409,
      {
        datasetType: safeDatasetType,
        value: safeValue,
        existingId,
        ...safeExtra,
      },
      DUPLICATE_RECORD,
      safeValue
        ? `"${safeValue}" already exists in the ${safeDatasetType} dataset.`
        : `A duplicate ${label} already exists.`
    );

    this.name = 'DuplicateError';
    this.datasetType = safeDatasetType;
    this.value = safeValue;
    this.existingId = existingId;

    Error.captureStackTrace?.(this, DuplicateError);
  }
}

module.exports = Object.freeze({
  DuplicateError,
  DUPLICATE_RECORD,
});