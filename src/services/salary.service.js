/**
 * salary.service.js — Salary Benchmark Intelligence Engine (Enterprise Hardened)
 *
 * Enterprise Guarantees:
 *   - Repository pattern only (no direct Firestore access)
 *   - Input validation
 *   - Soft-delete safe
 *   - Timestamp conversion safe
 *   - Scalable parallel fetch
 *   - Cache-ready
 */

'use strict';

const RoleRepository = require('../repositories/RoleRepository');
const SalaryBandRepository = require('../repositories/SalaryBandRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const roleRepo = new RoleRepository();
const salaryRepo = new SalaryBandRepository();

// ─────────────────────────────────────────────────────────────
// Location multipliers (India-focused)
// ─────────────────────────────────────────────────────────────
const LOCATION_MULTIPLIERS = {
  metro: 1.00,
  tier1: 0.88,
  tier2: 0.78,
  tier3: 0.68,
};

// ─────────────────────────────────────────────────────────────
// Default experience bands fallback
// ─────────────────────────────────────────────────────────────
const DEFAULT_EXPERIENCE_BANDS = [
  { level: 'L1', label: 'Associate', minYears: 0, maxYears: 2 },
  { level: 'L2', label: 'Junior', minYears: 2, maxYears: 4 },
  { level: 'L3', label: 'Mid-level', minYears: 4, maxYears: 7 },
  { level: 'L4', label: 'Senior', minYears: 7, maxYears: 12 },
  { level: 'L5', label: 'Staff / Lead', minYears: 12, maxYears: 18 },
  { level: 'L6', label: 'Principal / Manager', minYears: 18, maxYears: 60 },
];

// ─────────────────────────────────────────────────────────────
// Helper: resolve level from experience
// ─────────────────────────────────────────────────────────────
const resolveLevelForExperience = (experienceYears, customBands) => {
  const bands =
    Array.isArray(customBands) && customBands.length > 0
      ? customBands
      : DEFAULT_EXPERIENCE_BANDS;

  const matched = bands.find(
    b => experienceYears >= b.minYears && experienceYears < b.maxYears
  );

  return matched || bands[bands.length - 1];
};

// ─────────────────────────────────────────────────────────────
// Helper: apply location multiplier
// ─────────────────────────────────────────────────────────────
const applyLocationAndMonthly = (salaryBand, location) => {
  const safeLocation = LOCATION_MULTIPLIERS[location] ? location : 'metro';
  const multiplier = LOCATION_MULTIPLIERS[safeLocation];

  const adjusted = {
    min: Math.round(salaryBand.min * multiplier),
    max: Math.round(salaryBand.max * multiplier),
    median: Math.round(salaryBand.median * multiplier),
  };

  return {
    ...adjusted,
    monthly: {
      min: Math.round(adjusted.min / 12),
      max: Math.round(adjusted.max / 12),
      median: Math.round(adjusted.median / 12),
    },
    currency: 'INR',
    locationMultiplier: multiplier,
    locationCategory: safeLocation,
  };
};

// ═════════════════════════════════════════════════════════════
// PUBLIC: computeBenchmark
// ═════════════════════════════════════════════════════════════
const computeBenchmark = async ({ roleId, experienceYears, location = 'metro' }) => {
  // ── Input validation ───────────────────────────────────────
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (typeof experienceYears !== 'number' || experienceYears < 0) {
    throw new AppError(
      'experienceYears must be a non-negative number',
      400,
      { experienceYears },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.debug('[SalaryService] computeBenchmark start', {
    roleId,
    experienceYears,
    location,
  });

  // ── Parallel fetch ─────────────────────────────────────────
  const [role, bandDoc] = await Promise.all([
    roleRepo.findById(roleId),
    salaryRepo.findByRoleId(roleId),
  ]);

  if (!role) {
    throw new AppError(
      `Role '${roleId}' not found`,
      404,
      { roleId },
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  if (!bandDoc) {
    throw new AppError(
      `Salary band data not available for role '${roleId}'`,
      404,
      { roleId },
      ErrorCodes.SALARY_BAND_NOT_FOUND
    );
  }

  // ── Resolve level ─────────────────────────────────────────
  const resolvedLevel = resolveLevelForExperience(
    experienceYears,
    role.customExperienceBands
  );

  const levelBandData = bandDoc.levels?.[resolvedLevel.level];

  if (!levelBandData) {
    throw new AppError(
      `Salary data for level ${resolvedLevel.level} not found in role '${roleId}'`,
      422,
      { roleId, level: resolvedLevel.level },
      ErrorCodes.SALARY_BAND_NOT_FOUND
    );
  }

  // ── Apply location adjustment ─────────────────────────────
  const adjustedSalary = applyLocationAndMonthly(levelBandData, location);

  // ── Percentiles (if available) ────────────────────────────
  const percentileRanges = levelBandData.percentiles
    ? Object.entries(levelBandData.percentiles).reduce((acc, [p, val]) => {
        acc[p] = {
          annual: Math.round(val * adjustedSalary.locationMultiplier),
          monthly: Math.round((val * adjustedSalary.locationMultiplier) / 12),
        };
        return acc;
      }, {})
    : null;

  // ── Market positioning ────────────────────────────────────
  const bandRange = resolvedLevel.maxYears - resolvedLevel.minYears;
  const positionInBand =
    bandRange > 0
      ? (experienceYears - resolvedLevel.minYears) / bandRange
      : 0;

  const marketPosition =
    positionInBand < 0.33
      ? 'entry'
      : positionInBand < 0.66
        ? 'mid'
        : 'senior';

  const result = {
    role: {
      id: role.id,
      title: role.title,
      jobFamily: role.jobFamilyId,
      track: role.track || 'individual_contributor',
    },
    recommendedLevel: resolvedLevel.level,
    levelLabel: resolvedLevel.label,
    experienceYears,
    salaryRange: {
      min: adjustedSalary.min,
      max: adjustedSalary.max,
      median: adjustedSalary.median,
    },
    monthlyEstimate: adjustedSalary.monthly,
    ...(percentileRanges && { percentileRanges }),
    marketPosition,
    locationAdjustment: {
      category: adjustedSalary.locationCategory,
      multiplier: adjustedSalary.locationMultiplier,
      note: `Salary adjusted for ${location} India market rates`,
    },
    currency: 'INR',
    dataAsOf: bandDoc.updatedAt?.toDate?.()?.toISOString?.() || null,
  };

  logger.debug('[SalaryService] computeBenchmark complete', {
    roleId,
    level: resolvedLevel.level,
  });

  return result;
};

// ═════════════════════════════════════════════════════════════
// PUBLIC: getAllBandsForRole
// ═════════════════════════════════════════════════════════════
const getAllBandsForRole = async (roleId) => {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const [role, bandDoc] = await Promise.all([
    roleRepo.findById(roleId),
    salaryRepo.findByRoleId(roleId),
  ]);

  if (!role || !bandDoc) {
    throw new AppError(
      `Salary progression data unavailable for role '${roleId}'`,
      404,
      { roleId },
      ErrorCodes.SALARY_BAND_NOT_FOUND
    );
  }

  const levels = Object.entries(bandDoc.levels || {}).map(([levelCode, data]) => {
    const experienceBand = DEFAULT_EXPERIENCE_BANDS.find(b => b.level === levelCode);
    return {
      level: levelCode,
      label: experienceBand?.label || levelCode,
      minYears: experienceBand?.minYears,
      maxYears: experienceBand?.maxYears,
      salary: {
        min: data.min,
        max: data.max,
        median: data.median,
      },
      monthly: {
        min: Math.round(data.min / 12),
        max: Math.round(data.max / 12),
        median: Math.round(data.median / 12),
      },
    };
  });

  const levelOrder = DEFAULT_EXPERIENCE_BANDS.map(b => b.level);
  levels.sort((a, b) => levelOrder.indexOf(a.level) - levelOrder.indexOf(b.level));

  return {
    role: {
      id: role.id,
      title: role.title,
    },
    levels,
    currency: 'INR',
    dataAsOf: bandDoc.updatedAt?.toDate?.()?.toISOString?.() || null,
  };
};

// ═════════════════════════════════════════════════════════════
// PUBLIC: compareRoles
// ═════════════════════════════════════════════════════════════
const compareRoles = async ({ roleIds, experienceYears }) => {
  if (!Array.isArray(roleIds) || roleIds.length === 0) {
    throw new AppError(
      'roleIds must be a non-empty array',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (roleIds.length > 20) {
    throw new AppError(
      'Maximum 20 roles allowed for comparison',
      400,
      { count: roleIds.length },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const benchmarks = await Promise.all(
    roleIds.map(roleId =>
      computeBenchmark({
        roleId,
        experienceYears: experienceYears ?? 3,
        location: 'metro',
      }).catch(err => ({
        roleId,
        error: err.message,
        unavailable: true,
      }))
    )
  );

  const successful = benchmarks.filter(b => !b.unavailable);
  const failed = benchmarks.filter(b => b.unavailable);

  const ranked = [...successful].sort(
    (a, b) => (b.salaryRange?.median || 0) - (a.salaryRange?.median || 0)
  );

  return {
    comparison: ranked,
    unavailableRoles: failed.map(f => f.roleId),
    experienceYearsUsed: experienceYears ?? 3,
    meta: {
      highestPayingRole: ranked[0]?.role?.title || null,
      lowestPayingRole: ranked[ranked.length - 1]?.role?.title || null,
      salarySpread:
        ranked.length >= 2
          ? ranked[0].salaryRange.median -
            ranked[ranked.length - 1].salaryRange.median
          : 0,
    },
  };
};
// ═════════════════════════════════════════════════════════════
// PUBLIC: updateSalaryBands (Admin Only)
// ═════════════════════════════════════════════════════════════
const updateSalaryBands = async (roleId, updatePayload) => {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.info('[SalaryService] updateSalaryBands start', { roleId });

  // Update via repository (maintains enterprise pattern)
  const updated = await salaryRepo.updateByRoleId(roleId, updatePayload);

  if (!updated) {
    throw new AppError(
      `Failed to update salary data for role '${roleId}'`,
      500,
      { roleId },
      ErrorCodes.INTERNAL_SERVER_ERROR
    );
  }

  /**
   * -------------------------------------------------
   * 🛡 AUTO ROLE CACHE INVALIDATION
   * -------------------------------------------------
   * Lazy require to prevent circular dependency
   */
  try {
    const { invalidateRoleCache } = require('./careerIntelligence.service');
    invalidateRoleCache(roleId);

    logger.info('[SalaryService] cache invalidated for role', { roleId });
  } catch (err) {
    logger.error('[SalaryService] cache invalidation failed', {
      roleId,
      error: err.message,
    });
  }

  return {
    success: true,
    message: 'Salary bands updated and related intelligence cache invalidated',
    data: updated,
  };
};


module.exports = {
  computeBenchmark,
  getAllBandsForRole,
  compareRoles,
  updateSalaryBands, // 🔥 new
};
