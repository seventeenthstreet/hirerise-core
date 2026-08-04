'use strict';

/**
 * @file src/domain/permission/registry/__tests__/permission.registry.test.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 *
 * Exercises PermissionRegistry against a fake, constructor-injected
 * Repository (rather than a Supabase-backed one) — the Registry's own
 * contract is "consume the Repository", so a fake satisfying that same
 * method surface is sufficient and keeps these tests scoped to Registry
 * behavior only, per this WP's "Do NOT implement integration tests
 * outside Registry scope" instruction.
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS } = require('../../permission.constants');
const { PermissionRegistry } = require('../permission.registry');
const { PermissionRegistryValidationError } = require('../permission.registry.errors');

function makePermission(overrides = {}) {
  const resource = overrides.resource ?? RESOURCES.JOB_LISTING;
  const action = overrides.action ?? ACTIONS.VIEW;
  return {
    id: overrides.id ?? 'p-1',
    name: overrides.name ?? `${resource}:${action}`,
    resource,
    action,
    category: overrides.category ?? PERMISSION_CATEGORIES.JOBS,
    status: overrides.status ?? PERMISSION_STATUS.PROPOSED,
    description: overrides.description ?? 'A permission',
    createdAt: overrides.createdAt ?? '2026-08-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-01T00:00:00.000Z',
  };
}

/**
 * A minimal fake satisfying the PermissionRepository method surface
 * (../repository/permission.repository.contract.js), backed by an
 * in-memory array — no Supabase, no filesystem, no network.
 */
function makeFakeRepository(rows = []) {
  const byExact = (field, value) => rows.filter((r) => r[field] === value);
  const paginate = (items, { limit = 50, offset = 0 } = {}) => ({
    items: items.slice(offset, offset + limit),
    total: items.length,
  });

  return {
    async list(options) {
      return paginate(rows, options);
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByName(name) {
      return rows.find((r) => r.name === name) ?? null;
    },
    async findByResource(resource, options) {
      return paginate(byExact('resource', resource), options);
    },
    async findByAction(action, options) {
      return paginate(byExact('action', action), options);
    },
    async findByCategory(category, options) {
      return paginate(byExact('category', category), options);
    },
    async findByStatus(status, options) {
      return paginate(byExact('status', status), options);
    },
    async existsById(id) {
      return rows.some((r) => r.id === id);
    },
    async existsByName(name) {
      return rows.some((r) => r.name === name);
    },
    async create() {
      throw new Error('not used by these tests');
    },
    async update() {
      throw new Error('not used by these tests');
    },
    async delete() {
      throw new Error('not used by these tests');
    },
    async search() {
      throw new Error('not used by these tests');
    },
  };
}

describe('PermissionRegistry initialization', () => {
  it('defaults to the shared repository singleton when constructed with no arguments', () => {
    const registry = new PermissionRegistry();
    expect(registry).toBeInstanceOf(PermissionRegistry);
  });

  it('accepts an injected repository', async () => {
    const repo = makeFakeRepository([makePermission({ id: 'a' })]);
    const registry = new PermissionRegistry(repo);
    const { total } = await registry.listPermissions();
    expect(total).toBe(1);
  });
});

describe('Permission discovery', () => {
  let registry;

  beforeEach(() => {
    registry = new PermissionRegistry(
      makeFakeRepository([
        makePermission({ id: 'a', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, category: PERMISSION_CATEGORIES.JOBS, status: PERMISSION_STATUS.PROPOSED }),
        makePermission({ id: 'b', resource: RESOURCES.JOB_LISTING, action: ACTIONS.CREATE, category: PERMISSION_CATEGORIES.JOBS, status: PERMISSION_STATUS.APPROVED }),
        makePermission({ id: 'c', resource: RESOURCES.SKILL, action: ACTIONS.VIEW, category: PERMISSION_CATEGORIES.SKILLS, status: PERMISSION_STATUS.PROPOSED }),
      ])
    );
  });

  it('listPermissions returns every registered Permission', async () => {
    const { items, total } = await registry.listPermissions();
    expect(total).toBe(3);
    expect(items).toHaveLength(3);
  });

  it('getPermission looks up by internal id', async () => {
    const entry = await registry.getPermission('a');
    expect(entry.id).toBe('a');
    expect(entry.resource).toBe(RESOURCES.JOB_LISTING);
  });

  it('getPermission returns null for a missing id', async () => {
    expect(await registry.getPermission('does-not-exist')).toBeNull();
  });

  it('getPermissionByIdentity looks up by Stable Permission Identity', async () => {
    const entry = await registry.getPermissionByIdentity(`${RESOURCES.SKILL}:${ACTIONS.VIEW}`);
    expect(entry.id).toBe('c');
    expect(entry.identity).toBe(`${RESOURCES.SKILL}:${ACTIONS.VIEW}`);
  });

  it('getPermissionByIdentity returns null for an unregistered identity', async () => {
    expect(await registry.getPermissionByIdentity('nope:nope')).toBeNull();
  });

  it('findByResource returns only matching entries', async () => {
    const { items, total } = await registry.findByResource(RESOURCES.JOB_LISTING);
    expect(total).toBe(2);
    expect(items.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('findByAction returns only matching entries', async () => {
    const { items, total } = await registry.findByAction(ACTIONS.VIEW);
    expect(total).toBe(2);
    expect(items.map((e) => e.id).sort()).toEqual(['a', 'c']);
  });

  it('findByCategory returns only matching entries', async () => {
    const { items, total } = await registry.findByCategory(PERMISSION_CATEGORIES.SKILLS);
    expect(total).toBe(1);
    expect(items[0].id).toBe('c');
  });

  it('findByStatus returns only matching entries', async () => {
    const { items, total } = await registry.findByStatus(PERMISSION_STATUS.APPROVED);
    expect(total).toBe(1);
    expect(items[0].id).toBe('b');
  });

  it.each(['getPermission', 'getPermissionByIdentity', 'findByResource', 'findByAction', 'findByCategory', 'findByStatus'])(
    '%s rejects an empty string argument',
    async (method) => {
      await expect(registry[method]('')).rejects.toThrow(PermissionRegistryValidationError);
    }
  );
});

describe('Registry Catalog', () => {
  it('getCatalog returns the same result as listPermissions', async () => {
    const repo = makeFakeRepository([makePermission({ id: 'a' }), makePermission({ id: 'b', action: ACTIONS.CREATE })]);
    const registry = new PermissionRegistry(repo);

    const catalog = await registry.getCatalog();
    const list = await registry.listPermissions();

    expect(catalog).toEqual(list);
  });

  it('represents the complete registered set', async () => {
    const repo = makeFakeRepository([makePermission({ id: 'a' }), makePermission({ id: 'b', action: ACTIONS.CREATE }), makePermission({ id: 'c', action: ACTIONS.DELETE })]);
    const registry = new PermissionRegistry(repo);

    const { total } = await registry.getCatalog();
    expect(total).toBe(3);
  });
});

describe('Registry Metadata / Lifecycle Visibility / Capability Ownership', () => {
  it('decorates every discovered entry with identity, capabilityOwner, and lifecycleStage', async () => {
    const registry = new PermissionRegistry(
      makeFakeRepository([makePermission({ id: 'a', resource: RESOURCES.SKILL, action: ACTIONS.CREATE, status: PERMISSION_STATUS.PUBLISHED })])
    );

    const entry = await registry.getPermission('a');

    expect(entry.identity).toBe(`${RESOURCES.SKILL}:${ACTIONS.CREATE}`);
    expect(entry.capabilityOwner).toBe('Skills');
    expect(entry.lifecycleStage).toEqual({ status: 'published', label: 'Published', stageIndex: 2, isTerminal: false });
    // Registry Metadata fields
    expect(entry).toEqual(
      expect.objectContaining({
        id: 'a',
        resource: RESOURCES.SKILL,
        action: ACTIONS.CREATE,
        category: PERMISSION_CATEGORIES.JOBS,
        status: PERMISSION_STATUS.PUBLISHED,
        description: 'A permission',
      })
    );
  });

  it('getLifecycleStages exposes the full Governance Lifecycle', () => {
    const registry = new PermissionRegistry(makeFakeRepository([]));
    const stages = registry.getLifecycleStages();
    expect(stages.map((s) => s.status)).toEqual(['proposed', 'approved', 'published', 'adopted', 'deprecated', 'retired']);
  });

  it('does not mutate the Permission object returned by the repository', async () => {
    const permission = makePermission({ id: 'a' });
    const registry = new PermissionRegistry(makeFakeRepository([permission]));
    await registry.getPermission('a');
    expect(permission).not.toHaveProperty('identity');
    expect(permission).not.toHaveProperty('capabilityOwner');
  });
});

describe('Registry Validation', () => {
  it('reports a fully consistent catalog as valid', async () => {
    const registry = new PermissionRegistry(
      makeFakeRepository([makePermission({ id: 'a' }), makePermission({ id: 'b', action: ACTIONS.CREATE })])
    );

    const report = await registry.validateCatalog();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(2);
    expect(report.duplicateIdentities).toEqual([]);
    expect(report.malformedEntries).toEqual([]);
  });

  it('detects duplicate Permission Identities', async () => {
    const dup = 'job_listing:view';
    const entries = [
      { id: 'a', identity: dup, resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, status: PERMISSION_STATUS.PROPOSED, category: PERMISSION_CATEGORIES.JOBS },
      { id: 'b', identity: dup, resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, status: PERMISSION_STATUS.PROPOSED, category: PERMISSION_CATEGORIES.JOBS },
    ];

    const registry = new PermissionRegistry(makeFakeRepository([]));
    const report = await registry.validateCatalog(entries);

    expect(report.valid).toBe(false);
    expect(report.duplicateIdentities).toEqual([{ identity: dup, entryIds: ['a', 'b'] }]);
  });

  it('reports entries missing category as missing metadata, without marking them malformed', async () => {
    const entries = [
      { id: 'a', identity: 'job_listing:view', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, status: PERMISSION_STATUS.PROPOSED, category: null },
    ];

    const registry = new PermissionRegistry(makeFakeRepository([]));
    const report = await registry.validateCatalog(entries);

    expect(report.valid).toBe(true);
    expect(report.missingMetadata).toEqual([{ id: 'a', missingFields: ['category'] }]);
    expect(report.malformedEntries).toEqual([]);
  });

  it('detects malformed entries missing required fields', async () => {
    const entries = [{ id: 'a', identity: null, resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, status: PERMISSION_STATUS.PROPOSED, category: null }];

    const registry = new PermissionRegistry(makeFakeRepository([]));
    const report = await registry.validateCatalog(entries);

    expect(report.valid).toBe(false);
    expect(report.malformedEntries).toEqual([{ id: 'a', reason: 'missing required field(s): identity' }]);
  });

  it('detects a non-object entry as malformed', async () => {
    const registry = new PermissionRegistry(makeFakeRepository([]));
    const report = await registry.validateCatalog([null, 'nope']);

    expect(report.valid).toBe(false);
    expect(report.malformedEntries).toEqual([
      { id: null, reason: 'entry is not an object' },
      { id: null, reason: 'entry is not an object' },
    ]);
  });

  it('defaults to validating the full catalog when no entries are given', async () => {
    const registry = new PermissionRegistry(makeFakeRepository([makePermission({ id: 'a' })]));
    const report = await registry.validateCatalog();
    expect(report.totalEntries).toBe(1);
  });
});

describe('Empty registry handling', () => {
  let registry;

  beforeEach(() => {
    registry = new PermissionRegistry(makeFakeRepository([]));
  });

  it('listPermissions returns an empty result', async () => {
    const { items, total } = await registry.listPermissions();
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it('getCatalog returns an empty result', async () => {
    const { items, total } = await registry.getCatalog();
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it('every discovery lookup returns an empty/null result, never throws', async () => {
    expect(await registry.getPermission('anything')).toBeNull();
    expect(await registry.getPermissionByIdentity('anything:anything')).toBeNull();
    expect((await registry.findByResource(RESOURCES.SKILL)).items).toEqual([]);
    expect((await registry.findByAction(ACTIONS.VIEW)).items).toEqual([]);
    expect((await registry.findByCategory(PERMISSION_CATEGORIES.SKILLS)).items).toEqual([]);
    expect((await registry.findByStatus(PERMISSION_STATUS.PROPOSED)).items).toEqual([]);
  });

  it('validateCatalog reports a valid, empty report', async () => {
    const report = await registry.validateCatalog();
    expect(report).toEqual({
      valid: true,
      totalEntries: 0,
      duplicateIdentities: [],
      missingMetadata: [],
      malformedEntries: [],
    });
  });
});
