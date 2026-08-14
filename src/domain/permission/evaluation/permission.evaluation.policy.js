'use strict';

/**
 * @file src/domain/permission/evaluation/permission.evaluation.policy.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine (Architectural Refinement)
 *
 * The lifecycle evaluability matrix, extracted out of
 * `permission.evaluation.engine.js` into its own component. This is
 * IMPLEMENTATION POLICY, not certified architecture — see this WP's
 * "Architectural Justification — Evaluability Matrix" review: only
 * Retired -> Deny has direct grounding in what the certified layers'
 * comments cite from AUTH-03/AUTH-04; the Proposed/Approved -> error
 * boundary is a reasonable-but-unverified inference from "only governed
 * Permissions may be evaluated"; and Deprecated -> Allow is the weakest
 * mapping in the set, chosen only from the absence of a stated rule.
 *
 * This module exists so that policy is swappable without touching the
 * Engine's evaluation flow (Registry lookup, Domain construction,
 * Decision Explanation) — the Engine asks the policy two questions
 * (`isEvaluable`, `decide`) and does not itself know or care what
 * lifecycle statuses mean. Per the review's instruction, the policy
 * remains INTERNAL to the Evaluation layer: no configuration surface, no
 * persistence, no API, no UI. Swapping policy today means constructing
 * `AuthorizationEvaluationEngine` with a different policy object in code
 * — exactly the same constructor-injection convention every other layer
 * in this domain already uses for its upstream dependency.
 *
 * A policy is any object exposing:
 *   - `isEvaluable(status)`      -> boolean
 *   - `decide(entry)`            -> { outcome, reason }
 * `DefaultEvaluationPolicy` is the only implementation today, and
 * reproduces the Engine's prior hardcoded behavior exactly — this
 * refactor changes where the matrix lives, not what it decides.
 */

const { PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../permission.constants');

const { PUBLISHED, ADOPTED, DEPRECATED, RETIRED } = PERMISSION_STATUS;

// PROPOSED and APPROVED are deliberately absent from every set below —
// they are not evaluable under the default policy (see class doc).
const DEFAULT_EVALUABLE_STATUSES = Object.freeze(new Set([PUBLISHED, ADOPTED, DEPRECATED, RETIRED]));

/**
 * @typedef {Object} EvaluationPolicyOutcome
 * @property {import('../permission.types').AuthorizationDecisionOutcome} outcome
 * @property {string} reason
 */

/**
 * @typedef {Object} EvaluationPolicy
 * @property {function(string): boolean} isEvaluable
 * @property {function(Object): EvaluationPolicyOutcome} decide
 */

/**
 * The default Evaluation Policy — reproduces the evaluability matrix
 * previously hardcoded in `permission.evaluation.engine.js`, unchanged:
 *
 *   - PROPOSED / APPROVED -> not evaluable (Engine raises
 *     `PermissionNotEvaluableError`)
 *   - PUBLISHED / ADOPTED -> Allow
 *   - DEPRECATED          -> Allow (flagged as deprecated)
 *   - RETIRED             -> Deny
 *
 * @implements {EvaluationPolicy}
 */
class DefaultEvaluationPolicy {
  /**
   * Whether a Permission in this lifecycle status can be evaluated at
   * all. A `false` result tells the Engine to raise
   * `PermissionNotEvaluableError` rather than call `decide()`.
   * @param {import('../permission.types').PermissionStatus} status
   * @returns {boolean}
   */
  isEvaluable(status) {
    return DEFAULT_EVALUABLE_STATUSES.has(status);
  }

  /**
   * Determines the Allow/Deny outcome and human-readable reason for an
   * already-resolved, evaluable Registry entry. Pure — no I/O, so the
   * same entry always produces the same outcome (deterministic
   * evaluation, repeated-evaluation consistency). Never called for a
   * status `isEvaluable()` reports `false` for.
   * @param {import('../registry/permission.registry').PermissionRegistryEntry} entry
   * @returns {EvaluationPolicyOutcome}
   */
  decide(entry) {
    if (entry.status === RETIRED) {
      return {
        outcome: AUTHORIZATION_DECISIONS.DENY,
        reason: `Permission "${entry.identity}" is retired; no active grant exists`,
      };
    }
    if (entry.status === DEPRECATED) {
      return {
        outcome: AUTHORIZATION_DECISIONS.ALLOW,
        reason: `Permission "${entry.identity}" is deprecated but still governed and in force`,
      };
    }
    return {
      outcome: AUTHORIZATION_DECISIONS.ALLOW,
      reason: `Permission "${entry.identity}" is governed and active (status "${entry.status}")`,
    };
  }
}

module.exports = {
  DefaultEvaluationPolicy,
  // Convenience singleton, matching this domain's existing
  // Registry/Governance/Engine singleton convention.
  defaultEvaluationPolicy: new DefaultEvaluationPolicy(),
};
