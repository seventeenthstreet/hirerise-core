'use strict';

/**
 * src/modules/salary/salary.aggregation.js
 *
 * Utility re-export for the salary aggregation function.
 *
 * salary.service (a *.service.js file) cannot import salaryAggregation.service
 * (another *.service.js) directly per governance Doc 08 — Dependency Rules.
 * This utility file acts as the boundary crossing point.
 *
 * Governance: resolves salary.service → salaryAggregation.service violation.
 */

const { aggregateSalaries } = require('./salaryAggregation.service');

module.exports = { aggregateSalaries };
