'use strict';

/**
 * src/services/confidence.utils.js
 *
 * Utility re-export for confidence scoring functions.
 *
 * onboarding.cv.service cannot import confidence.service directly per
 * governance Doc 08 — Dependency Rules.
 */

const confidenceService = require('./confidence.service');

module.exports = confidenceService;
