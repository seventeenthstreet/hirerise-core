'use strict';

/**
 * @file src/domain/permission/governance/permission.governance.lifecycle.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 *
 * Lifecycle Transition Validation (AUTH-04 §6 Governance Lifecycle): unlike
 * the Registry's `permission.registry.lifecycle.js`, which only exposes
 * *where* a Permission currently sits (read-only Lifecycle Visibility),
 * this module is the Governance layer's own concern — *whether a proposed
 * move to a new stage is legal*. It reuses the Registry's
 * `LIFECYCLE_STAGE_ORDER` as the single source of truth for stage
 * ordering rather than re-declaring it, per this WP's "Do NOT duplicate
 * Registry logic" boundary.
 *
 * The Governance Lifecycle is a strictly sequential, forward-only state
 * machine (AUTH-04 §6: Proposal -> Approval -> Publication -> Adoption ->
 * Deprecation -> Retirement). Every transition must move exactly one
 * stage forward; skipping stages, moving backward, or acting on a
 * terminal (Retired) Permission is invalid.
 */

const { LIFECYCLE_STAGE_ORDER } = require('../registry/permission.registry.lifecycle');
const { PERMISSION_STATUS } = require('../permission.constants');

// Retired is the one stage the Governance Lifecycle does not move on
// from — see permission.registry.lifecycle.js's TERMINAL_STAGES for the
// same determination, reused here rather than re-derived.
const TERMINAL_STATUSES = Object.freeze(new Set([PERMISSION_STATUS.RETIRED]));

/**
 * Whether `toStatus` is a legal next stage from `fromStatus` under the
 * AUTH-04 §6 Governance Lifecycle: exactly one stage forward, never
 * backward, never skipped, and never out of a terminal stage.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isValidLifecycleTransition(fromStatus, toStatus) {
  const fromIndex = LIFECYCLE_STAGE_ORDER.indexOf(fromStatus);
  const toIndex = LIFECYCLE_STAGE_ORDER.indexOf(toStatus);

  if (fromIndex === -1 || toIndex === -1) return false;
  if (TERMINAL_STATUSES.has(fromStatus)) return false;

  return toIndex === fromIndex + 1;
}

/**
 * The single legal next stage from `status`, or null if `status` is
 * unrecognized or terminal.
 *
 * @param {string} status
 * @returns {string|null}
 */
function getNextLifecycleStatus(status) {
  const index = LIFECYCLE_STAGE_ORDER.indexOf(status);
  if (index === -1 || TERMINAL_STATUSES.has(status)) return null;
  return LIFECYCLE_STAGE_ORDER[index + 1] ?? null;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalLifecycleStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = {
  isValidLifecycleTransition,
  getNextLifecycleStatus,
  isTerminalLifecycleStatus,
};
