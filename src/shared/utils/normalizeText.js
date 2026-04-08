'use strict';

/**
 * @file src/shared/utils/normalizeText.js
 * @description
 * Dataset normalization utilities optimized for Supabase/Postgres
 * unique constraints, batch imports, and duplicate-safe upserts.
 */

/**
 * Normalize text into a canonical DB-safe comparable string.
 *
 * Strategy:
 * - Unicode normalize (NFKD)
 * - strip diacritics
 * - lowercase
 * - remove punctuation
 * - collapse spaces
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new TypeError(
      `normalizeText expects a string, got ${typeof value}`
    );
  }

  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize scoped composite uniqueness keys.
 *
 * @param {string} name
 * @param {string} scopeId
 * @returns {string}
 */
function normalizeForComposite(name, scopeId) {
  if (typeof name !== 'string' || typeof scopeId !== 'string') {
    throw new TypeError(
      'normalizeForComposite requires two string arguments'
    );
  }

  return `${normalizeText(name)}::${normalizeText(scopeId)}`;
}

/**
 * Normalize an array of values safely.
 *
 * Null/undefined values are skipped to improve CSV import resilience.
 *
 * @param {Array<string|null|undefined>} values
 * @returns {string[]}
 */
function normalizeMany(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('normalizeMany expects an array');
  }

  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => normalizeText(String(value)));
}

/**
 * Detect internal duplicate normalized values.
 *
 * @param {Array<string|null|undefined>} values
 * @returns {{ hasDuplicates: boolean, duplicates: string[] }}
 */
function findInternalDuplicates(values) {
  const normalizedValues = normalizeMany(values);

  const seen = new Set();
  const duplicates = new Set();

  for (const value of normalizedValues) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return {
    hasDuplicates: duplicates.size > 0,
    duplicates: Array.from(duplicates),
  };
}

module.exports = Object.freeze({
  normalizeText,
  normalizeForComposite,
  normalizeMany,
  findInternalDuplicates,
});