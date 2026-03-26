'use strict';

/**
 * salaryCSVParser.util.js — Streaming CSV Parser for Salary Data
 *
 * Uses csv-parser for streaming (no full file load into memory).
 * Accepts a Buffer from multer, wraps it in a Readable stream,
 * and resolves with an array of normalized row objects.
 *
 * Expected CSV columns (case-insensitive, trimmed):
 *   role, location, experienceLevel, minSalary, medianSalary, maxSalary
 *
 * Optional columns:
 *   industry, sourceName, confidenceScore
 *
 * Example CSV:
 *   role,location,experienceLevel,minSalary,medianSalary,maxSalary
 *   Software Engineer,India,Mid,100000,200000,300000
 *
 * @module modules/salaryImport/salaryCSVParser.util
 */

const { Readable } = require('stream');
const csv          = require('csv-parser');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const REQUIRED_COLUMNS = ['role', 'minSalary', 'medianSalary', 'maxSalary'];

/**
 * Parse a CSV buffer into an array of salary row objects.
 * Streams the buffer — does not load the full file into memory.
 *
 * @param {Buffer} buffer   — Raw file buffer from multer
 * @returns {Promise<object[]>} Array of normalized row objects
 */
function parseSalaryCSVBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const rows   = [];
    let rowIndex = 0;
    let headersValidated = false;

    const stream = Readable.from(buffer);

    stream
      .pipe(csv({
        mapHeaders: ({ header }) => header.trim().toLowerCase(),
        skipLines:  0,
      }))
      .on('headers', (headers) => {
        // Validate required columns exist
        const missing = REQUIRED_COLUMNS.filter(col => !headers.includes(col.toLowerCase()));
        if (missing.length > 0) {
          stream.destroy(new AppError(
            `CSV missing required columns: ${missing.join(', ')}`,
            400,
            { missingColumns: missing, requiredColumns: REQUIRED_COLUMNS },
            ErrorCodes.VALIDATION_ERROR
          ));
        }
        headersValidated = true;
      })
      .on('data', (rawRow) => {
        rowIndex++;

        // Normalize numeric fields
        const minSalary    = parseFloat(rawRow.minsalary    || rawRow.minSalary    || '');
        const medianSalary = parseFloat(rawRow.mediansalary || rawRow.medianSalary || '');
        const maxSalary    = parseFloat(rawRow.maxsalary    || rawRow.maxSalary    || '');

        // Skip entirely blank rows
        if (!rawRow.role && isNaN(minSalary)) return;

        rows.push({
          _rowIndex:       rowIndex,
          role:            (rawRow.role            || '').trim(),
          location:        (rawRow.location         || '').trim(),
          experienceLevel: (rawRow.experiencelevel  || rawRow.experienceLevel || '').trim(),
          industry:        (rawRow.industry         || '').trim(),
          sourceName:      (rawRow.sourcename       || rawRow.sourceName || 'csv-import').trim(),
          confidenceScore: parseFloat(rawRow.confidencescore || rawRow.confidenceScore) || 0.8,
          minSalary:       isNaN(minSalary)    ? null : minSalary,
          medianSalary:    isNaN(medianSalary) ? null : medianSalary,
          maxSalary:       isNaN(maxSalary)    ? null : maxSalary,
        });
      })
      .on('end',   () => resolve(rows))
      .on('error', (err) => {
        if (err.isOperational) return reject(err);
        reject(new AppError(
          `CSV parse error: ${err.message}`,
          400, null, ErrorCodes.VALIDATION_ERROR
        ));
      });
  });
}

module.exports = { parseSalaryCSVBuffer };








