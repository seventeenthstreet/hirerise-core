'use strict';

/**
 * salary.service.js — UPGRADED: International salary intelligence
 *
 * New capabilities added (all other logic unchanged):
 *
 *   1. detectUserCountry(parsedData)
 *      Reads country from resume parsedData.location.
 *      Falls back to process.env.DEFAULT_SALARY_COUNTRY → 'IN'.
 *
 *   2. COUNTRY_CONFIG map
 *      Maps ISO country codes to: currency, symbol, locale,
 *      conversion multiplier from INR, and tier system.
 *
 *   3. convertSalaryForCountry(inrAmount, countryCode)
 *      Converts INR salary bands to the user's local currency.
 *
 *   4. computeBenchmarkForUser({ roleId, userId, parsedData, experienceYears, location })
 *      New public function: reads user's country from parsedData,
 *      runs existing computeBenchmark(), converts to local currency,
 *      and appends locationComparison (e.g. "+20% above local average").
 *
 *   5. getAllBandsForRole — unchanged (returns INR always)
 */

const RoleRepository       = require('../repositories/RoleRepository');
const SalaryBandRepository = require('../repositories/SalaryBandRepository');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const roleRepo   = new RoleRepository();
const salaryRepo = new SalaryBandRepository();

// ─────────────────────────────────────────────────────────────
// Country configuration
// ─────────────────────────────────────────────────────────────

/**
 * COUNTRY_CONFIG
 *
 * multiplierFromINR: how many units of local currency = 1 INR
 * (approximate purchasing power parity + exchange rate blend)
 *
 * tier system maps to LOCATION_MULTIPLIERS for cities within
 * each country (metro, tier1, tier2, tier3)
 */
const COUNTRY_CONFIG = {
  IN: {
    name:             'India',
    currency:         'INR',
    symbol:           '₹',
    locale:           'en-IN',
    multiplierFromINR: 1.0,
    tiers: { metro: 1.00, tier1: 0.88, tier2: 0.78, tier3: 0.68 },
    averageMultiplier: 0.85, // weighted average across city tiers
  },
  US: {
    name:             'United States',
    currency:         'USD',
    symbol:           '$',
    locale:           'en-US',
    multiplierFromINR: 0.012,   // 1 INR ≈ $0.012
    tiers: { metro: 1.00, tier1: 0.90, tier2: 0.80, tier3: 0.70 },
    averageMultiplier: 0.88,
  },
  GB: {
    name:             'United Kingdom',
    currency:         'GBP',
    symbol:           '£',
    locale:           'en-GB',
    multiplierFromINR: 0.0095,  // 1 INR ≈ £0.0095
    tiers: { metro: 1.00, tier1: 0.85, tier2: 0.75, tier3: 0.65 },
    averageMultiplier: 0.85,
  },
  AE: {
    name:             'UAE',
    currency:         'AED',
    symbol:           'د.إ',
    locale:           'ar-AE',
    multiplierFromINR: 0.044,   // 1 INR ≈ 0.044 AED
    tiers: { metro: 1.00, tier1: 0.90, tier2: 0.85, tier3: 0.80 },
    averageMultiplier: 0.92,
  },
  SG: {
    name:             'Singapore',
    currency:         'SGD',
    symbol:           'S$',
    locale:           'en-SG',
    multiplierFromINR: 0.016,   // 1 INR ≈ 0.016 SGD
    tiers: { metro: 1.00, tier1: 0.92, tier2: 0.85, tier3: 0.78 },
    averageMultiplier: 0.93,
  },
  CA: {
    name:             'Canada',
    currency:         'CAD',
    symbol:           'C$',
    locale:           'en-CA',
    multiplierFromINR: 0.016,   // 1 INR ≈ 0.016 CAD
    tiers: { metro: 1.00, tier1: 0.88, tier2: 0.78, tier3: 0.68 },
    averageMultiplier: 0.86,
  },
  AU: {
    name:             'Australia',
    currency:         'AUD',
    symbol:           'A$',
    locale:           'en-AU',
    multiplierFromINR: 0.018,   // 1 INR ≈ 0.018 AUD
    tiers: { metro: 1.00, tier1: 0.87, tier2: 0.77, tier3: 0.67 },
    averageMultiplier: 0.85,
  },
  DE: {
    name:             'Germany',
    currency:         'EUR',
    symbol:           '€',
    locale:           'de-DE',
    multiplierFromINR: 0.011,   // 1 INR ≈ 0.011 EUR
    tiers: { metro: 1.00, tier1: 0.90, tier2: 0.80, tier3: 0.72 },
    averageMultiplier: 0.88,
  },
};

// Location string → country code mapping (from resume parser output)
const LOCATION_TO_COUNTRY = {
  // India
  'india': 'IN', 'bharat': 'IN', 'bengaluru': 'IN', 'bangalore': 'IN',
  'mumbai': 'IN', 'delhi': 'IN', 'new delhi': 'IN', 'hyderabad': 'IN',
  'chennai': 'IN', 'pune': 'IN', 'kolkata': 'IN', 'ahmedabad': 'IN',
  // US
  'united states': 'US', 'usa': 'US', 'us': 'US', 'new york': 'US',
  'san francisco': 'US', 'los angeles': 'US', 'chicago': 'US', 'seattle': 'US',
  'austin': 'US', 'boston': 'US', 'atlanta': 'US', 'dallas': 'US',
  // UK
  'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'london': 'GB',
  'manchester': 'GB', 'birmingham': 'GB', 'bristol': 'GB', 'edinburgh': 'GB',
  // UAE
  'uae': 'AE', 'united arab emirates': 'AE', 'dubai': 'AE', 'abu dhabi': 'AE',
  'sharjah': 'AE',
  // Singapore
  'singapore': 'SG',
  // Canada
  'canada': 'CA', 'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA',
  'calgary': 'CA', 'ottawa': 'CA',
  // Australia
  'australia': 'AU', 'sydney': 'AU', 'melbourne': 'AU', 'brisbane': 'AU',
  'perth': 'AU', 'adelaide': 'AU',
  // Germany
  'germany': 'DE', 'deutschland': 'DE', 'berlin': 'DE', 'munich': 'DE',
  'münchen': 'DE', 'hamburg': 'DE', 'frankfurt': 'DE', 'cologne': 'DE',
};

// ─────────────────────────────────────────────────────────────
// Country detection
// ─────────────────────────────────────────────────────────────

/**
 * detectUserCountry(parsedData)
 *
 * Reads country/city from parsedData.location (written by resumeParser).
 * parsedData.location can be:
 *   - { city: 'Bengaluru', country: 'India' }  (structured)
 *   - 'Bengaluru, India'                        (string)
 *   - null / undefined
 *
 * @param {object|null} parsedData
 * @returns {string} ISO country code — default 'IN'
 */
function detectUserCountry(parsedData) {
  const defaultCountry = (process.env.DEFAULT_SALARY_COUNTRY || 'IN').toUpperCase();

  if (!parsedData || !parsedData.location) return defaultCountry;

  const loc = parsedData.location;

  // Handle both { city, country } objects and plain strings
  let searchStr = '';
  if (typeof loc === 'object') {
    searchStr = [loc.country, loc.city].filter(Boolean).join(' ').toLowerCase().trim();
  } else {
    searchStr = String(loc).toLowerCase().trim();
  }

  // Try exact match on country field first, then city, then substring
  const country = typeof loc === 'object' ? (loc.country || '').toLowerCase().trim() : '';
  const city    = typeof loc === 'object' ? (loc.city    || '').toLowerCase().trim() : '';

  if (LOCATION_TO_COUNTRY[country]) return LOCATION_TO_COUNTRY[country];
  if (LOCATION_TO_COUNTRY[city])    return LOCATION_TO_COUNTRY[city];

  for (const [key, code] of Object.entries(LOCATION_TO_COUNTRY)) {
    if (searchStr.includes(key)) return code;
  }

  logger.debug('[SalaryService] Country not detected from location, using default', {
    location: rawCountry, default: defaultCountry,
  });

  return defaultCountry;
}

// ─────────────────────────────────────────────────────────────
// Currency conversion
// ─────────────────────────────────────────────────────────────

/**
 * convertSalaryForCountry(inrAmount, countryCode)
 *
 * Converts an INR salary figure to the target country's currency.
 * Uses purchasing power parity + exchange rate blend (not live rates).
 *
 * For production: replace multiplierFromINR with a live FX API call.
 */
function convertSalaryForCountry(inrAmount, countryCode) {
  const config = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG.IN;
  return Math.round(inrAmount * config.multiplierFromINR);
}

/**
 * formatSalaryRange(inrBand, countryCode)
 *
 * Converts a { min, max, median } INR band to local currency.
 */
function formatSalaryRange(inrBand, countryCode) {
  const config = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG.IN;

  const converted = {
    min:    convertSalaryForCountry(inrBand.min,    countryCode),
    max:    convertSalaryForCountry(inrBand.max,    countryCode),
    median: convertSalaryForCountry(inrBand.median, countryCode),
  };

  return {
    ...converted,
    currency: config.currency,
    symbol:   config.symbol,
    monthly: {
      min:    Math.round(converted.min    / 12),
      max:    Math.round(converted.max    / 12),
      median: Math.round(converted.median / 12),
    },
    formatted: {
      min:    `${config.symbol}${converted.min.toLocaleString(config.locale)}`,
      max:    `${config.symbol}${converted.max.toLocaleString(config.locale)}`,
      median: `${config.symbol}${converted.median.toLocaleString(config.locale)}`,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Location comparison
// ─────────────────────────────────────────────────────────────

/**
 * buildLocationComparison(userSalaryINR, roleMedianINR, countryCode, cityTier)
 *
 * Computes a human-readable comparison string:
 *   "+20% above local average" or "-8% below metro average"
 *
 * @param {number} userSalaryINR  — user's current or expected salary in INR
 * @param {number} roleMedianINR  — market median for role in INR
 * @param {string} countryCode    — ISO country code
 * @param {string} cityTier       — metro | tier1 | tier2 | tier3
 */
function buildLocationComparison(userSalaryINR, roleMedianINR, countryCode, cityTier = 'metro') {
  if (!userSalaryINR || !roleMedianINR) return null;

  const config = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG.IN;
  const tierMultiplier = config.tiers[cityTier] ?? 1.0;

  // Adjust median for the user's specific city tier
  const localMedian = Math.round(roleMedianINR * tierMultiplier);
  const diff = userSalaryINR - localMedian;
  const pct  = Math.round((diff / localMedian) * 100);

  const tierLabel = {
    metro: 'metro city',
    tier1: 'tier-1 city',
    tier2: 'tier-2 city',
    tier3: 'tier-3 city',
  }[cityTier] || cityTier;

  if (Math.abs(pct) < 3) {
    return `At ${tierLabel} market average`;
  }

  const direction = pct > 0 ? 'above' : 'below';
  return `${Math.abs(pct)}% ${direction} ${tierLabel} average`;
}

// ─────────────────────────────────────────────────────────────
// Location multipliers (India-focused — kept for backward compat)
// ─────────────────────────────────────────────────────────────

const LOCATION_MULTIPLIERS = {
  metro: 1.00,
  tier1: 0.88,
  tier2: 0.78,
  tier3: 0.68,
};

const DEFAULT_EXPERIENCE_BANDS = [
  { level: 'L1', label: 'Associate',          minYears: 0,  maxYears: 2  },
  { level: 'L2', label: 'Junior',             minYears: 2,  maxYears: 4  },
  { level: 'L3', label: 'Mid-level',          minYears: 4,  maxYears: 7  },
  { level: 'L4', label: 'Senior',             minYears: 7,  maxYears: 12 },
  { level: 'L5', label: 'Staff / Lead',       minYears: 12, maxYears: 18 },
  { level: 'L6', label: 'Principal / Manager',minYears: 18, maxYears: 60 },
];

const resolveLevelForExperience = (experienceYears, customBands) => {
  const bands = Array.isArray(customBands) && customBands.length > 0
    ? customBands : DEFAULT_EXPERIENCE_BANDS;
  const matched = bands.find(b => experienceYears >= b.minYears && experienceYears < b.maxYears);
  return matched || bands[bands.length - 1];
};

const applyLocationAndMonthly = (salaryBand, location) => {
  const safeLocation = LOCATION_MULTIPLIERS[location] ? location : 'metro';
  const multiplier = LOCATION_MULTIPLIERS[safeLocation];
  const adjusted = {
    min:    Math.round(salaryBand.min    * multiplier),
    max:    Math.round(salaryBand.max    * multiplier),
    median: Math.round(salaryBand.median * multiplier),
  };
  return {
    ...adjusted,
    monthly: {
      min:    Math.round(adjusted.min    / 12),
      max:    Math.round(adjusted.max    / 12),
      median: Math.round(adjusted.median / 12),
    },
    currency:         'INR',
    locationMultiplier: multiplier,
    locationCategory: safeLocation,
  };
};

// ─────────────────────────────────────────────────────────────
// Static salary table (unchanged from original)
// ─────────────────────────────────────────────────────────────

const STATIC_SALARY_TABLE = {
  'accountant':          { title:'Accountant',          L1:{min:240000,median:360000,max:540000},  L2:{min:360000,median:500000,max:700000},  L3:{min:500000,median:700000,max:950000},   L4:{min:700000,median:950000,max:1300000},  L5:{min:950000,median:1300000,max:1800000},  L6:{min:1300000,median:1800000,max:2500000}  },
  'financial analyst':   { title:'Financial Analyst',   L1:{min:300000,median:450000,max:650000},  L2:{min:450000,median:650000,max:900000},  L3:{min:650000,median:900000,max:1200000},  L4:{min:900000,median:1200000,max:1700000},  L5:{min:1200000,median:1700000,max:2400000}, L6:{min:1700000,median:2400000,max:3200000}  },
  'software engineer':   { title:'Software Engineer',   L1:{min:400000,median:600000,max:900000},  L2:{min:600000,median:900000,max:1300000}, L3:{min:900000,median:1300000,max:1900000},  L4:{min:1300000,median:1900000,max:2800000}, L5:{min:1900000,median:2800000,max:4000000}, L6:{min:2800000,median:4000000,max:6000000}  },
  'data scientist':      { title:'Data Scientist',      L1:{min:500000,median:800000,max:1200000}, L2:{min:800000,median:1200000,max:1800000},L3:{min:1200000,median:1800000,max:2700000}, L4:{min:1800000,median:2700000,max:4000000}, L5:{min:2700000,median:4000000,max:6000000}, L6:{min:4000000,median:6000000,max:9000000}  },
  'product manager':     { title:'Product Manager',     L1:{min:600000,median:950000,max:1500000}, L2:{min:950000,median:1500000,max:2300000},L3:{min:1500000,median:2300000,max:3500000}, L4:{min:2300000,median:3500000,max:5500000}, L5:{min:3500000,median:5500000,max:8000000}, L6:{min:5500000,median:8000000,max:12000000} },
  'data analyst':        { title:'Data Analyst',        L1:{min:300000,median:480000,max:700000},  L2:{min:480000,median:700000,max:1000000}, L3:{min:700000,median:1000000,max:1500000},  L4:{min:1000000,median:1500000,max:2200000}, L5:{min:1500000,median:2200000,max:3200000}, L6:{min:2200000,median:3200000,max:4500000}  },
  'devops engineer':     { title:'DevOps Engineer',     L1:{min:450000,median:700000,max:1050000}, L2:{min:700000,median:1050000,max:1550000},L3:{min:1050000,median:1550000,max:2300000}, L4:{min:1550000,median:2300000,max:3400000}, L5:{min:2300000,median:3400000,max:5000000}, L6:{min:3400000,median:5000000,max:7000000}  },
  'hr manager':          { title:'HR Manager',          L1:{min:350000,median:520000,max:750000},  L2:{min:520000,median:750000,max:1100000}, L3:{min:750000,median:1100000,max:1600000},  L4:{min:1100000,median:1600000,max:2300000}, L5:{min:1600000,median:2300000,max:3300000}, L6:{min:2300000,median:3300000,max:4800000}  },
  'project manager':     { title:'Project Manager',     L1:{min:450000,median:680000,max:1000000}, L2:{min:680000,median:1000000,max:1500000},L3:{min:1000000,median:1500000,max:2200000}, L4:{min:1500000,median:2200000,max:3200000}, L5:{min:2200000,median:3200000,max:4600000}, L6:{min:3200000,median:4600000,max:6500000}  },
  'marketing manager':   { title:'Marketing Manager',   L1:{min:350000,median:520000,max:780000},  L2:{min:520000,median:780000,max:1150000}, L3:{min:780000,median:1150000,max:1700000},  L4:{min:1150000,median:1700000,max:2500000}, L5:{min:1700000,median:2500000,max:3600000}, L6:{min:2500000,median:3600000,max:5200000}  },
  'chartered accountant':{ title:'Chartered Accountant',L1:{min:500000,median:750000,max:1100000}, L2:{min:750000,median:1100000,max:1600000},L3:{min:1100000,median:1600000,max:2200000}, L4:{min:1600000,median:2200000,max:3200000}, L5:{min:2200000,median:3200000,max:4500000}, L6:{min:3200000,median:4500000,max:6500000}  },
};

const _resolveStaticEntry = (id) => STATIC_SALARY_TABLE[(id || '').toLowerCase().trim()] || null;

// ═════════════════════════════════════════════════════════════
// PUBLIC: computeBenchmark (unchanged from original)
// ═════════════════════════════════════════════════════════════
const computeBenchmark = async ({ roleId, experienceYears, location = 'metro' }) => {
  if (!roleId) throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  if (typeof experienceYears !== 'number' || experienceYears < 0) {
    throw new AppError('experienceYears must be a non-negative number', 400, { experienceYears }, ErrorCodes.VALIDATION_ERROR);
  }

  let [role, bandDoc] = await Promise.all([
    roleRepo.findById(roleId).catch(() => null),
    salaryRepo.findByRoleId(roleId).catch(() => null),
  ]);

  if (!role) {
    try {
      const matches = await roleRepo.searchByTitle(roleId, 1);
      if (matches && matches.length > 0) role = matches[0];
    } catch (_) {}
  }

  if (!role) {
    const staticEntry = _resolveStaticEntry(roleId);
    if (staticEntry) {
      const resolvedLevel = resolveLevelForExperience(experienceYears, null);
      const levelBandData = staticEntry[resolvedLevel.level];
      if (levelBandData) {
        const adjustedSalary = applyLocationAndMonthly(levelBandData, location);
        return {
          role: { id: roleId, title: staticEntry.title, jobFamily: null, track: 'individual_contributor' },
          recommendedLevel: resolvedLevel.level, levelLabel: resolvedLevel.label,
          experienceYears, salaryRange: { min: adjustedSalary.min, max: adjustedSalary.max, median: adjustedSalary.median },
          monthlyEstimate: adjustedSalary.monthly, marketPosition: 'mid',
          locationAdjustment: { category: adjustedSalary.locationCategory, multiplier: adjustedSalary.locationMultiplier, note: `Salary adjusted for ${location} India market rates` },
          currency: 'INR', dataAsOf: null, isStatic: true,
        };
      }
    }
    throw new AppError(`Role '${roleId}' not found`, 404, { roleId }, ErrorCodes.ROLE_NOT_FOUND);
  }

  if (!bandDoc) {
    const staticEntry = _resolveStaticEntry(role.title || roleId);
    if (staticEntry) {
      const resolvedLevel = resolveLevelForExperience(experienceYears, role.customExperienceBands);
      const levelBandData = staticEntry[resolvedLevel.level];
      if (levelBandData) {
        const adjustedSalary = applyLocationAndMonthly(levelBandData, location);
        return {
          role: { id: role.id, title: role.title, jobFamily: role.jobFamilyId, track: role.track },
          recommendedLevel: resolvedLevel.level, levelLabel: resolvedLevel.label,
          experienceYears, salaryRange: { min: adjustedSalary.min, max: adjustedSalary.max, median: adjustedSalary.median },
          monthlyEstimate: adjustedSalary.monthly, marketPosition: 'mid',
          locationAdjustment: { category: adjustedSalary.locationCategory, multiplier: adjustedSalary.locationMultiplier, note: `Salary adjusted for ${location} India market rates` },
          currency: 'INR', dataAsOf: null, isStatic: true,
        };
      }
    }
    throw new AppError(`Salary band not found for role '${roleId}'`, 404, { roleId }, ErrorCodes.SALARY_BAND_NOT_FOUND);
  }

  const resolvedLevel = resolveLevelForExperience(experienceYears, role.customExperienceBands || bandDoc.experienceBands);
  const rawBand = (bandDoc.levels || {})[resolvedLevel.level];
  if (!rawBand) throw new AppError(`No salary data for level ${resolvedLevel.level}`, 404, { roleId, level: resolvedLevel.level }, ErrorCodes.SALARY_BAND_NOT_FOUND);

  const adjustedSalary = applyLocationAndMonthly(rawBand, location);
  return {
    role: { id: role.id, title: role.title, jobFamily: role.jobFamilyId, track: role.track },
    recommendedLevel: resolvedLevel.level, levelLabel: resolvedLevel.label,
    experienceYears, salaryRange: { min: adjustedSalary.min, max: adjustedSalary.max, median: adjustedSalary.median },
    monthlyEstimate: adjustedSalary.monthly, marketPosition: 'mid',
    locationAdjustment: { category: adjustedSalary.locationCategory, multiplier: adjustedSalary.locationMultiplier, note: `Salary adjusted for ${location} market rates` },
    currency: 'INR', dataAsOf: bandDoc.updatedAt?.toDate?.()?.toISOString?.() || null,
  };
};

// ═════════════════════════════════════════════════════════════
// PUBLIC: computeBenchmarkForUser — NEW
// ═════════════════════════════════════════════════════════════

/**
 * computeBenchmarkForUser({ roleId, parsedData, experienceYears, location, userCurrentSalaryINR })
 *
 * Extended version of computeBenchmark that:
 *   1. Detects user's country from parsedData.location
 *   2. Runs computeBenchmark() in INR
 *   3. Converts salary to local currency
 *   4. Appends locationComparison string
 *
 * @param {object} params
 * @param {string} params.roleId
 * @param {object} [params.parsedData]         — from resume parser
 * @param {number} params.experienceYears
 * @param {string} [params.location]            — metro | tier1 | tier2 | tier3
 * @param {number} [params.userCurrentSalaryINR] — for comparison string
 */
const computeBenchmarkForUser = async ({
  roleId,
  parsedData,
  experienceYears,
  location = 'metro',
  userCurrentSalaryINR = null,
}) => {
  const countryCode = detectUserCountry(parsedData);
  const countryConfig = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG.IN;

  // Run the standard INR benchmark
  const benchmark = await computeBenchmark({ roleId, experienceYears, location });

  // Convert salary range to local currency
  const localSalary = formatSalaryRange(benchmark.salaryRange, countryCode);

  // Build location comparison if user's current salary is known
  const locationComparison = userCurrentSalaryINR
    ? buildLocationComparison(userCurrentSalaryINR, benchmark.salaryRange.median, countryCode, location)
    : null;

  return {
    ...benchmark,
    // Override with localised values
    salaryRange: {
      ...benchmark.salaryRange,
      ...localSalary,
    },
    monthlyEstimate: localSalary.monthly,
    currency:        countryConfig.currency,
    currencySymbol:  countryConfig.symbol,
    country:         countryCode,
    countryName:     countryConfig.name,
    // Append comparison
    locationComparison,
    // Keep INR values for downstream services that expect INR
    salaryRangeINR:  benchmark.salaryRange,
  };
};

// ═════════════════════════════════════════════════════════════
// PUBLIC: getAllBandsForRole (unchanged)
// ═════════════════════════════════════════════════════════════
const getAllBandsForRole = async (roleId) => {
  if (!roleId) throw new AppError('roleId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [role, bandDoc] = await Promise.all([
    roleRepo.findById(roleId),
    salaryRepo.findByRoleId(roleId),
  ]);

  if (!role || !bandDoc) {
    throw new AppError(`Salary progression data unavailable for role '${roleId}'`, 404, { roleId }, ErrorCodes.SALARY_BAND_NOT_FOUND);
  }

  const levels = Object.entries(bandDoc.levels || {}).map(([levelCode, data]) => {
    const experienceBand = DEFAULT_EXPERIENCE_BANDS.find(b => b.level === levelCode);
    return {
      level:    levelCode,
      label:    experienceBand?.label || levelCode,
      minYears: experienceBand?.minYears,
      maxYears: experienceBand?.maxYears,
      salary:   { min: data.min, max: data.max, median: data.median },
      monthly:  { min: Math.round(data.min / 12), max: Math.round(data.max / 12), median: Math.round(data.median / 12) },
    };
  });

  const levelOrder = DEFAULT_EXPERIENCE_BANDS.map(b => b.level);
  levels.sort((a, b) => levelOrder.indexOf(a.level) - levelOrder.indexOf(b.level));

  return { role: { id: role.id, title: role.title }, levels, currency: 'INR', dataAsOf: bandDoc.updatedAt?.toDate?.()?.toISOString?.() || null };
};

module.exports = {
  computeBenchmark,
  computeBenchmarkForUser,
  getAllBandsForRole,
  detectUserCountry,
  convertSalaryForCountry,
  formatSalaryRange,
  buildLocationComparison,
  COUNTRY_CONFIG,
};








