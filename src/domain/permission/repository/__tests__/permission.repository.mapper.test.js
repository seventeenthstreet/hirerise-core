'use strict';

/**
 * @file src/domain/permission/repository/__tests__/permission.repository.mapper.test.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS } = require('../../permission.constants');
const {
  rowToPermission,
  rowsToPermissions,
  createInputToRow,
  updateInputToRow,
  UPDATABLE_FIELDS,
} = require('../permission.repository.mapper');
const {
  PermissionMappingError,
  PermissionRepositoryValidationError,
} = require('../permission.repository.errors');
const {
  InvalidResourceError,
  InvalidActionError,
  InvalidPermissionCategoryError,
  InvalidPermissionStatusError,
  InvalidPermissionError,
} = require('../../permission.errors');

function makeRow(overrides = {}) {
  return {
    id: 'row-1',
    name: 'job_listing:create',
    resource: RESOURCES.JOB_LISTING,
    action: ACTIONS.CREATE,
    category: PERMISSION_CATEGORIES.JOBS,
    status: PERMISSION_STATUS.PROPOSED,
    description: 'Create a job listing',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('rowToPermission', () => {
  it('maps a well-formed row to a persisted domain Permission', () => {
    const row = makeRow();
    const permission = rowToPermission(row);

    expect(permission).toEqual({
      id: 'row-1',
      name: 'job_listing:create',
      resource: RESOURCES.JOB_LISTING,
      action: ACTIONS.CREATE,
      category: PERMISSION_CATEGORIES.JOBS,
      status: PERMISSION_STATUS.PROPOSED,
      description: 'Create a job listing',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
  });

  it('returns a frozen object', () => {
    const permission = rowToPermission(makeRow());
    expect(Object.isFrozen(permission)).toBe(true);
  });

  it('defaults a null category/description to null', () => {
    const permission = rowToPermission(makeRow({ category: null, description: null }));
    expect(permission.category).toBeNull();
    expect(permission.description).toBeNull();
  });

  it('throws PermissionMappingError for a null row', () => {
    expect(() => rowToPermission(null)).toThrow(PermissionMappingError);
  });

  it('throws PermissionMappingError for a non-object row', () => {
    expect(() => rowToPermission('nope')).toThrow(PermissionMappingError);
  });

  it('throws PermissionMappingError when the row has an invalid resource', () => {
    expect(() => rowToPermission(makeRow({ resource: 'not-a-resource' }))).toThrow(PermissionMappingError);
  });

  it('throws PermissionMappingError when the row has an invalid action', () => {
    expect(() => rowToPermission(makeRow({ action: 'not-an-action' }))).toThrow(PermissionMappingError);
  });

  it('throws PermissionMappingError when the row has an invalid status', () => {
    expect(() => rowToPermission(makeRow({ status: 'not-a-status' }))).toThrow(PermissionMappingError);
  });

  it('throws PermissionMappingError when name does not match resource:action', () => {
    expect(() => rowToPermission(makeRow({ name: 'wrong:name' }))).toThrow(PermissionMappingError);
  });

  it('wraps the originating domain error in metadata.cause', () => {
    try {
      rowToPermission(makeRow({ resource: 'not-a-resource' }));
      throw new Error('expected rowToPermission to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionMappingError);
      expect(error.metadata.cause).toBeInstanceOf(InvalidResourceError);
      expect(error.metadata.rowId).toBe('row-1');
    }
  });
});

describe('rowsToPermissions', () => {
  it('maps a list of rows, preserving order', () => {
    const rows = [
      makeRow({ id: 'a', name: 'job_listing:create', resource: RESOURCES.JOB_LISTING, action: ACTIONS.CREATE }),
      makeRow({ id: 'b', name: 'skill:view', resource: RESOURCES.SKILL, action: ACTIONS.VIEW }),
    ];

    const permissions = rowsToPermissions(rows);

    expect(permissions.map((p) => p.id)).toEqual(['a', 'b']);
    expect(permissions.map((p) => p.name)).toEqual(['job_listing:create', 'skill:view']);
  });

  it('returns an empty array for null/undefined input', () => {
    expect(rowsToPermissions(null)).toEqual([]);
    expect(rowsToPermissions(undefined)).toEqual([]);
  });

  it('propagates a PermissionMappingError from any single bad row', () => {
    const rows = [makeRow(), makeRow({ id: 'bad', resource: 'nope' })];
    expect(() => rowsToPermissions(rows)).toThrow(PermissionMappingError);
  });
});

describe('createInputToRow', () => {
  it('builds an insert-ready row from valid domain input', () => {
    const { row, permission } = createInputToRow({
      resource: RESOURCES.SKILL,
      action: ACTIONS.CREATE,
      category: PERMISSION_CATEGORIES.SKILLS,
      description: 'Create a skill',
    });

    expect(row).toEqual({
      name: 'skill:create',
      resource: RESOURCES.SKILL,
      action: ACTIONS.CREATE,
      category: PERMISSION_CATEGORIES.SKILLS,
      status: PERMISSION_STATUS.PROPOSED,
      description: 'Create a skill',
    });
    expect(permission.name).toBe('skill:create');
  });

  it('defaults status to PROPOSED when omitted', () => {
    const { row } = createInputToRow({ resource: RESOURCES.SKILL, action: ACTIONS.VIEW });
    expect(row.status).toBe(PERMISSION_STATUS.PROPOSED);
  });

  it('rejects an invalid resource via the domain factory', () => {
    expect(() => createInputToRow({ resource: 'nope', action: ACTIONS.VIEW })).toThrow(InvalidResourceError);
  });

  it('rejects an invalid action via the domain factory', () => {
    expect(() => createInputToRow({ resource: RESOURCES.SKILL, action: 'nope' })).toThrow(InvalidActionError);
  });
});

describe('updateInputToRow', () => {
  it('exposes the updatable field list', () => {
    expect(UPDATABLE_FIELDS).toEqual(['category', 'status', 'description']);
  });

  it('maps a partial update containing only status', () => {
    const row = updateInputToRow({ status: PERMISSION_STATUS.APPROVED });
    expect(row).toEqual({ status: PERMISSION_STATUS.APPROVED });
  });

  it('maps a partial update containing only category', () => {
    const row = updateInputToRow({ category: PERMISSION_CATEGORIES.CMS });
    expect(row).toEqual({ category: PERMISSION_CATEGORIES.CMS });
  });

  it('maps a partial update containing only description', () => {
    const row = updateInputToRow({ description: 'Updated description' });
    expect(row).toEqual({ description: 'Updated description' });
  });

  it('maps a full update of all three fields', () => {
    const row = updateInputToRow({
      category: PERMISSION_CATEGORIES.AI_SERVICES,
      status: PERMISSION_STATUS.RETIRED,
      description: null,
    });

    expect(row).toEqual({
      category: PERMISSION_CATEGORIES.AI_SERVICES,
      status: PERMISSION_STATUS.RETIRED,
      description: null,
    });
  });

  it('throws PermissionRepositoryValidationError when no fields are provided', () => {
    expect(() => updateInputToRow({})).toThrow(PermissionRepositoryValidationError);
  });

  it('throws PermissionRepositoryValidationError for a null/non-object argument', () => {
    expect(() => updateInputToRow(null)).toThrow(PermissionRepositoryValidationError);
    expect(() => updateInputToRow('nope')).toThrow(PermissionRepositoryValidationError);
  });

  it('throws InvalidPermissionCategoryError for an invalid category', () => {
    expect(() => updateInputToRow({ category: 'not-a-category' })).toThrow(InvalidPermissionCategoryError);
  });

  it('throws InvalidPermissionStatusError for an invalid status', () => {
    expect(() => updateInputToRow({ status: 'not-a-status' })).toThrow(InvalidPermissionStatusError);
  });

  it('throws InvalidPermissionError for a non-string, non-null description', () => {
    expect(() => updateInputToRow({ description: 42 })).toThrow(InvalidPermissionError);
  });

  it('ignores unrecognized fields not in UPDATABLE_FIELDS', () => {
    const row = updateInputToRow({ status: PERMISSION_STATUS.ADOPTED, resource: RESOURCES.USER });
    expect(row).toEqual({ status: PERMISSION_STATUS.ADOPTED });
  });
});
