'use strict';

/**
 * salaryAggregation.service.js — Salary Intelligence Aggregation Engine
 *
 * PERFORMANCE UPGRADE: Results are now cached in-memory using node-cache.
 * Cache key: salary:<roleId>:<filtersJSON>
 * TTL:       SALARY_CACHE_TTL_SECONDS (default 300s)
 *
 * Cache is invalidated automatically when a new salary_data record is
 * inserted (salary.repository.js calls invalidateSalaryCache after insert).
 *
 * Aggregation Rules (unchanged):
 *   minSalary    = lowest(minSalary) across all records for roleId
 *   medianSalary = confidence-weighted average of medianSalary values
 *   maxSalary    = highest(maxSalary) across all records for roleId
 *
 * @module modules/salary/salaryAggregation.service
 */

const salaryRepository = require('./salary.repository');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { getCachedSalary, setCachedSalary } = require('../../utils/salaryCache');
const logger = require('../../utils/logger');

const SOURCE_CONFIDENCE_DEFAULTS = {
  ADMIN:   1.0,
  API:     0.9,
  CSV:     0.8,
  SCRAPER: 0.6,
};

/**
 * Aggregate salary data for a roleId.
 * Checks cache first — only queries Firestore on cache miss.
 *
 * @param {string} roleId
 * @param {{ location?: string, experienceLevel?: string, industry?: string }} [filters]
 * @returns {Promise<object>}
 */
async function aggregateSalaries(roleId, filters = {}) {
  if (!roleId || typeof roleId !== 'string') {
    throw new AppError('roleId is required', 400, null, ErrorCodes.VALIDATION_ERROR);
  }

  // ── 1. Cache check ──────────────────────────────────────────────────────────
  const cached = getCachedSalary(roleId, filters);
  if (cached) {
    logger.info('[SalaryAggregation] Returning cached result', { roleId, filters });
    return { ...cached, cached: true };
  }

  // ── 2. Firestore query ──────────────────────────────────────────────────────
  const records = await salaryRepository.findByRoleIdWithFilters(roleId, filters);

  if (records.length === 0) {
    // FIX: Return static benchmark instead of hard 404 when Firestore salary_data
    // collection has no records for this role. Prevents dashboard salary widget
    // from crashing on first load before salary data is seeded.
    const STATIC_BENCHMARKS = {
      // Finance & Accounting (INR annual)
      'Accountant':            { min: 300000,  median: 550000,   max: 900000   },
      'Senior Accountant':     { min: 600000,  median: 900000,   max: 1400000  },
      'Junior Accountant':     { min: 240000,  median: 360000,   max: 540000   },
      'Financial Analyst':     { min: 400000,  median: 700000,   max: 1100000  },
      'Finance Manager':       { min: 900000,  median: 1400000,  max: 2200000  },
      'Tax Consultant':        { min: 350000,  median: 600000,   max: 950000   },
      'Auditor':               { min: 350000,  median: 650000,   max: 1000000  },
      'Chartered Accountant':  { min: 600000,  median: 1000000,  max: 1800000  },
      // Technology
      'Software Engineer':     { min: 500000,  median: 900000,   max: 1600000  },
      'Senior Software Engineer': { min: 1000000, median: 1600000, max: 2600000 },
      'Data Analyst':          { min: 350000,  median: 650000,   max: 1100000  },
      'Data Scientist':        { min: 600000,  median: 1100000,  max: 2000000  },
      'DevOps Engineer':       { min: 600000,  median: 1100000,  max: 1900000  },
      'Product Manager':       { min: 800000,  median: 1500000,  max: 2800000  },
      'Engineering Manager':   { min: 1500000, median: 2500000,  max: 4000000  },
      // Management & Other
      'HR Manager':            { min: 400000,  median: 700000,   max: 1200000  },
      'Marketing Manager':     { min: 400000,  median: 700000,   max: 1300000  },
      'Sales Manager':         { min: 500000,  median: 900000,   max: 1600000  },
      'Project Manager':       { min: 600000,  median: 1000000,  max: 1800000  },
    };

    const fallback = STATIC_BENCHMARKS[roleId];
    if (fallback) {
      logger.info('[SalaryAggregation] Returning static benchmark', { roleId });
      const staticResult = {
        roleId,
        minSalary:    fallback.min,
        medianSalary: fallback.median,
        maxSalary:    fallback.max,
        sourceCount:  0,
        breakdown:    [],
        cached:       false,
        isStatic:     true,
      };
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
    recordCount: records.length,
    filters,
  });

  // ── 3. Aggregation ──────────────────────────────────────────────────────────
  const scored = records.map(r => ({
    ...r,
    resolvedConfidence: r.confidenceScore
      ?? SOURCE_CONFIDENCE_DEFAULTS[r.sourceType]
      ?? 0.7,
  }));

  const minSalary    = Math.min(...scored.map(r => r.minSalary));
  const maxSalary    = Math.max(...scored.map(r => r.maxSalary));
  const totalWeight  = scored.reduce((sum, r) => sum + r.resolvedConfidence, 0);
  const weightedSum  = scored.reduce((sum, r) => sum + (r.medianSalary * r.resolvedConfidence), 0);
  const medianSalary = totalWeight > 0
    ? Math.round(weightedSum / totalWeight)
    : Math.round(scored.reduce((s, r) => s + r.medianSalary, 0) / scored.length);

  const sourceMap = {};
  for (const r of scored) {
    sourceMap[r.sourceType] = (sourceMap[r.sourceType] || 0) + 1;
  }
  const breakdown = Object.entries(sourceMap).map(([sourceType, count]) => ({ sourceType, count }));

  const result = {
    roleId,
    minSalary,
    medianSalary,
    maxSalary,
    sourceCount: records.length,
    breakdown,
    cached: false,
  };

  // ── 4. Store in cache ───────────────────────────────────────────────────────
  setCachedSalary(roleId, filters, result);

  return result;
}

module.exports = { aggregateSalaries };








