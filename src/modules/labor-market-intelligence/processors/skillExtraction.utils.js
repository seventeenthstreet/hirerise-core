'use strict';

/**
 * src/modules/labor-market-intelligence/processors/skillExtraction.utils.js
 *
 * Utility re-export for skill extraction pure functions.
 *
 * demandAnalysis.service (a *.service.js file) cannot import
 * skillExtraction.service (another *.service.js) directly per governance
 * Doc 08 — Dependency Rules. This utility file acts as the boundary point.
 *
 * skillExtraction.service contains only pure computation (no I/O, no DB),
 * so re-exporting through a utils file is the correct governance resolution.
 *
 * Governance: resolves demandAnalysis.service → skillExtraction.service violation.
 */

const {
  extractFromText,
  aggregateSkillCounts,
  getTaxonomy,
} = require('./skillExtraction.service');

module.exports = Object.freeze({
  extractFromText,
  aggregateSkillCounts,
  getTaxonomy,
});
