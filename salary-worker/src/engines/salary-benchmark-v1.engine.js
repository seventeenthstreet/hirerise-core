/**
 * Salary Benchmark Engine — v1.0
 *
 * Computes salary benchmarks from internal dataset.
 * In production, integrate with Bureau of Labor Statistics API,
 * Levels.fyi dataset, or proprietary salary data sources.
 *
 * Returns p25/median/p75 bands with experience and location adjustments.
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
  'san francisco': 1.45, 'new york': 1.40, 'seattle': 1.30,
  'austin': 1.05, 'chicago': 1.10, 'boston': 1.20, 'remote': 1.0,
  default: 1.0,
};

const EXPERIENCE_ADJUSTMENTS = [
  { maxYears: 2, multiplier: 0.80 },
  { maxYears: 5, multiplier: 0.95 },
  { maxYears: 8, multiplier: 1.05 },
  { maxYears: 12, multiplier: 1.20 },
  { maxYears: Infinity, multiplier: 1.35 },
];

export class SalaryBenchmarkEngineV1 {
  get version() { return 'salary_bench_v1.0'; }

  async benchmark({ jobTitle, location, yearsExperience, industry }) {
    const normalizedTitle = (jobTitle ?? '').toLowerCase().trim();
    const normalizedLocation = (location ?? '').toLowerCase().trim();

    const base = BASE_SALARIES[normalizedTitle] ?? BASE_SALARIES.default;
    const locationMult = this.#locationMultiplier(normalizedLocation);
    const experienceMult = this.#experienceMultiplier(yearsExperience ?? 0);
    const combined = locationMult * experienceMult;

    return {
      jobTitle,
      location,
      yearsExperience,
      industry: industry ?? null,
      currency: 'USD',
      p25: Math.round(base.p25 * combined),
      median: Math.round(base.base * combined),
      p75: Math.round(base.p75 * combined),
      locationMultiplier: locationMult,
      experienceMultiplier: experienceMult,
      engineVersion: this.version,
      computedAt: new Date().toISOString(),
      dataNote: 'Benchmark based on internal dataset. For illustrative purposes at v1.0.',
    };
  }

  #locationMultiplier(location) {
    for (const [key, mult] of Object.entries(LOCATION_MULTIPLIERS)) {
      if (key !== 'default' && location.includes(key)) return mult;
    }
    return LOCATION_MULTIPLIERS.default;
  }

  #experienceMultiplier(years) {
    for (const { maxYears, multiplier } of EXPERIENCE_ADJUSTMENTS) {
      if (years <= maxYears) return multiplier;
    }
    return 1.35;
  }
}
