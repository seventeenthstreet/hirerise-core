'use strict';

/**
 * src/modules/salary/salaryAggregation.service.js
 *
 * Salary Intelligence Aggregation Engine
 *
 * Supabase-native aggregation layer:
 * - cache-first reads
 * - median derived from min/max midpoint
 * - weighted confidence preserved
 * - static benchmark fallback preserved
 * - cleaner aggregation pipeline
 *
 * @module modules/salary/salaryAggregation.service
 */

const salaryRepository = require('./salary.repository');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');

const {
  getCachedSalary,
  setCachedSalary,
} = require('../../utils/salaryCache');

const logger = require('../../utils/logger');

const SOURCE_CONFIDENCE_DEFAULTS = {
  ADMIN: 1.0,
  API: 0.9,
  CSV: 0.8,
  SCRAPER: 0.6,
};

const STATIC_BENCHMARKS = {
  Accountant: { min: 300000, median: 550000, max: 900000 },
  'Senior Accountant': { min: 600000, median: 900000, max: 1400000 },
  'Junior Accountant': { min: 240000, median: 360000, max: 540000 },
  'Financial Analyst': { min: 400000, median: 700000, max: 1100000 },
  'Finance Manager': { min: 900000, median: 1400000, max: 2200000 },
  'Tax Consultant': { min: 350000, median: 600000, max: 950000 },
  Auditor: { min: 350000, median: 650000, max: 1000000 },
  'Chartered Accountant': { min: 600000, median: 1000000, max: 1800000 },

  'Software Engineer': { min: 500000, median: 900000, max: 1600000 },
  'Senior Software Engineer': {
    min: 1000000,
    median: 1600000,
    max: 2600000,
  },
  'Data Analyst': { min: 350000, median: 650000, max: 1100000 },
  'Data Scientist': { min: 600000, median: 1100000, max: 2000000 },
  'DevOps Engineer': { min: 600000, median: 1100000, max: 1900000 },
  'Product Manager': { min: 800000, median: 1500000, max: 2800000 },
  'Engineering Manager': {
    min: 1500000,
    median: 2500000,
    max: 4000000,
  },

  'HR Manager': { min: 400000, median: 700000, max: 1200000 },
  'Marketing Manager': { min: 400000, median: 700000, max: 1300000 },
  'Sales Manager': { min: 500000, median: 900000, max: 1600000 },
  'Project Manager': { min: 600000, median: 1000000, max: 1800000 },
};

function getResolvedConfidence(record) {
  return (
    record.confidenceScore ??
    SOURCE_CONFIDENCE_DEFAULTS[record.sourceType] ??
    0.7
  );
}

function getDerivedMedian(record) {
  return Math.round((record.minSalary + record.maxSalary) / 2);
}

/**
 * Aggregate salary data for a roleId.
 *
 * @param {string} roleId
 * @param {{ location?: string, experienceLevel?: string, industry?: string }} filters
 * @returns {Promise<object>}
 */
async function aggregateSalaries(roleId, filters = {}) {
  if (!roleId || typeof roleId !== 'string') {
    throw new AppError(
      'roleId is required',
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1) Cache lookup
  // ───────────────────────────────────────────────────────────────────────────
  const cached = getCachedSalary(roleId, filters);
  if (cached) {
    logger.info('[SalaryAggregation] Returning cached result', {
      roleId,
      filters,
    });

    return {
      ...cached,
      cached: true,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2) Repository fetch
  // ───────────────────────────────────────────────────────────────────────────
  const records = await salaryRepository.findByRoleIdWithFilters(
    roleId,
    filters
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 3) Static fallback
  // ───────────────────────────────────────────────────────────────────────────
  if (!records.length) {
    const fallback = STATIC_BENCHMARKS[roleId];

    if (fallback) {
      const staticResult = {
        roleId,
        minSalary: fallback.min,
        medianSalary: fallback.median,
        maxSalary: fallback.max,
        sourceCount: 0,
        breakdown: [],
        cached: false,
        isStatic: true,
      };

      logger.info('[SalaryAggregation] Returning static benchmark', {
        roleId,
      });

      setCachedSalary(roleId, filters, staticResult);

      return staticResult;
    }

    throw new AppError(
      `No salary data found for roleId: ${roleId}`,
      404,
      { roleId, filters },
      ErrorCodes.NOT_FOUND
    );
  }

  logger.info('[SalaryAggregation] Aggregating salary records', {
    roleId,
    filters,
    recordCount: records.length,
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4) Weighted aggregation
  // ───────────────────────────────────────────────────────────────────────────
  const enriched = records.map((record) => ({
    ...record,
    resolvedConfidence: getResolvedConfidence(record),
    derivedMedian: getDerivedMedian(record),
  }));

  const minSalary = Math.min(...enriched.map((r) => r.minSalary));
  const maxSalary = Math.max(...enriched.map((r) => r.maxSalary));

  const totalWeight = enriched.reduce(
    (sum, row) => sum + row.resolvedConfidence,
    0
  );

  const weightedMedianSum = enriched.reduce(
    (sum, row) => sum + row.derivedMedian * row.resolvedConfidence,
    0
  );

  const medianSalary =
    totalWeight > 0
      ? Math.round(weightedMedianSum / totalWeight)
      : Math.round(
          enriched.reduce((sum, row) => sum + row.derivedMedian, 0) /
            enriched.length
        );

  const sourceCounts = enriched.reduce((acc, row) => {
    acc[row.sourceType] = (acc[row.sourceType] || 0) + 1;
    return acc;
  }, {});

  const breakdown = Object.entries(sourceCounts).map(
    ([sourceType, count]) => ({
      sourceType,
      count,
    })
  );

  const result = {
    roleId,
    minSalary,
    medianSalary,
    maxSalary,
    sourceCount: records.length,
    breakdown,
    cached: false,
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 5) Cache write
  // ───────────────────────────────────────────────────────────────────────────
  setCachedSalary(roleId, filters, result);

  return result;
}

module.exports = {
  aggregateSalaries,
};