'use strict';

/**
 * @file src/domain/permission/repository/__tests__/permission.repository.test.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 *
 * Exercises the real SupabasePermissionRepository code path against the
 * shared in-memory Supabase fake — same pattern as
 * professionalCareerProfile.repository.test.js /
 * studentIntelligence.repository.test.js.
 */

const { createSupabaseMock } = require('../../../../modules/knowledge-runtime/knowledge/testHelpers/supabaseMock');
const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS } = require('../../permission.constants');
const {
  PermissionDuplicateError,
  PermissionRepositoryValidationError,
  PermissionMappingError,
} = require('../permission.repository.errors');
const { InvalidResourceError } = require('../../permission.errors');

// A live getter (rather than a resetModules()+re-require cycle, per
// professionalCareerProfile.repository.test.js's pattern) so the SAME
// SupabasePermissionRepository module instance — and therefore the SAME
// error class objects this file imports above — is used for every test.
// getSupabase() in permission.repository.js re-reads `.supabase` on every
// call (it's a lazy require), so reassigning the global between tests is
// enough to swap the backing dataset without ever clearing the module
// registry.
jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return global.__permissionRepositorySupabaseMock;
  },
}));

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { SupabasePermissionRepository } = require('../permission.repository');

function seedRow(overrides = {}) {
  return {
    id: overrides.id ?? 'seed-1',
    name: 'job_listing:view',
    resource: RESOURCES.JOB_LISTING,
    action: ACTIONS.VIEW,
    category: PERMISSION_CATEGORIES.JOBS,
    status: PERMISSION_STATUS.PROPOSED,
    description: 'View job listings',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SupabasePermissionRepository', () => {
  let repo;

  function seed(rows = []) {
    global.__permissionRepositorySupabaseMock = createSupabaseMock({ permissions: rows });
    repo = new SupabasePermissionRepository();
  }

  beforeEach(() => {
    seed([]);
  });

  describe('create', () => {
    it('persists a new Permission built via the domain factory', async () => {
      const created = await repo.create({
        resource: RESOURCES.SKILL,
        action: ACTIONS.CREATE,
        category: PERMISSION_CATEGORIES.SKILLS,
        description: 'Create a skill',
      });

      expect(created.name).toBe('skill:create');
      expect(created.resource).toBe(RESOURCES.SKILL);
      expect(created.action).toBe(ACTIONS.CREATE);
      expect(created.status).toBe(PERMISSION_STATUS.PROPOSED);
      expect(created.id).toBeTruthy();
      expect(created.createdAt).toBeTruthy();
      expect(created.updatedAt).toBeTruthy();
      expect(Object.isFrozen(created)).toBe(true);
    });

    it('defaults status to PROPOSED', async () => {
      const created = await repo.create({ resource: RESOURCES.SKILL, action: ACTIONS.VIEW });
      expect(created.status).toBe(PERMISSION_STATUS.PROPOSED);
    });

    it('rejects invalid domain input before touching the database', async () => {
      await expect(repo.create({ resource: 'nope', action: ACTIONS.VIEW })).rejects.toThrow(InvalidResourceError);
    });

    it('throws PermissionDuplicateError when the name already exists', async () => {
      seed([seedRow({ id: 'existing', name: 'job_listing:view', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW })]);

      await expect(
        repo.create({ resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW })
      ).rejects.toThrow(PermissionDuplicateError);
    });
  });

  describe('findById / findByName', () => {
    it('findById returns the mapped Permission when it exists', async () => {
      seed([seedRow({ id: 'p-1' })]);
      const found = await repo.findById('p-1');
      expect(found).not.toBeNull();
      expect(found.id).toBe('p-1');
      expect(found.name).toBe('job_listing:view');
    });

    it('findById returns null for a missing id', async () => {
      const found = await repo.findById('does-not-exist');
      expect(found).toBeNull();
    });

    it('findByName returns the mapped Permission when it exists', async () => {
      seed([seedRow({ id: 'p-1', name: 'job_listing:view' })]);
      const found = await repo.findByName('job_listing:view');
      expect(found).not.toBeNull();
      expect(found.id).toBe('p-1');
    });

    it('findByName returns null for a missing name', async () => {
      const found = await repo.findByName('does_not:exist');
      expect(found).toBeNull();
    });

    it('rejects an empty string id/name with PermissionRepositoryValidationError', async () => {
      await expect(repo.findById('')).rejects.toThrow(PermissionRepositoryValidationError);
      await expect(repo.findByName('')).rejects.toThrow(PermissionRepositoryValidationError);
    });

    it('throws PermissionMappingError for a corrupt persisted row', async () => {
      seed([seedRow({ id: 'bad', resource: 'not-a-real-resource' })]);
      await expect(repo.findById('bad')).rejects.toThrow(PermissionMappingError);
    });
  });

  describe('existsById / existsByName', () => {
    it('existsById is true/false correctly', async () => {
      seed([seedRow({ id: 'p-1' })]);
      expect(await repo.existsById('p-1')).toBe(true);
      expect(await repo.existsById('nope')).toBe(false);
    });

    it('existsByName is true/false correctly', async () => {
      seed([seedRow({ id: 'p-1', name: 'job_listing:view' })]);
      expect(await repo.existsByName('job_listing:view')).toBe(true);
      expect(await repo.existsByName('nope:nope')).toBe(false);
    });
  });

  describe('update', () => {
    it('updates status/category/description and returns the mapped result', async () => {
      seed([seedRow({ id: 'p-1' })]);

      const updated = await repo.update('p-1', {
        status: PERMISSION_STATUS.APPROVED,
        category: PERMISSION_CATEGORIES.CMS,
        description: 'Updated',
      });

      expect(updated.status).toBe(PERMISSION_STATUS.APPROVED);
      expect(updated.category).toBe(PERMISSION_CATEGORIES.CMS);
      expect(updated.description).toBe('Updated');
      // resource/action/name unchanged — immutable identity
      expect(updated.name).toBe('job_listing:view');
    });

    it('returns null when id does not exist', async () => {
      const updated = await repo.update('missing', { status: PERMISSION_STATUS.APPROVED });
      expect(updated).toBeNull();
    });

    it('rejects an update with no updatable fields', async () => {
      seed([seedRow({ id: 'p-1' })]);
      await expect(repo.update('p-1', {})).rejects.toThrow(PermissionRepositoryValidationError);
    });

    it('rejects an update with an invalid status', async () => {
      seed([seedRow({ id: 'p-1' })]);
      await expect(repo.update('p-1', { status: 'not-a-status' })).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('deletes an existing row and returns true', async () => {
      seed([seedRow({ id: 'p-1' })]);
      const result = await repo.delete('p-1');
      expect(result).toBe(true);
      expect(await repo.findById('p-1')).toBeNull();
    });

    it('returns false when the id does not exist', async () => {
      seed([seedRow({ id: 'p-1' })]);
      const result = await repo.delete('does-not-exist');
      expect(result).toBe(false);
      // existing row untouched
      expect(await repo.findById('p-1')).not.toBeNull();
    });
  });

  describe('lookups by resource / action / category / status', () => {
    beforeEach(() => {
      seed([
        seedRow({ id: 'a', name: 'job_listing:view', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, category: PERMISSION_CATEGORIES.JOBS, status: PERMISSION_STATUS.PROPOSED }),
        seedRow({ id: 'b', name: 'job_listing:create', resource: RESOURCES.JOB_LISTING, action: ACTIONS.CREATE, category: PERMISSION_CATEGORIES.JOBS, status: PERMISSION_STATUS.APPROVED }),
        seedRow({ id: 'c', name: 'skill:view', resource: RESOURCES.SKILL, action: ACTIONS.VIEW, category: PERMISSION_CATEGORIES.SKILLS, status: PERMISSION_STATUS.PROPOSED }),
      ]);
    });

    it('findByResource returns only matching rows with a total', async () => {
      const { items, total } = await repo.findByResource(RESOURCES.JOB_LISTING);
      expect(total).toBe(2);
      expect(items.map((p) => p.id).sort()).toEqual(['a', 'b']);
    });

    it('findByAction returns only matching rows', async () => {
      const { items, total } = await repo.findByAction(ACTIONS.VIEW);
      expect(total).toBe(2);
      expect(items.map((p) => p.id).sort()).toEqual(['a', 'c']);
    });

    it('findByCategory returns only matching rows', async () => {
      const { items, total } = await repo.findByCategory(PERMISSION_CATEGORIES.SKILLS);
      expect(total).toBe(1);
      expect(items[0].id).toBe('c');
    });

    it('findByStatus returns only matching rows', async () => {
      const { items, total } = await repo.findByStatus(PERMISSION_STATUS.APPROVED);
      expect(total).toBe(1);
      expect(items[0].id).toBe('b');
    });

    it('list returns every row, paginated', async () => {
      const { items, total } = await repo.list();
      expect(total).toBe(3);
      expect(items).toHaveLength(3);
    });

    it('empty result: findByResource returns an empty list with total 0 for an unmatched resource', async () => {
      const { items, total } = await repo.findByResource(RESOURCES.CMS_ENTRY);
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it('rejects an empty string lookup value', async () => {
      await expect(repo.findByResource('')).rejects.toThrow(PermissionRepositoryValidationError);
      await expect(repo.findByAction('')).rejects.toThrow(PermissionRepositoryValidationError);
      await expect(repo.findByCategory('')).rejects.toThrow(PermissionRepositoryValidationError);
      await expect(repo.findByStatus('')).rejects.toThrow(PermissionRepositoryValidationError);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      seed([
        seedRow({ id: 'a', name: 'job_listing:view', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, description: 'View job listings' }),
        seedRow({ id: 'b', name: 'skill:create', resource: RESOURCES.SKILL, action: ACTIONS.CREATE, description: 'Add a new skill entry' }),
      ]);
    });

    it('matches on name', async () => {
      const { items, total } = await repo.search('job_listing');
      expect(total).toBe(1);
      expect(items[0].id).toBe('a');
    });

    it('matches on description, case-insensitively', async () => {
      const { items, total } = await repo.search('SKILL ENTRY');
      expect(total).toBe(1);
      expect(items[0].id).toBe('b');
    });

    it('returns an empty result for no match', async () => {
      const { items, total } = await repo.search('no-such-term');
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it('returns an empty result for a blank search term', async () => {
      const { items, total } = await repo.search('   ');
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it('rejects a non-string/empty term', async () => {
      await expect(repo.search('')).rejects.toThrow(PermissionRepositoryValidationError);
    });
  });
});
