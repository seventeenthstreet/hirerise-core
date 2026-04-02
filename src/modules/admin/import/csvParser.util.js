'use strict';

/**
 * csvParser.util.js
 * Production-grade CSV parser for Supabase bulk imports
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

const DEFAULT_LIMITS = {
  maxRows: 10000,
  maxColumns: 100,
  maxCellLength: 2000,
};

function parseCSVBuffer(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') {
    throw new AppError(
      'Invalid CSV buffer',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const delimiter = opts.delimiter || ',';
  const limits = {
    ...DEFAULT_LIMITS,
    ...opts,
  };

  const text = Buffer.isBuffer(buffer)
    ? buffer.toString('utf8')
    : String(buffer);

  const rows = [];
  const parsed = parseCSVText(text, delimiter);

  if (parsed.length < 2) {
    throw new AppError(
      'CSV must contain a header and at least one data row.',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const headers = parsed[0].map((h) => h.trim().toLowerCase());

  if (!headers.length || headers.every((h) => !h)) {
    throw new AppError(
      'CSV header row is empty.',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (headers.length > limits.maxColumns) {
    throw new AppError(
      `Too many columns (${headers.length}). Max allowed: ${limits.maxColumns}`,
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  for (let i = 1; i < parsed.length; i++) {
    const values = parsed[i];

    if (!values.some((v) => String(v).trim())) {
      continue;
    }

    const row = {};

    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const value = String(values[j] || '')
        .trim()
        .slice(0, limits.maxCellLength);

      if (key) {
        row[key] = value;
      }
    }

    rows.push(row);

    if (rows.length > limits.maxRows) {
      throw new AppError(
        `CSV row limit exceeded (${limits.maxRows})`,
        400,
        { limit: limits.maxRows },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  if (!rows.length) {
    throw new AppError(
      'CSV contains no valid data rows.',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return rows;
}

function parseCSVText(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (ch !== '\r') {
      field += ch;
    }
  }

  row.push(field);
  rows.push(row);

  if (inQuotes) {
    throw new AppError(
      'Malformed CSV: unclosed quoted field detected.',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return rows;
}

module.exports = {
  parseCSVBuffer,
  parseCSVText,
};