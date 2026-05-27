'use strict';

/**
 * src/services/timeEstimator.utils.js
 *
 * Utility re-export for time estimation functions.
 *
 * careerPath.service cannot import timeEstimator.service directly per
 * governance Doc 08 — Dependency Rules.
 */

const timeEstimatorService = require('./timeEstimator.service');

module.exports = timeEstimatorService;
