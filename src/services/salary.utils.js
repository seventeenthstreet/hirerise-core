'use strict';

/**
 * src/services/salary.utils.js
 *
 * Utility re-export for salary functions.
 *
 * careerIntelligence.service cannot import salary.service directly per
 * governance Doc 08 — Dependency Rules.
 */

const salaryService = require('./salary.service');

module.exports = salaryService;
