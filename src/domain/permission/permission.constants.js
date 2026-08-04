'use strict';

/**
 * @file src/domain/permission/permission.constants.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 *
 * Centralized enterprise constants for the Permission Management System.
 * This is the single shared vocabulary AUTH-01 through AUTH-04 describe —
 * every later Permission Management work package (registry, repository,
 * evaluator, APIs, UI) is expected to consume these values rather than
 * re-declaring its own.
 *
 * Authoritative inputs:
 *   - AUTH-01 §3.4 (Resource), §3.5 (Action), §3.7 (Permission Category)
 *   - AUTH-02 §6 (Permission Lifecycle — Definition, Availability,
 *     Assignment, Usage, Review, Revocation, Retirement)
 *   - AUTH-03 §4 (Authorization Decision Model — Allow / Deny)
 *   - AUTH-04 §4 (Permission Registry "Permission Status" responsibility),
 *     §6 (Governance Lifecycle — Proposal, Review, Approval, Publication,
 *     Adoption, Deprecation, Retirement)
 *
 * This module is pure data. No evaluation logic, no policy logic, per
 * WP-ADMIN-04F-01's explicit scope boundary.
 */

// ─────────────────────────────────────────────────────────────────────────
// Resource — AUTH-01 §3.4. The "what" half of the Resource + Action
// vocabulary. Each key below is owned by the capability domain named in
// its comment, per AUTH-01 §3.4 Ownership ("each capability domain owns
// the definition of its own Resource types").
// ─────────────────────────────────────────────────────────────────────────
const RESOURCES = Object.freeze({
  USER: 'user', // Administration (Enterprise User Management)
  ADMINISTRATION: 'administration', // Administration
  CMS_ENTRY: 'cms_entry', // CMS
  JOB_LISTING: 'job_listing', // Jobs
  SKILL: 'skill', // Skills
  AI_FEATURE: 'ai_feature', // AI Services
  RESUME: 'resume', // Resume Intelligence
  SNAPSHOT: 'snapshot', // Snapshot Intelligence
});

const VALID_RESOURCES = Object.freeze(Object.values(RESOURCES));

// ─────────────────────────────────────────────────────────────────────────
// Action — AUTH-01 §3.5. The "what can be done" half of the vocabulary.
// CORE_ACTIONS is the stable, platform-wide verb set (AUTH-01 §3.5
// Lifecycle: "expected to be stable platform-wide"); the remaining entries
// in ACTIONS are illustrative domain-specific verbs named directly in
// AUTH-01 §3.5 ("a domain-specific verb such as publish or approve").
// Capability domains may propose further domain-specific Actions subject
// to the same central governance as Permission itself (AUTH-01 §3.5
// Ownership) — that governance process is out of this WP's scope.
// ─────────────────────────────────────────────────────────────────────────
const CORE_ACTIONS = Object.freeze({
  VIEW: 'view',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
});

const ACTIONS = Object.freeze({
  ...CORE_ACTIONS,
  PUBLISH: 'publish',
  APPROVE: 'approve',
});

const VALID_ACTIONS = Object.freeze(Object.values(ACTIONS));

// ─────────────────────────────────────────────────────────────────────────
// Permission Category — AUTH-01 §3.7. Administrative grouping only; "does
// not itself grant access" (§3.7 Responsibilities). Tracks the platform's
// existing capability-domain boundaries per §3.7 Lifecycle.
// ─────────────────────────────────────────────────────────────────────────
const PERMISSION_CATEGORIES = Object.freeze({
  ADMINISTRATION: 'administration',
  CMS: 'cms',
  JOBS: 'jobs',
  SKILLS: 'skills',
  RESUME_INTELLIGENCE: 'resume_intelligence',
  SNAPSHOT_INTELLIGENCE: 'snapshot_intelligence',
  AI_SERVICES: 'ai_services',
});

const VALID_PERMISSION_CATEGORIES = Object.freeze(Object.values(PERMISSION_CATEGORIES));

// ─────────────────────────────────────────────────────────────────────────
// Permission Status — the domain representation of the Permission
// lifecycle status, per AUTH-04 §4's "Permission Status" registry
// responsibility ("where a Permission currently sits — proposed,
// approved, published, adopted, deprecated, or retired") and governed by
// the AUTH-04 §6 Governance Lifecycle (Proposal, Review, Approval,
// Publication, Adoption, Deprecation, Retirement stages). REVIEW is a
// governance activity performed on a PROPOSED permission rather than a
// status the permission itself rests in (AUTH-04 §6 — Review precedes
// Definition and has no persisted-status counterpart), so it is not
// enumerated here as a distinct value.
// ─────────────────────────────────────────────────────────────────────────
const PERMISSION_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  ADOPTED: 'adopted',
  DEPRECATED: 'deprecated',
  RETIRED: 'retired',
});

const VALID_PERMISSION_STATUSES = Object.freeze(Object.values(PERMISSION_STATUS));

// ─────────────────────────────────────────────────────────────────────────
// Authorization Decision — AUTH-03 §4. Every evaluation produces exactly
// one of two outcomes. Default Deny and Explicit Grant (AUTH-03 §4) are
// governing principles of how an outcome is reached, not additional
// outcome values, so only Allow/Deny are enumerated.
// ─────────────────────────────────────────────────────────────────────────
const AUTHORIZATION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
});

const VALID_AUTHORIZATION_DECISIONS = Object.freeze(Object.values(AUTHORIZATION_DECISIONS));

module.exports = Object.freeze({
  RESOURCES,
  VALID_RESOURCES,
  CORE_ACTIONS,
  ACTIONS,
  VALID_ACTIONS,
  PERMISSION_CATEGORIES,
  VALID_PERMISSION_CATEGORIES,
  PERMISSION_STATUS,
  VALID_PERMISSION_STATUSES,
  AUTHORIZATION_DECISIONS,
  VALID_AUTHORIZATION_DECISIONS,
});
