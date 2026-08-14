'use strict';

/**
 * @file src/domain/permission/assignment/permission.assignment.policy.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * ── Why this exists as its own abstraction, separate from Evaluation's policy ──
 * WP-ADMIN-04F-06's review made the separation explicit: "Evaluation
 * answers an authorization question. Assignment answers a grantability
 * question. Those responsibilities must remain separate." Concretely,
 * this means the Assignment layer must NOT branch on an Evaluation
 * Decision's Allow/Deny outcome to decide whether a Permission may be
 * granted — a Retired Permission, for example, is still "evaluable"
 * under `../evaluation/permission.evaluation.policy.js`'s
 * `DefaultEvaluationPolicy` (it resolves to Deny, not an error), but
 * that says nothing about whether *new* Assignments of it should be
 * allowed. This module answers that second, distinct question, fed by
 * the Registry's lifecycle status directly — never by an Evaluation
 * Decision.
 *
 * This is IMPLEMENTATION POLICY, not certified architecture, exactly
 * like the Evaluation matrix it deliberately does not share code or a
 * base class with. It is internal to the Assignment layer only —
 * `PermissionAssignmentService` is the only consumer, injected the same
 * way `registry`/`evaluationEngine`/`assignmentRepository` are.
 *
 * A policy is any object exposing:
 *   - `isAssignable(status)` -> boolean
 * `DefaultAssignmentPolicy` is the only implementation today.
 */

const { PERMISSION_STATUS } = require('../permission.constants');

const { PUBLISHED, ADOPTED } = PERMISSION_STATUS;

// PROPOSED, APPROVED, DEPRECATED, and RETIRED are deliberately absent —
// see class doc below for the reasoning behind each.
const DEFAULT_ASSIGNABLE_STATUSES = Object.freeze(new Set([PUBLISHED, ADOPTED]));

/**
 * @typedef {Object} AssignmentPolicy
 * @property {function(string): boolean} isAssignable
 */

/**
 * The default Assignment Policy:
 *
 *   - PUBLISHED / ADOPTED           -> assignable (governed and active;
 *     the closest match to "grantable" the current lifecycle offers)
 *   - PROPOSED / APPROVED           -> not assignable (not yet
 *     published — same "not yet governed" reasoning
 *     `DefaultEvaluationPolicy` uses for these two statuses; nothing
 *     pre-publication should be granted to anyone yet)
 *   - RETIRED                       -> not assignable (terminal;
 *     granting a retired Permission has no plausible use)
 *   - DEPRECATED                    -> not assignable — the one mapping
 *     I want to flag as the least certain in this matrix. Evaluation
 *     treats Deprecated as still Allow (existing evaluation calls for it
 *     keep working), but Assignment treating it as *not newly
 *     assignable* reflects a common real-world meaning of deprecation
 *     ("stop granting this going forward, let existing usage wind
 *     down"). Nothing in the certified layers or this WP's text states
 *     that rule explicitly — it's my inference of what "deprecated"
 *     conventionally implies for new grants, and it is the one place
 *     where the Assignment and Evaluation matrices intentionally
 *     diverge for the same status. Worth confirming rather than
 *     assuming.
 *
 * @implements {AssignmentPolicy}
 */
class DefaultAssignmentPolicy {
  /**
   * @param {import('../permission.types').PermissionStatus} status
   * @returns {boolean}
   */
  isAssignable(status) {
    return DEFAULT_ASSIGNABLE_STATUSES.has(status);
  }
}

module.exports = {
  DefaultAssignmentPolicy,
  // Convenience singleton, matching this domain's existing singleton
  // convention (Registry/Governance/Evaluation Engine/Evaluation Policy).
  defaultAssignmentPolicy: new DefaultAssignmentPolicy(),
};
