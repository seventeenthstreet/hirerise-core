/**
 * Salary Benchmark Engine — v1.1 (Improved)
 *
 * Enhancements:
 *  - Fuzzy job title matching
 *  - Location-based currency (USD / INR)
 *  - Input sanitization
 *  - Consistent rounding
 *  - More resilient defaults
 */

const BASE_SALARIES = {
  'software engineer': { base: 120000, p25: 100000, p75: 145000 },
  'senior software engineer': { base: 160000, p25: 140000, p75: 185000 },
  'product manager': { base: 130000, p25: 110000, p75: 155000 },
  'data scientist': { base: 135000, p25: 115000, p75: 160000 },
  'devops engineer': { base: 125000, p25: 105000, p75: 150000 },
  'designer': { base: 95000, p25: 80000, p75: 115000 },
  default: { base: 95000, p25: 75000, p75: 120000 },
};

const LOCATION_MULTIPLIERS = {
  'san francisco': 1.45,
  'new york': 1.40,
  'seattle': 1.30,
  'boston': 1.20,
  'chicago': 1.10,
  'austin': 1.05,
  'india': 0.35,
  'bangalore': 0.40,
  'mumbai': 0.38,
  'delhi': 0.37,
  'remote': 1.0,
  default: 1.0,
};

const EXPERIENCE_ADJUSTMENTS = [
  { maxYears: 2, multiplier: 0.80 },
  { maxYears: 5, multiplier: 0.95 },
  { maxYears: 8, multiplier: 1.05 },
  { maxYears: 12, multiplier: 1.20 },
  { maxYears: Infinity, multiplier: 1.35 },
];

const round = (n) => Math.round(n / 1000) * 1000;

export class SalaryBenchmarkEngineV1 {
  get version() {
    return 'salary_bench_v1.1';
  }

  async benchmark({ jobTitle, location, yearsExperience, industry }) {
    const normalizedTitle = (jobTitle ?? '').toLowerCase().trim();
    const normalizedLocation = (location ?? '').toLowerCase().trim();

    // Sanitize experience
    const years = Math.max(0, Math.min(yearsExperience ?? 0, 50));

    const base = this.#matchTitle(normalizedTitle);
    const locationMult = this.#locationMultiplier(normalizedLocation);
    const experienceMult = this.#experienceMultiplier(years);

    const combined = locationMult * experienceMult;

    const currency = this.#resolveCurrency(normalizedLocation);

    return {
      jobTitle,
      location,
      yearsExperience: years,
      industry: industry ?? null,
      currency,
      p25: round(base.p25 * combined),
      median: round(base.base * combined),
      p75: round(base.p75 * combined),
      locationMultiplier: locationMult,
      experienceMultiplier: experienceMult,
      engineVersion: this.version,
      computedAt: new Date().toISOString(),
      dataNote:
        'Benchmark based on internal dataset. Enhanced with fuzzy matching and localization (v1.1).',
    };
  }

  // ─────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────

  #matchTitle(title) {
    if (!title) return BASE_SALARIES.default;

    for (const key of Object.keys(BASE_SALARIES)) {
      if (title.includes(key)) {
        return BASE_SALARIES[key];
      }
    }

    return BASE_SALARIES.default;
  }

  #locationMultiplier(location) {
    if (!location) return LOCATION_MULTIPLIERS.default;

    for (const [key, mult] of Object.entries(LOCATION_MULTIPLIERS)) {
      if (key !== 'default' && location.includes(key)) {
        return mult;
      }
    }

    return LOCATION_MULTIPLIERS.default;
  }

  #experienceMultiplier(years) {
    for (const { maxYears, multiplier } of EXPERIENCE_ADJUSTMENTS) {
      if (years <= maxYears) return multiplier;
    }
    return 1.35;
  }

  #resolveCurrency(location) {
    if (!location) return 'USD';

    if (location.includes('india')) return 'INR';

    return 'USD';
  }
}