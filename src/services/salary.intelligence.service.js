'use strict';

/**
 * salary.intelligence.service.js
 * Production-hardened for Supabase migration path.
 */

const SalaryBandRepository = require('../repositories/SalaryBandRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// ----------------------------------------------------------------
// Static fallback salary table (India INR)
// ----------------------------------------------------------------
const STATIC_SALARY_TABLE = {
  accountant:           { L1:{min:240000,median:360000,max:540000},  L2:{min:360000,median:500000,max:700000},  L3:{min:500000,median:700000,max:950000},   L4:{min:700000,median:950000,max:1300000},  L5:{min:950000,median:1300000,max:1800000},  L6:{min:1300000,median:1800000,max:2500000} },
  'software engineer': { L1:{min:400000,median:600000,max:900000},  L2:{min:600000,median:900000,max:1300000}, L3:{min:900000,median:1300000,max:1900000},  L4:{min:1300000,median:1900000,max:2800000}, L5:{min:1900000,median:2800000,max:4000000}, L6:{min:2800000,median:4000000,max:6000000} },
  'product manager':   { L1:{min:600000,median:950000,max:1500000}, L2:{min:950000,median:1500000,max:2300000},L3:{min:1500000,median:2300000,max:3500000}, L4:{min:2300000,median:3500000,max:5500000}, L5:{min:3500000,median:5500000,max:8000000}, L6:{min:5500000,median:8000000,max:12000000} },
  'data scientist':    { L1:{min:500000,median:800000,max:1200000}, L2:{min:800000,median:1200000,max:1800000},L3:{min:1200000,median:1800000,max:2700000}, L4:{min:1800000,median:2700000,max:4000000}, L5:{min:2700000,median:4000000,max:6000000}, L6:{min:4000000,median:6000000,max:9000000} },
};

class SalaryIntelligenceService {
  constructor() {
    this.salaryBandRepo = new SalaryBandRepository();
  }

  normalizeYears(value) {
    const years = Number(value);
    return Number.isFinite(years) && years >= 0 ? years : 0;
  }

  mapExperienceToLevel(years) {
    const safeYears = this.normalizeYears(years);

    if (safeYears <= 2) return 'L1';
    if (safeYears <= 4) return 'L2';
    if (safeYears <= 7) return 'L3';
    if (safeYears <= 12) return 'L4';
    if (safeYears <= 18) return 'L5';
    return 'L6';
  }

  getIndustryMultiplier(industry) {
    const multipliers = {
      Service: 1,
      Product: 1.25,
      Startup: 1.15,
      MNC: 1.35,
    };

    return multipliers[industry] || 1;
  }

  calculatePercentile(userSalary, min, max) {
    const salary = Number(userSalary);

    if (!Number.isFinite(salary) || max <= min) {
      return null;
    }

    const percentile = ((salary - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, Math.round(percentile)));
  }

  async getSalaryBand(roleId, level) {
    try {
      const dbBand = await this.salaryBandRepo.findByRoleId(roleId);

      if (dbBand?.levels?.[level]) {
        return {
          ...dbBand.levels[level],
          _fromDatabase: true,
        };
      }
    } catch (_) {
      // silent fallback to static table
    }

    const key = String(roleId || '').toLowerCase().trim();
    const staticLevels = STATIC_SALARY_TABLE[key];

    if (staticLevels?.[level]) {
      return {
        ...staticLevels[level],
        _fromDatabase: false,
      };
    }

    return null;
  }

  async generateIntelligence({
    roleId,
    experienceYears,
    location,
    industry,
    currentSalary,
  }) {
    const level = this.mapExperienceToLevel(experienceYears);
    const safeLocation = location || 'metro';
    const safeIndustry =
      typeof industry === 'string' ? industry : null;

    const levelData = await this.getSalaryBand(roleId, level);

    if (!levelData) {
      throw new AppError(
        `Salary data not available for role '${roleId}' at level ${level}`,
        404,
        { roleId, level, experienceYears },
        ErrorCodes.SALARY_BAND_NOT_FOUND
      );
    }

    const multiplier = this.getIndustryMultiplier(safeIndustry);

    const adjustedMin = Math.round(levelData.min * multiplier);
    const adjustedMedian = Math.round(levelData.median * multiplier);
    const adjustedMax = Math.round(levelData.max * multiplier);

    const percentile = this.calculatePercentile(
      currentSalary,
      adjustedMin,
      adjustedMax
    );

    const safeCurrentSalary = Number.isFinite(Number(currentSalary))
      ? Number(currentSalary)
      : null;

    const salaryGap =
      safeCurrentSalary !== null
        ? adjustedMedian - safeCurrentSalary
        : null;

    return {
      roleId,
      level,
      location: safeLocation,
      industry: safeIndustry,
      salaryRange: {
        min: adjustedMin,
        median: adjustedMedian,
        max: adjustedMax,
      },
      marketMedian: adjustedMedian,
      marketP25: Math.round(adjustedMin * 1.05),
      marketP75: Math.round(adjustedMax * 0.95),
      marketP10: adjustedMin,
      marketP90: adjustedMax,
      yourEstimate: safeCurrentSalary,
      currentSalary: safeCurrentSalary,
      salaryGap,
      percentile,
      userPosition:
        percentile !== null
          ? {
              percentile,
              marketPosition:
                percentile < 40
                  ? 'Below Market'
                  : percentile < 70
                    ? 'Average'
                    : 'Above Market',
            }
          : null,
      currency: 'INR',
      isStatic: !levelData._fromDatabase,
    };
  }
}

module.exports = SalaryIntelligenceService;