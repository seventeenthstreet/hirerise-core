'use strict';

/**
 * @file src/domain/profileReadiness/readinessEngine.js
 *
 * WP-SPCE-02A — Capability Registry Foundation Implementation
 * WP-SPCE-02B — Capability Registry Expression Enhancement
 *
 * Pure evaluator: (capabilityId, profile) -> ReadinessResult, per the design
 * frozen in WP-SPCE-01D §5 ("Readiness Engine Design"), extended in
 * WP-SPCE-02B to evaluate AND/OR expression trees (capabilityRegistry.js's
 * `Expression` type) instead of only a flat list of required fields.
 *
 * Public API is UNCHANGED from WP-SPCE-02A:
 *   evaluate(capabilityId, profile) -> ReadinessResult
 *   UnknownCapabilityError
 * ReadinessResult's shape is also unchanged — { isReady, missingFields,
 * evaluatedAt, capabilityId } — expression-tree evaluation is entirely an
 * internal implementation detail.
 *
 * Pure function only. No database access, no logging, no HTTP, no async, no
 * cache — matching this work package's explicit constraints and WP-SPCE-01D
 * §5's "Thread safety assumptions" / "Caching assumptions" / "Logging
 * policy" sections.
 *
 * This module still has zero consumers as of WP-SPCE-02B. Nothing in
 * production calls evaluate() yet — wiring it into Career Report,
 * Onboarding Completion, or any other capability is out of scope for this
 * work package (see WP-SPCE-01C §10, Phases 2+).
 */

const { getCapability, toExpression } = require('./capabilityRegistry');

/**
 * Thrown when evaluate() is called with a capabilityId that is not present
 * in the Capability Registry. This indicates a caller/programmer error
 * (e.g. a typo'd id), not a normal runtime condition, and is therefore
 * thrown synchronously rather than folded into the result — per
 * WP-SPCE-01D §5 "Error contracts".
 */
class UnknownCapabilityError extends Error {
  /**
   * @param {string} capabilityId
   */
  constructor(capabilityId) {
    super(`Unknown capability id: "${capabilityId}"`);
    this.name = 'UnknownCapabilityError';
    this.capabilityId = capabilityId;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UnknownCapabilityError);
    }
  }
}

/**
 * @typedef {object} ReadinessResult
 * @property {boolean} isReady
 * @property {string[]} missingFields
 * @property {string} evaluatedAt   - ISO-8601 timestamp
 * @property {string} capabilityId
 */

/**
 * Whether a resolved value counts as "present" for readiness purposes.
 *
 *   - null / undefined                -> not present
 *   - empty string ('' or whitespace) -> not present
 *   - empty array ([])                -> not present
 *   - non-empty array                 -> present
 *   - any other non-null value        -> present (numbers, booleans,
 *     non-empty objects, non-empty strings)
 *
 * @param {*} value
 * @returns {boolean}
 */
function _isPresent(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

/**
 * Resolves a dot-path field against a profile object and reports whether
 * the resolved value is present, per _isPresent()'s rule.
 *
 * Null/undefined-safe at every traversal step: a profile that is entirely
 * absent, or missing an intermediate section, resolves every field under it
 * to "not present" rather than throwing — an incomplete profile is a normal
 * state (e.g. a brand-new user), not an error condition. See WP-SPCE-01D
 * §5 "Exception handling".
 *
 * @param {object|null|undefined} profile
 * @param {string} path
 * @returns {boolean}
 */
function _resolveFieldPath(profile, path) {
  let cursor = profile;

  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return false;
    }
    cursor = cursor[segment];
  }

  return _isPresent(cursor);
}

/**
 * @typedef {object} ExpressionEvalResult
 * @property {boolean} satisfied
 * @property {string[]} missingLeaves - unsatisfied leaf field paths
 *   relevant to explaining *this* result (see per-operator semantics below)
 */

/**
 * Recursively evaluates an Expression (capabilityRegistry.js's Expression
 * type) against a profile.
 *
 * Reporting semantics for `missingFields` (WP-SPCE-02B design decision —
 * ReadinessResult's shape is fixed as a flat string[], so a choice has to
 * be made about what an unsatisfied OR group reports):
 *
 *   - AND group: satisfied iff every child is satisfied. When unsatisfied,
 *     missingLeaves is the union of every child's missingLeaves — the user
 *     genuinely needs to address all of them, so reporting all is correct
 *     and unambiguous.
 *
 *   - OR group: satisfied iff at least one child is satisfied (missing =
 *     [] in that case — nothing further is needed). When NO child is
 *     satisfied, reporting every leaf from every branch would overstate
 *     what's needed (it would look like all alternatives are required, not
 *     just one). Instead, this reports the single branch with the fewest
 *     missing leaves — i.e. the alternative the user is closest to
 *     completing — as the most actionable guidance. Ties are broken by
 *     declaration order (first-listed child wins).
 *
 * @param {*} expr
 * @param {object|null|undefined} profile
 * @returns {ExpressionEvalResult}
 */
function _evaluateExpression(expr, profile) {
  if (typeof expr === 'string') {
    const present = _resolveFieldPath(profile, expr);
    return { satisfied: present, missingLeaves: present ? [] : [expr] };
  }

  if (expr && Array.isArray(expr.all)) {
    const childResults = expr.all.map((child) => _evaluateExpression(child, profile));
    const satisfied = childResults.every((r) => r.satisfied);
    const missingLeaves = childResults.flatMap((r) => r.missingLeaves);
    return { satisfied, missingLeaves };
  }

  if (expr && Array.isArray(expr.any)) {
    const childResults = expr.any.map((child) => _evaluateExpression(child, profile));
    const satisfied = childResults.some((r) => r.satisfied);
    if (satisfied) {
      return { satisfied: true, missingLeaves: [] };
    }
    let closest = childResults[0];
    for (const result of childResults) {
      if (result.missingLeaves.length < closest.missingLeaves.length) {
        closest = result;
      }
    }
    return { satisfied: false, missingLeaves: closest.missingLeaves };
  }

  // A malformed expression node reaching here is a registry-authoring bug
  // that validateRegistry() (run in CI, per WP-SPCE-01D §10) exists to
  // catch before this code ever runs against a real profile. Defensively
  // treat it as unsatisfiable rather than throwing — a malformed *data*
  // shape in the registry is a build-time concern, not a reason for a
  // runtime call to evaluate() to crash for an end user.
  return { satisfied: false, missingLeaves: ['<malformed expression node>'] };
}

/**
 * Evaluates whether `profile` satisfies `capabilityId`'s declared
 * requirements (either a legacy flat `requiredFields` list or a
 * WP-SPCE-02B `requires` expression tree — both normalized to the same
 * Expression form by capabilityRegistry.js#toExpression before evaluation).
 *
 * @param {string} capabilityId - must be a key returned by
 *   capabilityRegistry.listCapabilityIds()
 * @param {object} profile - the canonical Professional Profile shape (see
 *   professionalProfile.schema.js#emptyProfessionalProfile), or null/
 *   undefined for a profile that does not yet exist
 * @returns {ReadinessResult}
 * @throws {UnknownCapabilityError} if capabilityId is not registered
 */
function evaluate(capabilityId, profile) {
  let capability;
  try {
    capability = getCapability(capabilityId);
  } catch (_err) {
    // capabilityRegistry.getCapability() throws a plain Error by design
    // (see its own file header) — re-thrown here as the typed error this
    // module's public contract promises.
    throw new UnknownCapabilityError(capabilityId);
  }

  const expression = toExpression(capability);
  const { satisfied, missingLeaves } = _evaluateExpression(expression, profile);

  return {
    isReady: satisfied,
    missingFields: Array.from(new Set(missingLeaves)),
    evaluatedAt: new Date().toISOString(),
    capabilityId,
  };
}

module.exports = {
  evaluate,
  UnknownCapabilityError,
};
