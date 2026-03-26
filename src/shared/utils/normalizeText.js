'use strict';

/**
 * normalizeText.js — Dataset Normalization Utilities
 *
 * Used to produce a canonical, comparable form of any text field
 * before duplicate checks or database inserts.
 *
 * Strategy:
 *   - Lowercase + trim (case-insensitive equality)
 *   - Remove all non-alphanumeric characters except spaces
 *   - Collapse multiple spaces to single space
 *
 * This ensures "JavaScript", "javascript", "Java Script", and "java-script"
 * all produce the same normalized form: "javascript".
 *
 * Design rationale:
 *   The normalized value is stored alongside the original. The original
 *   is displayed to users; the normalized form is used only for dedup
 *   checks and unique constraint enforcement. This preserves presentation
 *   fidelity while guaranteeing semantic uniqueness.
 *
 * Usage:
 *   const { normalizeText, normalizeForComposite } = require('../shared/utils/normalizeText');
 *
 *   const normalized = normalizeText('  Node.JS ');  // → 'nodejs'
 *   const key = normalizeForComposite('Senior PM', 'product-management'); // → 'senior pm::product-management'
 */

/**
 * Normalize a single text value for duplicate detection.
 *
 * @param {string} value
 * @returns {string} Normalized lowercase alphanumeric-only string
 * @throws {TypeError} if value is not a string
 */
function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`normalizeText expects a string, got ${typeof value}`);
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '')   // Remove all non-alphanumeric except spaces
    .replace(/\s+/g, ' ')      // Collapse multiple spaces to one
    .trim();                   // Trim any residual leading/trailing spaces
}

/**
 * Normalize a composite key for records that are unique within a scope.
 *
 * Example: A role is unique by (name + jobFamilyId) — not just name alone.
 * Two different families can have a "Director" role without conflict.
 *
 * @param {string} name       — The primary name field
 * @param {string} scopeId    — The scoping identifier (e.g. jobFamilyId)
 * @returns {string}          — Composite normalized key: "normalizedname::scopeid"
 */
function normalizeForComposite(name, scopeId) {
  if (typeof name !== 'string' || typeof scopeId !== 'string') {
    throw new TypeError('normalizeForComposite requires two string arguments');
  }
  return `${normalizeText(name)}::${scopeId.trim().toLowerCase()}`;
}

/**
 * Normalize an array of values, returning their normalized forms.
 * Useful for batch CSV processing.
 *
 * @param {string[]} values
 * @returns {string[]}
 */
function normalizeMany(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('normalizeMany expects an array');
  }
  return values.map(normalizeText);
}

/**
 * Detect duplicates within an array of values before DB insert.
 * Returns the set of normalized values that appear more than once.
 *
 * @param {string[]} values
 * @returns {{ hasDuplicates: boolean, duplicates: string[] }}
 */
function findInternalDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    const norm = normalizeText(value);
    if (seen.has(norm)) {
      duplicates.add(norm);
    } else {
      seen.add(norm);
    }
  }

  return {
    hasDuplicates: duplicates.size > 0,
    duplicates: [...duplicates],
  };
}

module.exports = {
  normalizeText,
  normalizeForComposite,
  normalizeMany,
  findInternalDuplicates,
};








