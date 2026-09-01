'use strict';

/**
 * @file src/modules/admin/permissions/identity/assignmentIdentity.js
 *
 * Blocker 3A — Permission Assignment Identity Visibility.
 *
 * Presentation-only enrichment: resolves the real user (public.users)
 * behind each Assignment's `principalId`, so the Permission Management
 * UI can show a name/email instead of an opaque id. This file never
 * touches Assignment persistence, Permission RBAC, or Administrator
 * lifecycle — see the Blocker 3A prompt's Hard Scope Freeze.
 *
 * Identity source: reuses the established, certified identity-resolution
 * pattern already built for Administrator Management —
 * administrators.repository.js#getUserProfiles() — rather than
 * introducing a new identity directory. Verified appropriate for the
 * `principalId` identifier space (not assumed): PrincipalPicker.tsx,
 * the only place a principalId is ever chosen from, selects it from
 * `useAdminUsersList` (lib/api/adminUsers.ts's `AdminUserListItem.id`),
 * the same Admin User Directory / `public.users` read that
 * `getUserProfiles()` targets — both resolve against `public.users.id`.
 * Permission Principal identity and Administrator lifecycle identity
 * remain separate concepts; only the read-only `public.users` lookup is
 * shared, not any lifecycle semantics.
 *
 * Batch, not N+1: every unique `principalId` across the Assignment list
 * is resolved in a single call, regardless of how many rows reference
 * the same principal.
 */

const administratorsRepository = require('../../administrators/administrators.repository');

/**
 * @param {string[]} principalIds
 * @returns {Promise<Map<string, {email: string|null, displayName: string|null}>>}
 */
function defaultGetUserProfiles(principalIds) {
  return administratorsRepository.getUserProfiles(principalIds);
}

/**
 * Builds the safe `principal` view for one Assignment. Never throws —
 * a missing or failed lookup falls back to nulls rather than dropping
 * the Assignment (Phase 3 of the Blocker 3A prompt: "handle missing
 * identity safely").
 * @private
 */
function toPrincipalView(principalId, profile) {
  return {
    id: principalId,
    email: profile?.email ?? null,
    displayName: profile?.displayName ?? null,
  };
}

/**
 * Enriches a list of Assignments with each one's resolved `principal`
 * (id/email/displayName), via a single batch lookup covering every
 * unique `principalId` present. Does not mutate the input Assignments
 * and never alters `principalId`, `permissionIdentity`, `resource`,
 * `action`, or `assignedAt` — this is enrichment, not a semantics
 * change (Phase 4 of the Blocker 3A prompt).
 *
 * @param {Array<{principalId: string}>} assignments
 * @param {(principalIds: string[]) => Promise<Map<string, {email: string|null, displayName: string|null}>>} [getUserProfiles]
 *   Defaults to the certified administrators.repository#getUserProfiles.
 * @returns {Promise<Array<Object>>}
 */
async function enrichAssignmentsWithIdentity(assignments, getUserProfiles = defaultGetUserProfiles) {
  if (!assignments || assignments.length === 0) return assignments ?? [];

  const uniquePrincipalIds = [...new Set(assignments.map((a) => a.principalId))];

  let profiles;
  try {
    profiles = await getUserProfiles(uniquePrincipalIds);
  } catch {
    // Identity lookup failing must never break the Assignment list.
    // Every row falls back to an unresolved `principal` below.
    profiles = new Map();
  }
  if (!(profiles instanceof Map)) {
    profiles = new Map();
  }

  return assignments.map((assignment) => ({
    ...assignment,
    principal: toPrincipalView(assignment.principalId, profiles.get(assignment.principalId)),
  }));
}

module.exports = {
  enrichAssignmentsWithIdentity,
};
