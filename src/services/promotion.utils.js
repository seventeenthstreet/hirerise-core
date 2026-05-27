'use strict';

/**
 * src/services/promotion.utils.js
 *
 * Utility re-export for promotion assessment functions.
 *
 * careerPath.service cannot import promotion.service directly per governance
 * Doc 08 — Dependency Rules.
 */

const promotionService = require('./promotion.service');

module.exports = promotionService;
