'use strict';

/**
 * @file src/domain/permission/registry/permission.registry.lifecycle.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 *
 * Lifecycle Visibility (AUTH-04 §5, §6 Governance Lifecycle): "where each
 * Permission currently sits in the Governance Lifecycle — proposed, under
 * review, approved, published, adopted, deprecated, or retired". This
 * module exposes that positioning — it does NOT implement lifecycle
 * transitions, approval, or governance decisions, per this WP's explicit
 * boundary ("Do NOT implement lifecycle transitions/approval/governance").
 *
 * The stage order below is not new architecture — it is exactly the
 * `PERMISSION_STATUS` value order already declared and documented in the
 * certified domain foundation (../permission.constants.js), whose own
 * header comment already states it "is governed by the AUTH-04 §6
 * Governance Lifecycle" and that Review "is not enumerated here as a
 * distinct value" because it precedes Definition and has no persisted
 * status. This module reuses that ordering as data rather than
 * re-deriving or redefining it.
 */

const { PERMISSION_STATUS } = require('../permission.constants');

/**
 * Governance Lifecycle stage order (AUTH-04 §6), restricted to the
 * persisted-status stages `../permission.constants.js` enumerates (Review
 * is a governance activity, not a status — see that module's header
 * comment — and is intentionally absent here for the same reason).
 * @type {ReadonlyArray<string>}
 */
const LIFECYCLE_STAGE_ORDER = Object.freeze([
  PERMISSION_STATUS.PROPOSED,
  PERMISSION_STATUS.APPROVED,
  PERMISSION_STATUS.PUBLISHED,
  PERMISSION_STATUS.ADOPTED,
  PERMISSION_STATUS.DEPRECATED,
  PERMISSION_STATUS.RETIRED,
]);

const LIFECYCLE_STAGE_LABELS = Object.freeze({
  [PERMISSION_STATUS.PROPOSED]: 'Proposed',
  [PERMISSION_STATUS.APPROVED]: 'Approved',
  [PERMISSION_STATUS.PUBLISHED]: 'Published',
  [PERMISSION_STATUS.ADOPTED]: 'Adopted',
  [PERMISSION_STATUS.DEPRECATED]: 'Deprecated',
  [PERMISSION_STATUS.RETIRED]: 'Retired',
});

// Per AUTH-04 §7 "Stable Permission Identity" / "Controlled Permission
// Evolution": Retired is the one stage a Permission does not move on from
// under ordinary governance. Deprecated is deliberately NOT terminal here
// — AUTH-04 §2 describes "deprecation as a deliberate precursor to
// Retirement", i.e. a Permission is expected to continue on to Retired.
const TERMINAL_STAGES = Object.freeze(new Set([PERMISSION_STATUS.RETIRED]));

/**
 * Read-only positioning of a single status within the Governance
 * Lifecycle — visibility only, no transition logic.
 *
 * @param {import('../permission.types').PermissionStatus} status
 * @returns {{status: string, label: string, stageIndex: number, isTerminal: boolean}|null}
 *   null if `status` is not a recognized PERMISSION_STATUS value.
 */
function describeLifecycleStage(status) {
  const stageIndex = LIFECYCLE_STAGE_ORDER.indexOf(status);
  if (stageIndex === -1) return null;

  return Object.freeze({
    status,
    label: LIFECYCLE_STAGE_LABELS[status],
    stageIndex,
    isTerminal: TERMINAL_STAGES.has(status),
  });
}

/**
 * The full ordered set of lifecycle stages, for callers that want to
 * render/inspect the whole Governance Lifecycle rather than a single
 * Permission's position in it.
 * @returns {Array<{status: string, label: string, stageIndex: number, isTerminal: boolean}>}
 */
function listLifecycleStages() {
  return LIFECYCLE_STAGE_ORDER.map((status) => describeLifecycleStage(status));
}

module.exports = {
  LIFECYCLE_STAGE_ORDER,
  describeLifecycleStage,
  listLifecycleStages,
};
