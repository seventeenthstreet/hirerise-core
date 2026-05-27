'use strict';

/**
 * src/services/quality.utils.js
 *
 * Utility re-export for CV quality assessment functions.
 *
 * onboarding.cv.service cannot import quality.service directly per
 * governance Doc 08 — Dependency Rules.
 */

const qualityService = require('./quality.service');

module.exports = qualityService;
