'use strict';

/**
 * csvParser.util.js — Streaming CSV Buffer Parser
 *
 * Converts a multer Buffer (already in memory ≤5MB) into an array of
 * plain objects keyed by the header row. Uses only Node built-ins —
 * no csv-parser or fast-csv package required.
 *
 * Design decisions:
 *   - multer memoryStorage() is used so the file is already a Buffer.
 *     True streaming (pipe from disk) is unnecessary at ≤5MB and would
 *     add complexity for negligible gain. The limit is enforced by multer.
 *   - Handles quoted fields ("field with, comma") and CRLF/LF line endings.
 *   - Empty rows and rows where all fields are blank are silently skipped.
 *   - Unknown columns are passed through — the service layer sanitizes them.
 *
 * Usage:
 *   const { parseCSVBuffer } = require('./csvParser.util');
 *   const rows = parseCSVBuffer(req.file.buffer);
 *   // rows = [{ name: 'JavaScript', category: 'language', ... }, ...]
 *
 * @module modules/admin/import/csvParser.util
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const MAX_ROWS     = 1000;
const MAX_COLUMNS  = 50;
const MAX_CELL_LEN = 500;

/**
 * Parse a CSV Buffer synchronously into an array of row objects.
 *
 * @param {Buffer} buffer   — File buffer from multer memoryStorage
 * @param {object} [opts]
 * @param {string} [opts.delimiter=',']
 * @returns {object[]}      — Array of plain objects keyed by header names
 * @throws {AppError}       — 400 if CSV is malformed or exceeds limits
 */
function parseCSVBuffer(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') {
    throw new AppError('Invalid file buffer', 400, null, ErrorCodes.VALIDATION_ERROR);
  }

  const delimiter = opts.delimiter || ',';
  const text      = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer;

  // Normalize line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  if (lines.length < 2) {
    throw new AppError(
      'CSV file must have a header row and at least one data row.',
      400, null, ErrorCodes.VALIDATION_ERROR
    );
  }

  // ── Parse header ─────────────────────────────────────────────────────────
  const headers = parseCSVLine(lines[0], delimiter).map(h => h.trim().toLowerCase());

  if (headers.length === 0 || headers.every(h => h === '')) {
    throw new AppError('CSV header row is empty.', 400, null, ErrorCodes.VALIDATION_ERROR);
  }

  if (headers.length > MAX_COLUMNS) {
    throw new AppError(
      `CSV has too many columns (${headers.length}). Maximum allowed: ${MAX_COLUMNS}.`,
      400, null, ErrorCodes.VALIDATION_ERROR
    );
  }

  // NOTE: 'name' column check removed — graph CSVs use domain-specific
  // id/field names (role_id, skill_id, from_role_id, etc.). Column validation
  // is handled per-dataset by graphImport.service.js schema definitions.

  // ── Parse data rows ──────────────────────────────────────────────────────
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // skip blank lines

    const values = parseCSVLine(line, delimiter);

    // Skip entirely empty rows
    if (values.every(v => v.trim() === '')) continue;

    // Build row object
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const key   = headers[j];
      const value = (values[j] ?? '').trim().slice(0, MAX_CELL_LEN);
      if (key) row[key] = value;
    }

    rows.push(row);

    if (rows.length > MAX_ROWS) {
      throw new AppError(
        `CSV exceeds the maximum row limit of ${MAX_ROWS}. Split into smaller files.`,
        400, { limit: MAX_ROWS }, ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  if (rows.length === 0) {
    throw new AppError(
      'CSV contains no data rows.',
      400, null, ErrorCodes.VALIDATION_ERROR
    );
  }

  return rows;
}

/**
 * Parse a single CSV line respecting quoted fields.
 * Handles: "field with, comma", "field with ""escaped"" quotes"
 *
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
function parseCSVLine(line, delimiter = ',') {
  const fields = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch   = line[i];
    const next = line[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // Escaped quote inside quoted field
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }

  fields.push(current); // last field
  return fields;
}

module.exports = { parseCSVBuffer, parseCSVLine };








