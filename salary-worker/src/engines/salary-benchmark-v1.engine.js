/**
 * Salary Benchmark Engine — v1.2 (Supabase-era Production Optimized)
 *
 * Improvements:
 * - Fully Firebase-free architecture validation
 * - Immutable configuration constants
 * - Faster deterministic title/location matching
 * - Improved null/type safety
 * - Better input normalization
 * - Consistent currency resolution for India regions
 * - Cleaner helper modularity
 * - Drop-in API compatibility preserved
 */

const BASE_SALARIES = Object.freeze({
  'senior software engineer': Object.freeze({
    base: 160000,
    p25: 140000,
    p75: 185000,
  }),
  'software engineer': Object.freeze({
    base: 120000,
    p25: 100000,
    p75: 145000,
  }),
  'product manager': Object.freeze({
    base: 130000,
    p25: 110000,
    p75: 155000,
  }),
  'data scientist': Object.freeze({
    base: 135000,
    p25: 115000,
    p75: 160000,
  }),
  'devops engineer': Object.freeze({
    base: 125000,
    p25: 105000,
    p75: 150000,
  }),
  designer: Object.freeze({
    base: 95000,
    p25: 80000,
    p75: 115000,
  }),
  default: Object.freeze({
    base: 95000,
    p25: 75000,
    p75: 120000,
  }),
});

const LOCATION_MULTIPLIERS = Object.freeze({
  'san francisco': 1.45,
  'new york': 1.4,
  seattle: 1.3,
  boston: 1.2,
  chicago: 1.1,
  austin: 1.05,
  bangalore: 0.4,
  bengaluru: 0.4,
  mumbai: 0.38,
  delhi: 0.37,
  india: 0.35,
  remote: 1.0,
  default: 1.0,
});

const EXPERIENCE_ADJUSTMENTS = Object.freeze([
  Object.freeze({ maxYears: 2, multiplier: 0.8 }),
  Object.freeze({ maxYears: 5, multiplier: 0.95 }),
  Object.freeze({ maxYears: 8, multiplier: 1.05 }),
  Object.freeze({ maxYears: 12, multiplier: 1.2 }),
  Object.freeze({ maxYears: Number.POSITIVE_INFINITY, multiplier: 1.35 }),
]);

/**
 * Longest/specific match first for deterministic fuzzy matching.
 */
const TITLE_MATCH_ORDER = Object.freeze(
  Object.keys(BASE_SALARIES)
    .filter((key) => key !== 'default')
    .sort((a, b) => b.length - a.length),
);

const LOCATION_MATCH_ORDER = Object.freeze(
  Object.keys(LOCATION_MULTIPLIERS)
    .filter((key) => key !== 'default')
    .sort((a, b) => b.length - a.length),
);

const INDIA_LOCATION_KEYWORDS = Object.freeze([
  'india',
  'bangalore',
  'bengaluru',
  'mumbai',
  'delhi',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);

  if (!Number.isFinite(num)) return fallback;

  return Math.max(min, Math.min(num, max));
}

function roundToNearestThousand(value) {
  return Math.round(value / 1000) * 1000;
}

export class SalaryBenchmarkEngineV1 {
  get version() {
    return 'salary_bench_v1.2';
  }

  /**
   * Preserved async API shape for drop-in compatibility.
   */
  async benchmark({
    jobTitle,
    location,
    yearsExperience,
    industry,
  } = {}) {
    const normalizedTitle = normalizeText(jobTitle);
    const normalizedLocation = normalizeText(location);
    const years = clampNumber(yearsExperience, 0, 50, 0);

    const salaryBand = this.#matchTitle(normalizedTitle);
    const locationMultiplier =
      this.#locationMultiplier(normalizedLocation);
    const experienceMultiplier =
      this.#experienceMultiplier(years);

    const combinedMultiplier =
      locationMultiplier * experienceMultiplier;

    const currency =
      this.#resolveCurrency(normalizedLocation);

    return {
      jobTitle: jobTitle ?? null,
      location: location ?? null,
      yearsExperience: years,
      industry: industry ?? null,
      currency,
      p25: roundToNearestThousand(
        salaryBand.p25 * combinedMultiplier,
      ),
      median: roundToNearestThousand(
        salaryBand.base * combinedMultiplier,
      ),
      p75: roundToNearestThousand(
        salaryBand.p75 * combinedMultiplier,
      ),
      locationMultiplier,
      experienceMultiplier,
      engineVersion: this.version,
      computedAt: new Date().toISOString(),
      dataNote:
        'Benchmark based on internal dataset. Enhanced with fuzzy matching and localization (v1.2).',
    };
  }

  // ─────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────

  #matchTitle(title) {
    if (!title) return BASE_SALARIES.default;

    for (const key of TITLE_MATCH_ORDER) {
      if (title.includes(key)) {
        return BASE_SALARIES[key];
      }
    }

    return BASE_SALARIES.default;
  }

  #locationMultiplier(location) {
    if (!location) {
      return LOCATION_MULTIPLIERS.default;
    }

    for (const key of LOCATION_MATCH_ORDER) {
      if (location.includes(key)) {
        return LOCATION_MULTIPLIERS[key];
      }
    }

    return LOCATION_MULTIPLIERS.default;
  }

  #experienceMultiplier(years) {
    for (const band of EXPERIENCE_ADJUSTMENTS) {
      if (years <= band.maxYears) {
        return band.multiplier;
      }
    }

    return 1.35;
  }

  #resolveCurrency(location) {
    if (!location) return 'USD';

    for (const keyword of INDIA_LOCATION_KEYWORDS) {
      if (location.includes(keyword)) {
        return 'INR';
      }
    }

    return 'USD';
  }
}