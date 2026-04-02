'use strict';

/**
 * Engine Version Registry
 *
 * ✅ CJS compatible
 * ✅ Env-safe resolution
 * ✅ Better error handling
 * ✅ Dependency injection ready
 */

const RESUME_ENGINES = Object.freeze({
  V1_0: 'resume_score_v1.0',
  V1_1: 'resume_score_v1.1',
  V2_0: 'resume_score_v2.0',
});

const SALARY_ENGINES = Object.freeze({
  V1_0: 'salary_bench_v1.0',
  V1_1: 'salary_bench_v1.1',
});

const CAREER_ENGINES = Object.freeze({
  V1_0: 'career_path_v1.0',
});

const CURRENT_RESUME_ENGINE = RESUME_ENGINES.V1_0;
const CURRENT_SALARY_ENGINE = SALARY_ENGINES.V1_0;
const CURRENT_CAREER_ENGINE = CAREER_ENGINES.V1_0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function validateVersion(version, engineMap, type) {
  if (!version || typeof version !== 'string') {
    throw new Error(`[EngineRegistry] Invalid ${type} engine version: ${version}`);
  }

  if (!engineMap[version]) {
    throw new Error(
      `[EngineRegistry] Unknown ${type} engine version: ${version}. Available: ${Object.keys(engineMap).join(', ')}`
    );
  }
}

// ─── resolveEngine ──────────────────────────────────────────────────────────

/**
 * Resolves and instantiates an engine
 *
 * @param {string} version
 * @param {Object} engineMap
 * @param {Object} [options] - dependencies/config injection
 */
function resolveEngine(version, engineMap, options = {}) {
  validateVersion(version, engineMap, 'generic');

  const Engine = engineMap[version];

  try {
    return new Engine(options); // ✅ supports DI
  } catch (err) {
    throw new Error(
      `[EngineRegistry] Failed to instantiate engine ${version}: ${err.message}`
    );
  }
}

// ─── resolveFromEnv (NEW - IMPORTANT) ───────────────────────────────────────

/**
 * Safely resolves engine from environment variable
 *
 * @param {string} envVar
 * @param {Object} engineMap
 * @param {string} fallback
 * @param {Object} [options]
 */
function resolveFromEnv(envVar, engineMap, fallback, options = {}) {
  const version = process.env[envVar] || fallback;

  validateVersion(version, engineMap, envVar);

  return resolveEngine(version, engineMap, options);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  RESUME_ENGINES,
  SALARY_ENGINES,
  CAREER_ENGINES,

  CURRENT_RESUME_ENGINE,
  CURRENT_SALARY_ENGINE,
  CURRENT_CAREER_ENGINE,

  resolveEngine,
  resolveFromEnv,
};