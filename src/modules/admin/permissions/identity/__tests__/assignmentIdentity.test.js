'use strict';

/**
 * @file src/modules/admin/permissions/identity/__tests__/assignmentIdentity.test.js
 *
 * Blocker 3A — Permission Assignment Identity Visibility.
 *
 * The `getUserProfiles`-shaped lookup is injected/mocked entirely — no
 * Supabase, no administrators.repository.js — this is a unit test of
 * the enrichment/fallback logic only.
 */

const { enrichAssignmentsWithIdentity } = require('../assignmentIdentity');

function assignment(overrides = {}) {
  return {
    assignmentIdentity: 'u1::job_listing:view',
    principalId: 'u1',
    permissionIdentity: 'job_listing:view',
    resource: 'job_listing',
    action: 'view',
    assignedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('assignmentIdentity.enrichAssignmentsWithIdentity', () => {
  it('returns the resolved principal.email and principal.displayName for a real user', async () => {
    const getUserProfiles = jest.fn().mockResolvedValue(
      new Map([['u1', { email: 'real@example.com', displayName: 'Real User' }]])
    );

    const [enriched] = await enrichAssignmentsWithIdentity([assignment()], getUserProfiles);

    expect(enriched.principal).toEqual({ id: 'u1', email: 'real@example.com', displayName: 'Real User' });
  });

  it('never mutates or replaces principalId, permissionIdentity, resource, action, or assignedAt', async () => {
    const original = assignment();
    const getUserProfiles = jest.fn().mockResolvedValue(
      new Map([['u1', { email: 'real@example.com', displayName: 'Real User' }]])
    );

    const [enriched] = await enrichAssignmentsWithIdentity([original], getUserProfiles);

    expect(enriched.principalId).toBe('u1');
    expect(enriched.permissionIdentity).toBe('job_listing:view');
    expect(enriched.resource).toBe('job_listing');
    expect(enriched.action).toBe('view');
    expect(enriched.assignedAt).toBe('2026-01-01T00:00:00.000Z');
    // Original input object is untouched.
    expect(original.principal).toBeUndefined();
  });

  it('falls back to a safe unresolved principal when the lookup returns no match', async () => {
    const getUserProfiles = jest.fn().mockResolvedValue(new Map());

    const [enriched] = await enrichAssignmentsWithIdentity([assignment({ principalId: 'ghost' })], getUserProfiles);

    expect(enriched.principal).toEqual({ id: 'ghost', email: null, displayName: null });
  });

  it('does not drop the assignment or throw when the identity lookup itself rejects', async () => {
    const getUserProfiles = jest.fn().mockRejectedValue(new Error('public.users unavailable'));

    const result = await enrichAssignmentsWithIdentity([assignment()], getUserProfiles);

    expect(result).toHaveLength(1);
    expect(result[0].principal).toEqual({ id: 'u1', email: null, displayName: null });
  });

  it('performs exactly one batch lookup, not one per row, for repeated assignments of the same principal', async () => {
    const getUserProfiles = jest.fn().mockResolvedValue(
      new Map([['u1', { email: 'real@example.com', displayName: 'Real User' }]])
    );
    const assignments = [
      assignment({ assignmentIdentity: 'u1::job_listing:view', permissionIdentity: 'job_listing:view', resource: 'job_listing', action: 'view' }),
      assignment({ assignmentIdentity: 'u1::job_listing:create', permissionIdentity: 'job_listing:create', resource: 'job_listing', action: 'create' }),
    ];

    const result = await enrichAssignmentsWithIdentity(assignments, getUserProfiles);

    expect(getUserProfiles).toHaveBeenCalledTimes(1);
    expect(getUserProfiles).toHaveBeenCalledWith(['u1']);
    expect(result.every((a) => a.principal.displayName === 'Real User')).toBe(true);
  });

  it('resolves distinct identities correctly across multiple principals in one batch call', async () => {
    const getUserProfiles = jest.fn().mockResolvedValue(
      new Map([
        ['u1', { email: 'one@example.com', displayName: 'User One' }],
        ['u2', { email: 'two@example.com', displayName: 'User Two' }],
      ])
    );
    const assignments = [
      assignment({ principalId: 'u1', assignmentIdentity: 'u1::job_listing:view' }),
      assignment({ principalId: 'u2', assignmentIdentity: 'u2::job_listing:view' }),
    ];

    const result = await enrichAssignmentsWithIdentity(assignments, getUserProfiles);

    expect(getUserProfiles).toHaveBeenCalledTimes(1);
    expect(getUserProfiles.mock.calls[0][0].sort()).toEqual(['u1', 'u2']);
    expect(result.find((a) => a.principalId === 'u1').principal.displayName).toBe('User One');
    expect(result.find((a) => a.principalId === 'u2').principal.displayName).toBe('User Two');
  });

  it('returns an empty array for an empty assignment list without calling the lookup', async () => {
    const getUserProfiles = jest.fn();

    const result = await enrichAssignmentsWithIdentity([], getUserProfiles);

    expect(result).toEqual([]);
    expect(getUserProfiles).not.toHaveBeenCalled();
  });
});
