'use strict';

/**
 * local/no-service-importing-service  (v3 — hardened path normalization)
 *
 * Prevents a *.service.js file from requiring another *.service.js file
 * that is not explicitly approved by architecture governance.
 *
 * DEBUG FINDINGS (v3)
 * ───────────────────
 * Root-cause investigation confirmed three path-normalization hazards that
 * can silently break allowlist matching:
 *
 *   1. Windows backslash paths: context.getFilename() may return backslash
 *      paths on Windows. path.basename() on Linux treats '\' as a filename
 *      character, so path.basename('.\\foo.service') === '.\\foo.service'
 *      (the full string), not 'foo.service'. Fix: normalize ALL paths to
 *      forward slashes before any basename or fragment extraction.
 *
 *   2. CRLF contamination: source files have Windows CRLF line endings.
 *      Although ESLint strips \r before passing values to rule handlers,
 *      defensive trimming is applied to importerBasename as a guard.
 *
 *   3. Stale module cache: if the rule file is edited but node_modules/
 *      eslint-plugin-local symlink was not refreshed (npm install not re-run),
 *      the old version executes. Fix: run `npm install` after any rule edit.
 *
 * Confirmed correct via debug logging:
 *   { importer: "onboarding.service.js", source: "./onboarding.cv.service",
 *     importeeBasename: "onboarding.cv.service", keyExists: true, matched: true }
 * All five onboarding pairs, all careerPath sub-services, simulation→careerPath,
 * careerIntelligence→{resumeScore,salary}, and all six infrastructure primitives
 * match correctly and produce zero errors.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE SEMANTICS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. APPROVED COORDINATOR OWNERSHIP
 *    Coordinators own their sub-services. Exact importer→importee pairs:
 *
 *    onboarding.service      → onboarding.intake.service
 *    onboarding.service      → onboarding.careerReport.service
 *    onboarding.service      → onboarding.cv.service
 *    onboarding.service      → onboarding.linkedin.service
 *    onboarding.service      → onboarding.analytics.service
 *    simulation.service      → careerPath.service
 *    careerIntelligence.service → resumeScore.service
 *    careerIntelligence.service → salary.service
 *    careerPath.service      → readiness.service
 *    careerPath.service      → promotion.service
 *    careerPath.service      → timeEstimator.service
 *
 * 2. APPROVED INFRASTRUCTURE PRIMITIVES
 *    Any service may import these basenames:
 *    analyticsCache.service  alert.service  userVector.service
 *    lock.service            confidence.service  quality.service
 *
 * 3. QUARANTINE EXCLUSIONS
 *    Files under src/infrastructure/cache/ are excluded as both importer
 *    and importee.
 *
 * 4. STRICT ENFORCEMENT (preserved — these remain errors)
 *    adminImport → importDependency
 *    growth      → resumeGrowth
 *    marketTrend cross-domain access
 *    secrets self-import
 *    conversion pipeline leakage
 *    salaryAggregation bypass
 *
 * SEVERITY: error  |  AUTOFIX: no  |  GOVERNANCE: Doc 08 — Dependency Rules
 */

const path = require('path');

const SERVICE_FILE_RE   = /\.service\.js$/;
const SERVICE_IMPORT_RE = /\.service(\.js)?$/;
const SHARED_PATH_RE    = /\/shared\//;   // forward-slash only — paths are normalized first

// ── 1. Approved coordinator ownership ────────────────────────────────────────
// Keys and values use basenames only (no path, no leading dot).
// Both "foo.service" and "foo.service.js" variants are listed because
// require() callers may omit the .js extension.
const COORDINATOR_PAIRS = {
  'onboarding.service.js': new Set([
    'onboarding.intake.service',
    'onboarding.intake.service.js',
    'onboarding.careerReport.service',
    'onboarding.careerReport.service.js',
    'onboarding.cv.service',
    'onboarding.cv.service.js',
    'onboarding.linkedin.service',
    'onboarding.linkedin.service.js',
    'onboarding.analytics.service',
    'onboarding.analytics.service.js',
  ]),
  'simulation.service.js': new Set([
    'careerPath.service',
    'careerPath.service.js',
  ]),
  'careerIntelligence.service.js': new Set([
    'resumeScore.service',
    'resumeScore.service.js',
    'salary.service',
    'salary.service.js',
  ]),
  'careerPath.service.js': new Set([
    'readiness.service',
    'readiness.service.js',
    'promotion.service',
    'promotion.service.js',
    'timeEstimator.service',
    'timeEstimator.service.js',
  ]),
};

// ── 2. Approved infrastructure primitive basenames ───────────────────────────
const INFRASTRUCTURE_PRIMITIVE_BASENAMES = new Set([
  'analyticsCache.service',
  'analyticsCache.service.js',
  'alert.service',
  'alert.service.js',
  'userVector.service',
  'userVector.service.js',
  'lock.service',
  'lock.service.js',
  'confidence.service',
  'confidence.service.js',
  'quality.service',
  'quality.service.js',
]);

// ── 3. Quarantine path fragment ───────────────────────────────────────────────
const CACHE_QUARANTINE_FRAGMENT = '/infrastructure/cache/';

/**
 * Normalize any path string to forward slashes and trim whitespace/CRLF.
 * Must be called on EVERY path before any comparison or basename extraction.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  return p.replace(/\\/g, '/').trim();
}

/**
 * Extract the basename from a normalized (forward-slash) path string.
 * Using path.posix.basename so behaviour is identical on Windows and Linux.
 *
 * @param {string} normalizedPath - already normalized with normalizePath()
 * @returns {string}
 */
function posixBasename(normalizedPath) {
  return path.posix.basename(normalizedPath);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow *.service.js files from requiring sibling *.service.js files ' +
        'unless covered by approved coordinator ownership or infrastructure primitives.',
    },
    messages: {
      noServiceImportingService:
        '"{{importer}}" must not import sibling service "{{imported}}". ' +
        'Services must not call each other directly. ' +
        'Options: emit a domain event via shared/pubsub, ' +
        'extract shared logic to a utils module, ' +
        'or introduce a coordinator service that owns both calls. ' +
        '[Doc 08 — Dependency Rules]',
    },
    schema: [],
  },

  create(context) {
    // ── Normalize importer path immediately — guard against Windows paths and CRLF
    const filename = normalizePath(context.getFilename());

    // Rule only active inside service files
    if (!SERVICE_FILE_RE.test(filename)) {
      return {};
    }

    // ── 3. Quarantine: skip if the importer file is under infrastructure/cache/
    if (filename.includes(CACHE_QUARANTINE_FRAGMENT)) {
      return {};
    }

    // Use path.posix.basename so '\\' in a path is never mistaken for a separator
    const importerBasename = posixBasename(filename);

    function checkRequireSource(sourceValue, reportNode) {
      // Normalize the import source string (CRLF trim, backslash → slash)
      const source = normalizePath(sourceValue);

      // Only relative imports — node_modules are never a governance concern here
      if (!source.startsWith('.')) return;

      // Must look like a service import
      if (!SERVICE_IMPORT_RE.test(source)) return;

      // shared/ imports are always allowed
      if (SHARED_PATH_RE.test(source)) return;

      // ── 3. Quarantine: skip if importee resolves into infrastructure/cache/
      if (source.includes(CACHE_QUARANTINE_FRAGMENT)) {
        return;
      }

      const importeeBasename = posixBasename(source);

      // ── 2. Infrastructure primitive: allow by importee basename
      if (INFRASTRUCTURE_PRIMITIVE_BASENAMES.has(importeeBasename)) {
        return;
      }

      // ── 1. Coordinator ownership: allow exact importer→importee pair
      const allowedImportees = COORDINATOR_PAIRS[importerBasename];
      if (allowedImportees && allowedImportees.has(importeeBasename)) {
        return;
      }

      // ── 4. Strict enforcement: report everything else
      context.report({
        node: reportNode,
        messageId: 'noServiceImportingService',
        data: {
          importer: importerBasename,
          imported: importeeBasename,
        },
      });
    }

    return {
      // ESM: import x from './foo.service'
      ImportDeclaration(node) {
        checkRequireSource(node.source.value, node);
      },

      // CJS: require('./foo.service') or require('./foo.service.js')
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string'
        ) {
          checkRequireSource(node.arguments[0].value, node);
        }
      },
    };
  },
};