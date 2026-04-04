'use strict';

/**
 * src/modules/salaryImport/salaryCSVParser.util.js
 *
 * Production-grade streaming CSV parser for salary imports.
 *
 * Supabase migration note:
 * This utility is storage/database agnostic and contains no Firebase-specific
 * logic. No Supabase query-layer migration is required here.
 *
 * Improvements:
 * - strict header normalization
 * - deterministic numeric parsing
 * - safer null handling
 * - consistent AppError wrapping
 * - reduced duplicate property lookups
 * - clearer modular helpers for maintainability
 * - drop-in API compatibility preserved
 *
 * Expected required columns:
 *   role, minSalary, medianSalary, maxSalary
 *
 * Optional columns:
 *   location, experienceLevel, industry, sourceName, confidenceScore
 *
 * @module modules/salaryImport/salaryCSVParser.util
 */

const { Readable } = require('stream');
const csv = require('csv-parser');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');

const REQUIRED_COLUMNS = Object.freeze([
  'role',
  'minsalary',
  'mediansalary',
  'maxsalary',
]);

const DEFAULT_SOURCE_NAME = 'csv-import';
const DEFAULT_CONFIDENCE_SCORE = 0.8;

/**
 * Normalize CSV header keys for stable access.
 * @param {string} header
 * @returns {string}
 */
function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase();
}

/**
 * Parse numeric CSV values safely.
 * Empty / invalid values become null.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;

  const parsed = Number.parseFloat(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize a parsed CSV row into the salary import schema.
 * Preserves existing API behavior.
 *
 * @param {Record<string, any>} rawRow
 * @param {number} rowIndex
 * @returns {object|null}
 */
function normalizeSalaryRow(rawRow, rowIndex) {
  const role = String(rawRow.role || '').trim();

  const minSalary = toNullableNumber(rawRow.minsalary);
  const medianSalary = toNullableNumber(rawRow.mediansalary);
  const maxSalary = toNullableNumber(rawRow.maxsalary);

  // Preserve legacy behavior: skip fully blank rows
  if (!role && minSalary === null) {
    return null;
  }

  const confidenceScore =
    toNullableNumber(rawRow.confidencescore) ?? DEFAULT_CONFIDENCE_SCORE;

  return {
    _rowIndex: rowIndex,
    role,
    location: String(rawRow.location || '').trim(),
    experienceLevel: String(rawRow.experiencelevel || '').trim(),
    industry: String(rawRow.industry || '').trim(),
    sourceName: String(rawRow.sourcename || DEFAULT_SOURCE_NAME).trim(),
    confidenceScore,
    minSalary,
    medianSalary,
    maxSalary,
  };
}

/**
 * Parse a CSV buffer into normalized salary rows.
 *
 * Streaming-based implementation keeps memory usage efficient for large uploads.
 * The returned array behavior is intentionally preserved for existing service flow.
 *
 * @param {Buffer} buffer
 * @returns {Promise<object[]>}
 */
function parseSalaryCSVBuffer(buffer) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return reject(
        new AppError(
          'CSV file buffer is empty or invalid',
          400,
          null,
          ErrorCodes.VALIDATION_ERROR
        )
      );
    }

    const rows = [];
    let rowIndex = 0;
    let headersValidated = false;

    const sourceStream = Readable.from(buffer);

    const parser = csv({
      mapHeaders: ({ header }) => normalizeHeader(header),
      skipLines: 0,
      strict: false,
    });

    sourceStream
      .pipe(parser)
      .on('headers', (headers) => {
        const normalizedHeaders = headers.map(normalizeHeader);

        const missingColumns = REQUIRED_COLUMNS.filter(
          (column) => !normalizedHeaders.includes(column)
        );

        if (missingColumns.length > 0) {
          return sourceStream.destroy(
            new AppError(
              `CSV missing required columns: ${missingColumns.join(', ')}`,
              400,
              {
                missingColumns,
                requiredColumns: REQUIRED_COLUMNS,
              },
              ErrorCodes.VALIDATION_ERROR
            )
          );
        }

        headersValidated = true;
      })
      .on('data', (rawRow) => {
        rowIndex += 1;

        const normalizedRow = normalizeSalaryRow(rawRow, rowIndex);
        if (normalizedRow) rows.push(normalizedRow);
      })
      .on('end', () => {
        if (!headersValidated) {
          return reject(
            new AppError(
              'CSV headers could not be validated',
              400,
              null,
              ErrorCodes.VALIDATION_ERROR
            )
          );
        }

        return resolve(rows);
      })
      .on('error', (error) => {
        if (error?.isOperational) {
          return reject(error);
        }

        return reject(
          new AppError(
            `CSV parse error: ${error.message}`,
            400,
            { rowIndex },
            ErrorCodes.VALIDATION_ERROR
          )
        );
      });
  });
}

module.exports = {
  parseSalaryCSVBuffer,
};
