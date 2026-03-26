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
    // FIX: salary.intelligence.service was throwing immediately when no Firestore
    // salary band exists (common during initial setup). Now falls back to the
    // same STATIC_SALARY_TABLE used by salary.service.js so the widget always works.
    // Also normalises null values sent by the frontend to safe defaults.
    const safeIndustry      = (industry     && typeof industry     === 'string') ? industry     : null;
    const safeCurrentSalary = (currentSalary && typeof currentSalary === 'number') ? currentSalary : null;
    const safeLocation      = location || 'metro';

    const STATIC_SALARY_TABLE = {
      'accountant':           { L1:{min:240000,median:360000,max:540000},  L2:{min:360000,median:500000,max:700000},  L3:{min:500000,median:700000,max:950000},   L4:{min:700000,median:950000,max:1300000},  L5:{min:950000,median:1300000,max:1800000},  L6:{min:1300000,median:1800000,max:2500000}  },
      'senior accountant':    { L1:{min:480000,median:650000,max:850000},  L2:{min:650000,median:850000,max:1100000}, L3:{min:850000,median:1100000,max:1500000}, L4:{min:1100000,median:1500000,max:2000000}, L5:{min:1500000,median:2000000,max:2800000}, L6:{min:2000000,median:2800000,max:4000000}  },
      'junior accountant':    { L1:{min:180000,median:260000,max:360000},  L2:{min:260000,median:360000,max:480000},  L3:{min:360000,median:480000,max:650000},   L4:{min:480000,median:650000,max:900000},   L5:{min:650000,median:900000,max:1200000},   L6:{min:900000,median:1200000,max:1600000}   },
      'financial analyst':    { L1:{min:300000,median:450000,max:650000},  L2:{min:450000,median:650000,max:900000},  L3:{min:650000,median:900000,max:1200000},  L4:{min:900000,median:1200000,max:1700000},  L5:{min:1200000,median:1700000,max:2400000}, L6:{min:1700000,median:2400000,max:3200000}  },
      'finance manager':      { L1:{min:700000,median:950000,max:1300000}, L2:{min:950000,median:1300000,max:1800000},L3:{min:1300000,median:1800000,max:2500000}, L4:{min:1800000,median:2500000,max:3500000}, L5:{min:2500000,median:3500000,max:5000000}, L6:{min:3500000,median:5000000,max:7000000}  },
      'tax consultant':       { L1:{min:250000,median:380000,max:550000},  L2:{min:380000,median:550000,max:750000},  L3:{min:550000,median:750000,max:1000000},  L4:{min:750000,median:1000000,max:1400000},  L5:{min:1000000,median:1400000,max:2000000}, L6:{min:1400000,median:2000000,max:2800000}  },
      'auditor':              { L1:{min:280000,median:400000,max:580000},  L2:{min:400000,median:580000,max:800000},  L3:{min:580000,median:800000,max:1100000},  L4:{min:800000,median:1100000,max:1500000},  L5:{min:1100000,median:1500000,max:2100000}, L6:{min:1500000,median:2100000,max:3000000}  },
      'chartered accountant': { L1:{min:500000,median:750000,max:1100000}, L2:{min:750000,median:1100000,max:1600000},L3:{min:1100000,median:1600000,max:2200000}, L4:{min:1600000,median:2200000,max:3200000}, L5:{min:2200000,median:3200000,max:4500000}, L6:{min:3200000,median:4500000,max:6500000}  },
      'software engineer':    { L1:{min:400000,median:600000,max:900000},  L2:{min:600000,median:900000,max:1300000}, L3:{min:900000,median:1300000,max:1900000},  L4:{min:1300000,median:1900000,max:2800000}, L5:{min:1900000,median:2800000,max:4000000}, L6:{min:2800000,median:4000000,max:6000000}  },
      'data analyst':         { L1:{min:300000,median:480000,max:700000},  L2:{min:480000,median:700000,max:1000000}, L3:{min:700000,median:1000000,max:1500000},  L4:{min:1000000,median:1500000,max:2200000}, L5:{min:1500000,median:2200000,max:3200000}, L6:{min:2200000,median:3200000,max:4500000}  },
      'data scientist':       { L1:{min:500000,median:800000,max:1200000}, L2:{min:800000,median:1200000,max:1800000},L3:{min:1200000,median:1800000,max:2700000}, L4:{min:1800000,median:2700000,max:4000000}, L5:{min:2700000,median:4000000,max:6000000}, L6:{min:4000000,median:6000000,max:9000000}  },
      'devops engineer':      { L1:{min:450000,median:700000,max:1050000}, L2:{min:700000,median:1050000,max:1550000},L3:{min:1050000,median:1550000,max:2300000}, L4:{min:1550000,median:2300000,max:3400000}, L5:{min:2300000,median:3400000,max:5000000}, L6:{min:3400000,median:5000000,max:7000000}  },
      'product manager':      { L1:{min:600000,median:950000,max:1500000}, L2:{min:950000,median:1500000,max:2300000},L3:{min:1500000,median:2300000,max:3500000}, L4:{min:2300000,median:3500000,max:5500000}, L5:{min:3500000,median:5500000,max:8000000}, L6:{min:5500000,median:8000000,max:12000000} },
      'hr manager':           { L1:{min:350000,median:520000,max:750000},  L2:{min:520000,median:750000,max:1100000}, L3:{min:750000,median:1100000,max:1600000},  L4:{min:1100000,median:1600000,max:2300000}, L5:{min:1600000,median:2300000,max:3300000}, L6:{min:2300000,median:3300000,max:4800000}  },
      'marketing manager':    { L1:{min:350000,median:520000,max:780000},  L2:{min:520000,median:780000,max:1150000}, L3:{min:780000,median:1150000,max:1700000},  L4:{min:1150000,median:1700000,max:2500000}, L5:{min:1700000,median:2500000,max:3600000}, L6:{min:2500000,median:3600000,max:5200000}  },
      'project manager':      { L1:{min:450000,median:680000,max:1000000}, L2:{min:680000,median:1000000,max:1500000},L3:{min:1000000,median:1500000,max:2200000}, L4:{min:1500000,median:2200000,max:3200000}, L5:{min:2200000,median:3200000,max:4600000}, L6:{min:3200000,median:4600000,max:6500000}  },
    };

    const level = this.mapExperienceToLevel(experienceYears);

    // Try Firestore first
    let levelData = null;
    try {
      const roleBandDoc = await this.salaryBandRepo.findByRoleId(roleId);
      if (roleBandDoc?.levels?.[level]) {
        levelData = roleBandDoc.levels[level];
      }
    } catch (_) { /* fall through to static */ }

    // Static fallback — keyed by lowercase role name
    if (!levelData) {
      const key = (roleId || '').toLowerCase().trim();
      const staticLevels = STATIC_SALARY_TABLE[key];
      if (staticLevels?.[level]) {
        levelData = staticLevels[level];
      }
    }

    if (!levelData) {
      throw new AppError(
        `Salary data not available for role '${roleId}' at level ${level}`,
        404,
        { roleId, level, experienceYears },
        ErrorCodes.SALARY_BAND_NOT_FOUND
      );
    }

    const multiplier     = this.getIndustryMultiplier(safeIndustry);
    const adjustedMin    = Math.round(levelData.min    * multiplier);
    const adjustedMedian = Math.round(levelData.median * multiplier);
    const adjustedMax    = Math.round(levelData.max    * multiplier);

    const percentile = this.calculatePercentile(safeCurrentSalary, adjustedMin, adjustedMax);

    const salaryGap = typeof safeCurrentSalary === 'number'
      ? adjustedMedian - safeCurrentSalary
      : null;

    return {
      roleId,
      level,
      location:  safeLocation,
      industry:  safeIndustry,
      salaryRange: {
        min:    adjustedMin,
        median: adjustedMedian,
        max:    adjustedMax,
      },
      // Field aliases expected by the frontend SalaryIntelligenceResult interface
      marketMedian: adjustedMedian,
      marketP25:    Math.round(adjustedMin  * 1.05),
      marketP75:    Math.round(adjustedMax  * 0.95),
      marketP10:    adjustedMin,
      marketP90:    adjustedMax,
      yourEstimate: safeCurrentSalary,
      currentSalary: safeCurrentSalary,
      salaryGap,
      percentile:   percentile,
      userPosition: percentile !== null ? {
        percentile,
        marketPosition: percentile < 40 ? 'Below Market' : percentile < 70 ? 'Average' : 'Above Market',
      } : null,
      currency: 'INR',
      isStatic: !levelData._fromFirestore,
    };
  }
}

module.exports = SalaryIntelligenceService;








