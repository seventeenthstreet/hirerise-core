'use strict';

/**
 * src/services/resumeScore.utils.js
 *
 * Utility re-export for resumeScore functions.
 *
 * careerIntelligence.service cannot import resumeScore.service directly per
 * governance Doc 08 — Dependency Rules.
 */

const resumeScoreService = require('./resumeScore.service');

module.exports = resumeScoreService;
