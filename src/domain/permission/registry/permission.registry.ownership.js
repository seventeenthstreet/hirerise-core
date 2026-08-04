'use strict';

/**
 * @file src/domain/permission/registry/permission.registry.ownership.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 *
 * Capability Ownership (AUTH-04 §3.1, §7 "Capability Ownership", §9
 * "Future Enterprise Readiness"): "individual capability domains own the
 * Resources and Actions specific to their area, and propose the
 * Permissions built from them". This module represents that ownership —
 * it does NOT implement an ownership workflow (no proposal, transfer, or
 * conflict-resolution process), per this WP's explicit "Do NOT implement
 * ownership workflows" boundary.
 *
 * The mapping below is not new architecture — it is a direct, faithful
 * transcription of the capability-domain attributions already recorded as
 * comments on every `RESOURCES` entry in the certified domain foundation
 * (../permission.constants.js), which in turn match AUTH-04 §9's roster
 * of onboarded capability domains (Administration, CMS, Jobs, Skills, AI
 * Services, Resume Intelligence, Snapshot Intelligence) exactly. This
 * module exists only so that mapping is programmatically queryable
 * instead of living solely in a source comment — it introduces no
 * ownership information the domain layer didn't already assert.
 */

const { RESOURCES } = require('../permission.constants');

/**
 * Resource -> owning capability domain, per AUTH-01 §3.4 Ownership
 * ("each capability domain owns the definition of its own Resource
 * types") as already attributed in permission.constants.js.
 * @type {Readonly<Record<string, string>>}
 */
const CAPABILITY_OWNERSHIP = Object.freeze({
  [RESOURCES.USER]: 'Administration',
  [RESOURCES.ADMINISTRATION]: 'Administration',
  [RESOURCES.CMS_ENTRY]: 'CMS',
  [RESOURCES.JOB_LISTING]: 'Jobs',
  [RESOURCES.SKILL]: 'Skills',
  [RESOURCES.AI_FEATURE]: 'AI Services',
  [RESOURCES.RESUME]: 'Resume Intelligence',
  [RESOURCES.SNAPSHOT]: 'Snapshot Intelligence',
});

/**
 * The full set of capability domain names currently recognized, per
 * AUTH-04 §9's onboarded-domain roster.
 * @type {ReadonlyArray<string>}
 */
const CAPABILITY_DOMAINS = Object.freeze([...new Set(Object.values(CAPABILITY_OWNERSHIP))]);

/**
 * Resolves the capability domain that owns a given Resource, per
 * Capability Ownership (AUTH-04 §3.1/§7).
 *
 * @param {import('../permission.types').Resource} resource
 * @returns {string|null} the owning capability domain, or null if the
 *   Resource is not one of the currently-recognized RESOURCES values
 *   (this function is read-only lookup, not validation — an unrecognized
 *   Resource would already have been rejected upstream by the domain
 *   layer's own `validateResource()`).
 */
function resolveCapabilityOwner(resource) {
  return CAPABILITY_OWNERSHIP[resource] ?? null;
}

module.exports = {
  CAPABILITY_OWNERSHIP,
  CAPABILITY_DOMAINS,
  resolveCapabilityOwner,
};
