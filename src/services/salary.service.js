'use strict';

/**
 * salary.service.js
 * Final production-ready international salary service.
 * RPC-first + country-aware + local currency conversion.
 */

const supabase = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const COUNTRY_CONFIG = {
  IN: { name: 'India', currency: 'INR', symbol: '\u20B9', locale: 'en-IN', multiplierFromINR: 1.0, tiers: { metro: 1, tier1: 0.88, tier2: 0.78, tier3: 0.68 } },
  US: { name: 'United States', currency: 'USD', symbol: '$', locale: 'en-US', multiplierFromINR: 0.012, tiers: { metro: 1, tier1: 0.9, tier2: 0.8, tier3: 0.7 } },
  GB: { name: 'United Kingdom', currency: 'GBP', symbol: '\u00A3', locale: 'en-GB', multiplierFromINR: 0.0095, tiers: { metro: 1, tier1: 0.85, tier2: 0.75, tier3: 0.65 } },
  AE: { name: 'UAE', currency: 'AED', symbol: '\u062F.\u0625', locale: 'ar-AE', multiplierFromINR: 0.044, tiers: { metro: 1, tier1: 0.9, tier2: 0.85, tier3: 0.8 } },
};

const DEFAULT_EXPERIENCE_BANDS = [
  { level: 'L1', label: 'Associate', minYears: 0, maxYears: 2 },
  { level: 'L2', label: 'Junior', minYears: 2, maxYears: 4 },
  { level: 'L3', label: 'Mid-level', minYears: 4, maxYears: 7 },
  { level: 'L4', label: 'Senior', minYears: 7, maxYears: 12 },
  { level: 'L5', label: 'Staff / Lead', minYears: 12, maxYears: 18 },
  { level: 'L6', label: 'Principal / Manager', minYears: 18, maxYears: 60 },
];

const LOCATION_TO_COUNTRY = {
  india: 'IN',
  bangalore: 'IN',
  bengaluru: 'IN',
  dubai: 'AE',
  uae: 'AE',
  usa: 'US',
  us: 'US',
  london: 'GB',
  uk: 'GB',
};

function resolveLevelForExperience(experienceYears) {
  const safeYears = Number(experienceYears);
  if (!Number.isFinite(safeYears) || safeYears < 0) {
    throw new AppError(
      'experienceYears must be a non-negative number',
      400,
      { experienceYears },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return (
    DEFAULT_EXPERIENCE_BANDS.find(
      (b) => safeYears >= b.minYears && safeYears < b.maxYears
    ) || DEFAULT_EXPERIENCE_BANDS[DEFAULT_EXPERIENCE_BANDS.length - 1]
  );
}

function detectUserCountry(parsedData) {
  const defaultCountry = (
    process.env.DEFAULT_SALARY_COUNTRY || 'IN'
  ).toUpperCase();

  if (!parsedData?.location) return defaultCountry;

  const loc = parsedData.location;
  const searchStr =
    typeof loc === 'object'
      ? [loc.country, loc.city].filter(Boolean).join(' ').toLowerCase()
      : String(loc).toLowerCase();

  for (const [key, code] of Object.entries(LOCATION_TO_COUNTRY)) {
    if (searchStr.includes(key)) return code;
  }

  logger.debug('[salary.service] country fallback used', {
    location: loc,
    defaultCountry,
  });

  return defaultCountry;
}

function convertSalaryForCountry(inrAmount, countryCode) {
  const config = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG.IN;
  return Math.round(inrAmount * config.multiplierFromINR);
}

function formatSalaryRange(inrBand, countryCode) {
  const config = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG.IN;

  const converted = {
    min: convertSalaryForCountry(inrBand.min, countryCode),
    median: convertSalaryForCountry(inrBand.median, countryCode),
    max: convertSalaryForCountry(inrBand.max, countryCode),
  };

  return {
    ...converted,
    currency: config.currency,
    symbol: config.symbol,
    monthly: {
      min: Math.round(converted.min / 12),
      median: Math.round(converted.median / 12),
      max: Math.round(converted.max / 12),
    },
  };
}

async function fetchSalaryBand(roleId, level, region = null) {
  const { data, error } = await supabase.rpc('get_salary_band', {
    p_role_id: roleId,
    p_level: level,
    p_region: region,
  });

  if (error) {
    throw new AppError(
      `Salary lookup failed for '${roleId}'`,
      500,
      { roleId, level, region },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return data?.[0] || null;
}

async function computeBenchmark({
  roleId,
  experienceYears,
  location = 'metro',
  region = null,
}) {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const resolvedLevel = resolveLevelForExperience(experienceYears);

  const salaryBand = await fetchSalaryBand(
    roleId,
    resolvedLevel.level,
    region
  );

  if (!salaryBand) {
    throw new AppError(
      `Salary band not found for role '${roleId}'`,
      404,
      { roleId, level: resolvedLevel.level },
      ErrorCodes.SALARY_BAND_NOT_FOUND
    );
  }

  return {
    role: {
      id: roleId,
      title: roleId,
    },
    recommendedLevel: resolvedLevel.level,
    levelLabel: resolvedLevel.label,
    experienceYears,
    salaryRange: {
      min: salaryBand.min_salary,
      median: salaryBand.median_salary,
      max: salaryBand.max_salary,
    },
    monthlyEstimate: {
      min: Math.round(salaryBand.min_salary / 12),
      median: Math.round(salaryBand.median_salary / 12),
      max: Math.round(salaryBand.max_salary / 12),
    },
    currency: salaryBand.currency || 'INR',
    region: salaryBand.region,
    source: salaryBand.source,
    isStatic: salaryBand.source === 'static_seed',
  };
}

async function computeBenchmarkForUser({
  roleId,
  parsedData,
  experienceYears,
  location = 'metro',
  userCurrentSalaryINR = null,
}) {
  const countryCode = detectUserCountry(parsedData);
  const benchmark = await computeBenchmark({
    roleId,
    experienceYears,
    location,
    region: parsedData?.region || null,
  });

  const localSalary = formatSalaryRange(
    benchmark.salaryRange,
    countryCode
  );

  return {
    ...benchmark,
    salaryRange: {
      ...benchmark.salaryRange,
      ...localSalary,
    },
    monthlyEstimate: localSalary.monthly,
    currency: localSalary.currency,
    currencySymbol: localSalary.symbol,
    country: countryCode,
    salaryRangeINR: benchmark.salaryRange,
    locationComparison:
      userCurrentSalaryINR && benchmark.salaryRange?.median
        ? `${Math.round(
            ((userCurrentSalaryINR -
              benchmark.salaryRange.median) /
              benchmark.salaryRange.median) *
              100
          )}% vs market median`
        : null,
  };
}

module.exports = {
  computeBenchmark,
  computeBenchmarkForUser,
  detectUserCountry,
  convertSalaryForCountry,
  formatSalaryRange,
  COUNTRY_CONFIG,
};