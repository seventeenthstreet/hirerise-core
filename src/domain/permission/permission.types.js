'use strict';

/**
 * @file src/domain/permission/permission.types.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 *
 * JSDoc-only type definitions for the Permission domain's shared shapes
 * (AUTH-01 §3.2, §3.4, §3.5, §3.7, §3.8, §3.9; AUTH-04 §4). This
 * repository's existing convention (per WP-STD-IMP-02A §3, followed by
 * studentProfile.types.js) does not use dedicated TypeScript types for
 * domain shapes — this file follows that same JSDoc-typedef convention so
 * permission.model.js, permission.validation.js, and future work packages
 * can all `@typedef {import('./permission.types').Permission}` instead of
 * repeating the shape in every file's JSDoc.
 *
 * This file exports nothing at runtime — it exists purely for IDE/JSDoc
 * tooling. `module.exports = {}` is present only so `require()` does not
 * error if a file requires it by convention.
 */

/**
 * A Resource value, per AUTH-01 §3.4 — always one of
 * `permission.constants.js`'s `RESOURCES` values.
 * @typedef {string} Resource
 */

/**
 * An Action value, per AUTH-01 §3.5 — always one of
 * `permission.constants.js`'s `ACTIONS` values.
 * @typedef {string} Action
 */

/**
 * A Permission Category value, per AUTH-01 §3.7 — always one of
 * `permission.constants.js`'s `PERMISSION_CATEGORIES` values.
 * @typedef {string} PermissionCategory
 */

/**
 * A Permission Status value, per AUTH-04 §4/§6 — always one of
 * `permission.constants.js`'s `PERMISSION_STATUS` values.
 * @typedef {string} PermissionStatus
 */

/**
 * An Authorization Decision outcome, per AUTH-03 §4 — always one of
 * `permission.constants.js`'s `AUTHORIZATION_DECISIONS` values.
 * @typedef {string} AuthorizationDecisionOutcome
 */

/**
 * A named, independently-grantable capability to perform a specific
 * Action against a specific class of Resource (AUTH-01 §3.2). `name` is
 * the Permission's stable, unique identifier within the shared
 * vocabulary — `${resource}:${action}` — per AUTH-04 §7's Stable
 * Permission Identity principle.
 *
 * @typedef {Object} Permission
 * @property {string} name - canonical identifier, `${resource}:${action}`
 * @property {Resource} resource
 * @property {Action} action
 * @property {PermissionCategory|null} category - optional administrative
 *   grouping (AUTH-01 §3.7 — a Permission Category is a lens on
 *   Permissions, not required for a Permission to exist)
 * @property {PermissionStatus} status
 * @property {string|null} description - optional human-readable summary
 */

/**
 * The situational information an Authorization Decision is made within,
 * beyond the bare fact that a User holds a Permission (AUTH-01 §3.8).
 * Deliberately minimal per §3.8 — User, Resource, and Action are
 * sufficient for present-day decisions; `metadata` is the seam future
 * evolution (organization/team scope, per AUTH-01 §3.8 Relationships)
 * extends through, without disturbing this shape.
 *
 * @typedef {Object} AuthorizationContext
 * @property {string} userId - the actor the decision is made on behalf of
 * @property {Resource} resource
 * @property {Action} action
 * @property {string|null} [resourceId] - optional identifier of the
 *   specific Resource instance being acted on, when the decision concerns
 *   one instance rather than the Resource class as a whole
 * @property {Object.<string, *>} [metadata] - additional situational
 *   detail (empty today; the extension seam AUTH-01 §3.8 describes)
 */

/**
 * The conceptual outcome of determining whether a given User may perform
 * a given Action on a given Resource, within a given Authorization
 * Context (AUTH-01 §3.9; AUTH-03 §4). This type packages the decision's
 * inputs and outcome for consumption by a future evaluation component —
 * it carries no evaluation logic of its own, per WP-ADMIN-04F-01's scope
 * boundary.
 *
 * @typedef {Object} AuthorizationDecision
 * @property {AuthorizationDecisionOutcome} outcome
 * @property {AuthorizationContext} context
 * @property {string|null} reason - optional explanation for the outcome
 *   (e.g. which Permission Resolution result produced an Allow, per
 *   AUTH-03 §4's Explicit Grant principle, or why a Deny was reached)
 * @property {string} decidedAt - ISO timestamp the decision was produced
 */

module.exports = {};
