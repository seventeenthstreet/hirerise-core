'use strict';

/**
 * salary.intelligence.service.js
 *
 * CHANGES (remediation sprint):
 *   FIX-7: Expanded mapExperienceToLevel() from 3 levels (L1-L3) to 6 levels (L1-L6)
 *           matching the platform Firestore schema.
 *           Old mapping: L1 (<=2yr), L2 (<=5yr), L3 (everything else)
 *           New mapping: L1 (0-2), L2 (2-4), L3 (4-7), L4 (7-12), L5 (12-18), L6 (18+)
 *
 *           Impact: All salary intelligence requests for senior users (>5 years exp)
 *           were failing with "Salary band not found for level: L3" because the
 *           Firestore salary docs only have L4-L6 data for senior roles.
 *           This fix also converts the thrown Error to AppError so the central
 *           errorHandler returns the correct status + errorCode envelope.
 */

const SalaryBandRepository          = require('../repositories/SalaryBandRepository');
const { AppError, ErrorCodes }       = require('../middleware/errorHandler');

class SalaryIntelligenceService {
  constructor() {
    this.salaryBandRepo = new SalaryBandRepository();
  }

  /**
   * Maps raw years of experience to the platform salary band level (L1-L6).
   *
   * Level definitions (aligned with Firestore salary band schema):
   *   L1: 0–2 years   (Junior)
   *   L2: >2–4 years  (Mid-Junior)
   *   L3: >4–7 years  (Mid)
   *   L4: >7–12 years (Senior)
   *   L5: >12–18 yrs  (Staff / Principal)
   *   L6: >18 years   (Distinguished / Fellow)
   */
  mapExperienceToLevel(years) {
    if (years <= 2)  return 'L1';
    if (years <= 4)  return 'L2';
    if (years <= 7)  return 'L3';
    if (years <= 12) return 'L4';
    if (years <= 18) return 'L5';
    return 'L6';
  }

  getIndustryMultiplier(industry) {
    const multipliers = {
      Service: 1,
      Product: 1.25,
      Startup: 1.15,
      MNC:     1.35,
    };
    return multipliers[industry] || 1;
  }

  calculatePercentile(userSalary, min, max) {
    if (!userSalary || max === min) return null;
    const percentile = ((userSalary - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, Math.round(percentile)));
  }

  async generateIntelligence({ roleId, experienceYears, location, industry, currentSalary }) {
    const level = this.mapExperienceToLevel(experienceYears);

    const roleBandDoc = await this.salaryBandRepo.findByRoleId(roleId);

    if (!roleBandDoc) {
      throw new AppError(
        `Salary band document not found for role '${roleId}'`,
        404,
        { roleId },
        ErrorCodes.SALARY_BAND_NOT_FOUND
      );
    }

    if (!roleBandDoc.levels || !roleBandDoc.levels[level]) {
      throw new AppError(
        `Salary band not found for level ${level} (${experienceYears} years experience)`,
        404,
        { roleId, level, experienceYears },
        ErrorCodes.SALARY_BAND_NOT_FOUND
      );
    }

    const levelData   = roleBandDoc.levels[level];
    const multiplier  = this.getIndustryMultiplier(industry);

    const adjustedMin    = Math.round(levelData.min    * multiplier);
    const adjustedMedian = Math.round(levelData.median * multiplier);
    const adjustedMax    = Math.round(levelData.max    * multiplier);

    const percentile = this.calculatePercentile(currentSalary, adjustedMin, adjustedMax);

    const salaryGap = typeof currentSalary === 'number'
      ? adjustedMedian - currentSalary
      : null;

    return {
      roleId,
      level,
      location,
      industry: industry || null,
      salaryRange: {
        min:    adjustedMin,
        median: adjustedMedian,
        max:    adjustedMax,
      },
      userPosition: percentile !== null ? {
        percentile,
        marketPosition: percentile < 40 ? 'Below Market' : percentile < 70 ? 'Average' : 'Above Market',
      } : null,
      salaryGap,
    };
  }
}

module.exports = SalaryIntelligenceService;
