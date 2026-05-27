'use strict';

/**
 * @file src/config/credits.config.js
 *
 * Immutable credit cost configuration.
 * Pure constants — no DB, no async, no external IO.
 *
 * Moved from services/billing/creditConfig.service.js (Phase D, Group A fix #3).
 * Original file was misclassified as a service; it contains only frozen
 * configuration constants and is safe to live in src/config/.
 */

const CREDIT_CONFIG = Object.freeze({
  costs: Object.freeze({
    fullAnalysis:    10,
    generateCV:       5,
    jobMatchAnalysis: 8,
  }),
});

/**
 * Returns the immutable credit configuration object.
 * @returns {typeof CREDIT_CONFIG}
 */
function getCreditConfig() {
  return CREDIT_CONFIG;
}

module.exports = {
  getCreditConfig,
  CREDIT_CONFIG,
};