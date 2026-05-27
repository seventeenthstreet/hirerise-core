'use strict';

/**
 * src/services/readiness.utils.js
 *
 * Utility re-export for readiness assessment functions.
 *
 * careerPath.service cannot import readiness.service directly per governance
 * Doc 08 — Dependency Rules.
 */

const readinessService = require('./readiness.service');

module.exports = readinessService;
