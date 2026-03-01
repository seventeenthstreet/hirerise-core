/**
 * Engine Version Registry
 *
 * Defines versioned engine identifiers for all intelligence modules.
 * When a new engine version is deployed:
 *   1. Add the new version constant
 *   2. Update CURRENT_* pointer
 *   3. Historical scores retain their engineVersion — no backfill required
 *   4. The worker's ENGINE_VERSION env var controls which version is active
 */

export const RESUME_ENGINES = Object.freeze({
  V1_0: 'resume_score_v1.0',
  V1_1: 'resume_score_v1.1',
  V2_0: 'resume_score_v2.0',
});

export const SALARY_ENGINES = Object.freeze({
  V1_0: 'salary_bench_v1.0',
  V1_1: 'salary_bench_v1.1',
});

export const CAREER_ENGINES = Object.freeze({
  V1_0: 'career_path_v1.0',
});

export const CURRENT_RESUME_ENGINE = RESUME_ENGINES.V1_0;
export const CURRENT_SALARY_ENGINE = SALARY_ENGINES.V1_0;
export const CURRENT_CAREER_ENGINE = CAREER_ENGINES.V1_0;

/**
 * Returns the engine class for a given version identifier.
 * Workers import this to resolve which engine to instantiate.
 *
 * @param {string} version - engine version string
 * @param {Object} engineMap - { [version]: EngineClass }
 */
export function resolveEngine(version, engineMap) {
  const Engine = engineMap[version];
  if (!Engine) {
    throw new Error(`Unknown engine version: ${version}. Available: ${Object.keys(engineMap).join(', ')}`);
  }
  return new Engine();
}
