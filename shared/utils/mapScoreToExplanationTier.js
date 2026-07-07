'use strict';

/**
 * @file src/shared/utils/mapScoreToExplanationTier.js
 *
 * @description
 * CommonJS companion to mapScoreToExplanationTier.ts.
 *
 * This file exists so the Jest test suite (which runs in Node CJS mode
 * without ts-jest) can require() the utility directly. The TypeScript
 * source at mapScoreToExplanationTier.ts is the canonical artifact;
 * this file must remain byte-for-byte logic-identical to it.
 *
 * When ts-jest is added to the project, this file may be removed and
 * tests updated to import the .ts source directly.
 *
 * Programme context: XAI-1 Sprint 0 / R1-DEV-01
 * Specification:     R1-SPEC-01 (Accepted)
 */

/**
 * Map a numeric score to the canonical ExplanationTier.
 *
 * @param {number | null | undefined} score - A numeric score in [0, 100].
 * @returns {'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA'}
 *
 * @example
 * mapScoreToExplanationTier(95)        // 'HIGH'
 * mapScoreToExplanationTier(75)        // 'MEDIUM'
 * mapScoreToExplanationTier(50)        // 'LOW'
 * mapScoreToExplanationTier(0)         // 'LOW'
 * mapScoreToExplanationTier(undefined) // 'NO_DATA'
 */
function mapScoreToExplanationTier(score) {
  // Guard: must be a finite number.
  // NOTE: Do NOT use `if (!score)` — 0 is a valid score and must return LOW.
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return 'NO_DATA';
  }

  // Guard: domain constraint [0, 100].
  if (score < 0 || score > 100) {
    return 'NO_DATA';
  }

  // Canonical threshold mapping (R1-SPEC-01).
  if (score >= 80) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  return 'LOW';
}

module.exports = Object.freeze({ mapScoreToExplanationTier });
