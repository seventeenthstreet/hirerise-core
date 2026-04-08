'use strict';

/**
 * shared/engines/registry.js
 *
 * Production-safe engine version registry + constructor resolver
 * ✅ Firebase legacy string-instantiation bug fixed
 * ✅ Supabase worker safe
 * ✅ Constructor-based resolution
 * ✅ Strong validation
 * ✅ Dependency injection ready
 * ✅ Backward-compatible version constants
 */

/**
 * Stable persisted engine version identifiers
 * These values are safe for DB storage, analytics, and event payloads.
 */
const ENGINE_VERSIONS = Object.freeze({
  RESUME: Object.freeze({
    V1_0: 'resume_score_v1.0',
    V1_1: 'resume_score_v1.1',
    V2_0: 'resume_score_v2.0',
  }),

  SALARY: Object.freeze({
    V1_0: 'salary_bench_v1.0',
    V1_1: 'salary_bench_v1.1',
  }),

  CAREER: Object.freeze({
    V1_0: 'career_path_v1.0',
  }),
});

const CURRENT_ENGINES = Object.freeze({
  resume: ENGINE_VERSIONS.RESUME.V1_0,
  salary: ENGINE_VERSIONS.SALARY.V1_0,
  career: ENGINE_VERSIONS.CAREER.V1_0,
});

/**
 * Validate version exists in constructor registry
 */
function validateVersion(version, registry, type = 'engine') {
  if (!version || typeof version !== 'string') {
    throw new Error(
      `[EngineRegistry] Invalid ${type} version: ${String(version)}`
    );
  }

  if (!registry || typeof registry !== 'object') {
    throw new Error(
      `[EngineRegistry] Invalid ${type} registry supplied`
    );
  }

  if (!(version in registry)) {
    throw new Error(
      `[EngineRegistry] Unknown ${type} version "${version}". Available: ${Object.keys(registry).join(', ')}`
    );
  }
}

/**
 * Resolve engine instance from constructor registry
 *
 * @param {string} version
 * @param {Object<string, Function>} registry
 * @param {Object} [options]
 */
function resolveEngine(version, registry, options = {}) {
  validateVersion(version, registry);

  const EngineConstructor = registry[version];

  if (typeof EngineConstructor !== 'function') {
    throw new Error(
      `[EngineRegistry] Registry entry for "${version}" is not a constructor`
    );
  }

  try {
    return new EngineConstructor(options);
  } catch (error) {
    throw new Error(
      `[EngineRegistry] Failed to instantiate "${version}": ${error.message}`
    );
  }
}

/**
 * Resolve engine version from environment, then instantiate
 *
 * @param {string} envVar
 * @param {Object<string, Function>} registry
 * @param {string} fallbackVersion
 * @param {Object} [options]
 */
function resolveFromEnv(envVar, registry, fallbackVersion, options = {}) {
  const raw = process.env[envVar];
  const version =
    typeof raw === 'string' && raw.trim()
      ? raw.trim()
      : fallbackVersion;

  return resolveEngine(version, registry, options);
}

module.exports = {
  ENGINE_VERSIONS,
  CURRENT_ENGINES,
  resolveEngine,
  resolveFromEnv,
};