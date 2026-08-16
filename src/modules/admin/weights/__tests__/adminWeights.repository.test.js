'use strict';

/**
 * adminWeights.repository.test.js — WP-ADMIN-COMP-08-R23 + R24
 *
 * Exercises AdminWeightsRepository against a local, minimal chainable
 * fake of the Supabase client — scoped to exactly what this repository
 * calls (.from().select().order().eq() for list(), .rpc() for
 * getActiveModelVersion(), .from().insert().select().single() for R24's
 * create()). Not reused from the studentIntelligence testHelpers
 * supabaseMock (under knowledge-runtime) because that fake is scoped to
 * BaseRepository's camelCase-remapping query shape, which this repository
 * deliberately does not use (see repository module docstring for why).
 */

let mockRows;
let mockError;
let mockRpcResult;
let mockRpcError;
let mockInsertResult;
let mockInsertError;
let mockUpdateResult;
let mockUpdateError;
let lastQuery;
let lastInsertPayload;
let lastUpdatePayload;

function makeQueryBuilder() {
  const state = {
    filters: {},
    isFilters: {},
    notFilters: {},
    order: null,
    insertPayload: undefined,
    updatePayload: undefined,
    single: false,
    maybeSingle: false,
  };
  const builder = {
    select: jest.fn(() => builder),
    order: jest.fn((field, opts) => {
      state.order = { field, opts };
      return builder;
    }),
    eq: jest.fn((field, value) => {
      state.filters[field] = value;
      return builder;
    }),
    // .is(field, null) — used by findById() (none), approve()'s and
    // deprecate()'s conditional eligibility guards (approved_at/
    // deprecated_at IS NULL).
    is: jest.fn((field, value) => {
      state.isFilters[field] = value;
      return builder;
    }),
    // .not(field, 'is', null) — used by deprecate()'s conditional
    // eligibility guard (approved_at IS NOT NULL).
    not: jest.fn((field, operator, value) => {
      state.notFilters[field] = { operator, value };
      return builder;
    }),
    insert: jest.fn((payload) => {
      state.insertPayload = payload;
      lastInsertPayload = payload;
      return builder;
    }),
    // .update() — used by approve() (R25). This fake does not simulate
    // Postgres's own conditional-WHERE row matching in JS (that would
    // just be re-testing Postgres); it exists so repository tests can
    // assert the correct filters/payload were sent and that the mapped
    // return value (including the null-on-ineligible-row case) is
    // handled correctly.
    update: jest.fn((payload) => {
      state.updatePayload = payload;
      lastUpdatePayload = payload;
      return builder;
    }),
    single: jest.fn(() => {
      state.single = true;
      return builder;
    }),
    // .maybeSingle() — used by findById() and approve() (R25); unlike
    // .single(), resolves to `null` (not an error) when zero rows match.
    maybeSingle: jest.fn(() => {
      state.maybeSingle = true;
      return builder;
    }),
    then: (resolve, reject) => {
      // ── INSERT branch (R24 create()) ──────────────────────────────
      if (state.insertPayload !== undefined) {
        if (mockInsertError) {
          return Promise.resolve({ data: null, error: mockInsertError }).then(resolve, reject);
        }
        return Promise.resolve({ data: mockInsertResult, error: null }).then(resolve, reject);
      }

      // ── UPDATE branch (R25 approve()) ───────────────────────────────
      if (state.updatePayload !== undefined) {
        lastQuery = {
          filters: { ...state.filters },
          isFilters: { ...state.isFilters },
          notFilters: { ...state.notFilters },
          updatePayload: state.updatePayload,
        };
        if (mockUpdateError) {
          return Promise.resolve({ data: null, error: mockUpdateError }).then(resolve, reject);
        }
        return Promise.resolve({ data: mockUpdateResult, error: null }).then(resolve, reject);
      }

      // ── SELECT/list()/findById() branch (unchanged from R23) ───────
      lastQuery = { filters: { ...state.filters }, order: state.order };

      if (mockError) {
        return Promise.resolve({ data: null, error: mockError }).then(resolve, reject);
      }

      let rows = mockRows;
      for (const [field, value] of Object.entries(state.filters)) {
        rows = rows.filter((r) => r[field] === value);
      }
      if (state.order) {
        const { field, opts } = state.order;
        rows = [...rows].sort((a, b) => {
          const dir = opts?.ascending === false ? -1 : 1;
          return a[field] < b[field] ? -1 * dir : a[field] > b[field] ? 1 * dir : 0;
        });
      }

      if (state.single || state.maybeSingle) {
        return Promise.resolve({ data: rows[0] ?? null, error: null }).then(resolve, reject);
      }

      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

const mockSupabase = {
  from: jest.fn(() => makeQueryBuilder()),
  rpc: jest.fn((fnName, params) => {
    lastQuery = { rpcFnName: fnName, rpcParams: params };
    if (mockRpcError) {
      return Promise.resolve({ data: null, error: mockRpcError });
    }
    return Promise.resolve({ data: mockRpcResult, error: null });
  }),
};

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const repo = require('../adminWeights.repository');

function versionRow(overrides = {}) {
  return {
    id: 'v-1',
    version_tag: 'v1.0.0',
    model_type: 'signal_weights',
    intelligence_domain: 'student',
    description: 'Initial weights',
    approved_by: 'system',
    approved_at: '2026-06-01T00:00:00.000Z',
    effective_from: '2026-06-01T00:00:00.000Z',
    deprecated_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AdminWeightsRepository — WP-ADMIN-COMP-08-R23', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows = [versionRow()];
    mockError = null;
    mockRpcResult = null;
    mockRpcError = null;
    mockInsertResult = null;
    mockInsertError = null;
    mockUpdateResult = null;
    mockUpdateError = null;
    lastQuery = null;
    lastInsertPayload = null;
    lastUpdatePayload = null;
  });

  describe('list()', () => {
    it('queries the signal_weight_versions table (not weights/adaptive tables)', async () => {
      await repo.list();
      expect(mockSupabase.from).toHaveBeenCalledWith('signal_weight_versions');
    });

    it('returns mapped, camelCase rows and excludes the weights/domain_overrides/weight_rationale JSONB columns', async () => {
      const result = await repo.list();

      expect(result).toEqual([
        {
          id: 'v-1',
          versionTag: 'v1.0.0',
          modelType: 'signal_weights',
          intelligenceDomain: 'student',
          description: 'Initial weights',
          approvedBy: 'system',
          approvedAt: '2026-06-01T00:00:00.000Z',
          effectiveFrom: '2026-06-01T00:00:00.000Z',
          deprecatedAt: null,
          createdAt: '2026-06-01T00:00:00.000Z',
          isApproved: true,
          isDeprecated: false,
        },
      ]);
      expect(result[0].weights).toBeUndefined();
      expect(result[0].domainOverrides).toBeUndefined();
      expect(result[0].weightRationale).toBeUndefined();
    });

    it('orders by effective_from descending', async () => {
      await repo.list();
      expect(lastQuery.order).toEqual({ field: 'effective_from', opts: { ascending: false } });
    });

    it('applies intelligenceDomain and modelType filters when provided', async () => {
      await repo.list({ intelligenceDomain: 'professional', modelType: 'confidence_model' });
      expect(lastQuery.filters).toEqual({
        intelligence_domain: 'professional',
        model_type: 'confidence_model',
      });
    });

    it('applies no filters when none are provided', async () => {
      await repo.list();
      expect(lastQuery.filters).toEqual({});
    });

    it('returns an empty array when the registry has no rows', async () => {
      mockRows = [];
      const result = await repo.list();
      expect(result).toEqual([]);
    });

    it('wraps a Supabase error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockError = { message: 'connection refused', details: 'pg_connect failed' };

      await expect(repo.list()).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('getActiveModelVersion()', () => {
    it('calls fn_get_active_model_version via RPC, not a direct table query', async () => {
      mockRpcResult = versionRow();
      await repo.getActiveModelVersion({ intelligenceDomain: 'student', modelType: 'signal_weights' });

      expect(mockSupabase.rpc).toHaveBeenCalledWith('fn_get_active_model_version', {
        p_intelligence_domain: 'student',
        p_model_type: 'signal_weights',
      });
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('omits params entirely (does not send undefined/null) when no domain/type given, so the DB default applies', async () => {
      mockRpcResult = versionRow();
      await repo.getActiveModelVersion();

      expect(mockSupabase.rpc).toHaveBeenCalledWith('fn_get_active_model_version', {});
    });

    it('forwards only the provided argument when just one of the two is given', async () => {
      mockRpcResult = versionRow();
      await repo.getActiveModelVersion({ modelType: 'matching_model' });

      expect(mockSupabase.rpc).toHaveBeenCalledWith('fn_get_active_model_version', {
        p_model_type: 'matching_model',
      });
    });

    it('returns the mapped active version when the function resolves one', async () => {
      mockRpcResult = versionRow({ id: 'v-active' });
      const result = await repo.getActiveModelVersion();
      expect(result).toMatchObject({ id: 'v-active', versionTag: 'v1.0.0' });
    });

    it('returns null (does not throw) when the function resolves no active version', async () => {
      mockRpcResult = null;
      const result = await repo.getActiveModelVersion();
      expect(result).toBeNull();
    });

    it('returns null when the RPC resolves a truthy composite object with no valid row id (all-null fields)', async () => {
      // Reproduces the confirmed runtime response for
      // GET /admin/weights/active?intelligenceDomain=professional: a
      // PL/pgSQL `SELECT * INTO result; RETURN result;` composite-typed
      // function returns a row of all-NULL fields (not a true SQL NULL)
      // when the SELECT matches zero rows. This must normalize to null
      // exactly like the true-SQL-NULL case above, not fall through to
      // _toCamel() and be returned as if it were a resolved version.
      mockRpcResult = {
        id: null,
        version_tag: null,
        model_type: null,
        intelligence_domain: null,
        description: null,
        approved_by: null,
        approved_at: null,
        effective_from: null,
        deprecated_at: null,
        created_at: null,
      };

      const result = await repo.getActiveModelVersion({ intelligenceDomain: 'professional' });

      expect(result).toBeNull();
      // The RPC must still be the sole resolution path — this is a
      // result-normalization fix, not a fallback to a direct table query.
      expect(mockSupabase.rpc).toHaveBeenCalledWith('fn_get_active_model_version', {
        p_intelligence_domain: 'professional',
      });
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('wraps an RPC error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockRpcError = { message: 'function does not exist', details: null };

      await expect(repo.getActiveModelVersion()).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('create() — WP-ADMIN-COMP-08-R24', () => {
    function draftInput(overrides = {}) {
      return {
        versionTag: 'v2.0.0',
        modelType: 'signal_weights',
        intelligenceDomain: 'professional',
        description: 'Draft weights for professional domain',
        weights: { systems_thinker: { weight: 0.8 } },
        ...overrides,
      };
    }

    it('inserts into signal_weight_versions (not a different table)', async () => {
      mockInsertResult = versionRow({ id: 'v-draft', approved_by: null, approved_at: null });
      await repo.create(draftInput());
      expect(mockSupabase.from).toHaveBeenCalledWith('signal_weight_versions');
    });

    it('forces approved_by, approved_at, and deprecated_at to null regardless of caller input', async () => {
      mockInsertResult = versionRow({ id: 'v-draft', approved_by: null, approved_at: null });

      await repo.create(
        draftInput({
          // Even if a caller somehow reaches this layer with these set,
          // the repository must not forward them.
          approvedBy: 'someone',
          approvedAt: '2026-01-01T00:00:00.000Z',
          deprecatedAt: '2026-01-01T00:00:00.000Z',
        })
      );

      expect(lastInsertPayload).toMatchObject({
        approved_by: null,
        approved_at: null,
        deprecated_at: null,
      });
    });

    it('omits optional fields entirely (does not send undefined) when not provided, so DB defaults apply', async () => {
      mockInsertResult = versionRow({ id: 'v-draft', approved_by: null, approved_at: null });
      await repo.create(draftInput());

      expect(lastInsertPayload).not.toHaveProperty('domain_overrides');
      expect(lastInsertPayload).not.toHaveProperty('weight_rationale');
      expect(lastInsertPayload).not.toHaveProperty('effective_from');
    });

    it('forwards optional fields when provided', async () => {
      mockInsertResult = versionRow({ id: 'v-draft', approved_by: null, approved_at: null });
      await repo.create(
        draftInput({
          domainOverrides: { academic: 1.0 },
          weightRationale: { systems_thinker: 'because' },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
        })
      );

      expect(lastInsertPayload).toMatchObject({
        domain_overrides: { academic: 1.0 },
        weight_rationale: { systems_thinker: 'because' },
        effective_from: '2026-09-01T00:00:00.000Z',
      });
    });

    it('maps the required fields from camelCase to snake_case on insert', async () => {
      mockInsertResult = versionRow({ id: 'v-draft', approved_by: null, approved_at: null });
      await repo.create(draftInput());

      expect(lastInsertPayload).toMatchObject({
        version_tag: 'v2.0.0',
        model_type: 'signal_weights',
        intelligence_domain: 'professional',
        description: 'Draft weights for professional domain',
        weights: { systems_thinker: { weight: 0.8 } },
      });
    });

    it('returns the created draft, camelCase-mapped like list()/getActiveModelVersion()', async () => {
      mockInsertResult = versionRow({
        id: 'v-draft',
        version_tag: 'v2.0.0',
        intelligence_domain: 'professional',
        approved_by: null,
        approved_at: null,
        deprecated_at: null,
      });

      const result = await repo.create(draftInput());

      expect(result).toMatchObject({
        id: 'v-draft',
        versionTag: 'v2.0.0',
        intelligenceDomain: 'professional',
        approvedBy: null,
        approvedAt: null,
        deprecatedAt: null,
        isApproved: false,
        isDeprecated: false,
      });
      expect(result.weights).toBeUndefined();
    });

    it('wraps a Postgres unique-violation (23505) as AppError 409 CONFLICT, not INTERNAL_ERROR', async () => {
      mockInsertError = {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_model_version_per_domain_type"',
        details: 'Key (intelligence_domain, model_type, version_tag)=(professional, signal_weights, v2.0.0) already exists.',
      };

      await expect(repo.create(draftInput())).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 409,
        code: 'CONFLICT',
      });
    });

    it('wraps any other insert error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockInsertError = { message: 'connection refused', details: 'pg_connect failed' };

      await expect(repo.create(draftInput())).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('findById() — WP-ADMIN-COMP-08-R25', () => {
    it('queries signal_weight_versions by id and returns the mapped row', async () => {
      mockRows = [versionRow({ id: 'v-1', approved_by: null, approved_at: null })];

      const result = await repo.findById('v-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('signal_weight_versions');
      expect(lastQuery.filters).toEqual({ id: 'v-1' });
      expect(result).toMatchObject({ id: 'v-1', isApproved: false });
    });

    it('excludes the weights/domain_overrides/weight_rationale JSONB columns, same as list()', async () => {
      mockRows = [versionRow({ id: 'v-1' })];
      const result = await repo.findById('v-1');
      expect(result.weights).toBeUndefined();
      expect(result.domainOverrides).toBeUndefined();
      expect(result.weightRationale).toBeUndefined();
    });

    it('returns null (not an error) when no row matches the id', async () => {
      mockRows = [];
      const result = await repo.findById('does-not-exist');
      expect(result).toBeNull();
    });

    it('wraps a Supabase error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockError = { message: 'connection refused', details: 'pg_connect failed' };

      await expect(repo.findById('v-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('approve() — WP-ADMIN-COMP-08-R25', () => {
    it('updates signal_weight_versions (not a different table)', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', approved_by: 'admin-1' });
      await repo.approve('v-1', 'admin-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('signal_weight_versions');
    });

    it('sets approved_by from the given actor and approved_at as an application-supplied ISO timestamp', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', approved_by: 'admin-1' });
      await repo.approve('v-1', 'admin-1');

      expect(lastUpdatePayload.approved_by).toBe('admin-1');
      expect(typeof lastUpdatePayload.approved_at).toBe('string');
      expect(new Date(lastUpdatePayload.approved_at).toString()).not.toBe('Invalid Date');
    });

    it('never sets deprecated_at or any other column', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', approved_by: 'admin-1' });
      await repo.approve('v-1', 'admin-1');

      expect(Object.keys(lastUpdatePayload).sort()).toEqual(['approved_at', 'approved_by']);
    });

    it('filters by id', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', approved_by: 'admin-1' });
      await repo.approve('v-1', 'admin-1');
      expect(lastQuery.filters).toEqual({ id: 'v-1' });
    });

    it('applies the conditional eligibility guard: approved_at IS NULL AND deprecated_at IS NULL', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', approved_by: 'admin-1' });
      await repo.approve('v-1', 'admin-1');
      expect(lastQuery.isFilters).toEqual({ approved_at: null, deprecated_at: null });
    });

    it('returns the mapped, approved row on success', async () => {
      mockUpdateResult = versionRow({
        id: 'v-1',
        approved_by: 'admin-1',
        approved_at: '2026-08-16T00:00:00.000Z',
        deprecated_at: null,
      });

      const result = await repo.approve('v-1', 'admin-1');

      expect(result).toMatchObject({
        id: 'v-1',
        approvedBy: 'admin-1',
        approvedAt: '2026-08-16T00:00:00.000Z',
        isApproved: true,
      });
      expect(result.weights).toBeUndefined();
    });

    it('returns null (not an error) when the conditional UPDATE matches zero rows — id missing or row no longer an eligible draft', async () => {
      mockUpdateResult = null;
      const result = await repo.approve('v-1', 'admin-1');
      expect(result).toBeNull();
    });

    it('wraps a Supabase error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockUpdateError = { message: 'connection refused', details: 'pg_connect failed' };

      await expect(repo.approve('v-1', 'admin-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('deprecate() — WP-ADMIN-COMP-08-R26', () => {
    it('updates signal_weight_versions (not a different table)', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', deprecated_at: '2026-08-16T00:00:00.000Z' });
      await repo.deprecate('v-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('signal_weight_versions');
    });

    it('sets deprecated_at as an application-supplied ISO timestamp', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', deprecated_at: '2026-08-16T00:00:00.000Z' });
      await repo.deprecate('v-1');

      expect(typeof lastUpdatePayload.deprecated_at).toBe('string');
      expect(new Date(lastUpdatePayload.deprecated_at).toString()).not.toBe('Invalid Date');
    });

    it('never sets approved_by, approved_at, or any other column', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', deprecated_at: '2026-08-16T00:00:00.000Z' });
      await repo.deprecate('v-1');

      expect(Object.keys(lastUpdatePayload)).toEqual(['deprecated_at']);
    });

    it('filters by id', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', deprecated_at: '2026-08-16T00:00:00.000Z' });
      await repo.deprecate('v-1');
      expect(lastQuery.filters).toEqual({ id: 'v-1' });
    });

    it('applies the conditional eligibility guard: approved_at IS NOT NULL AND deprecated_at IS NULL', async () => {
      mockUpdateResult = versionRow({ id: 'v-1', deprecated_at: '2026-08-16T00:00:00.000Z' });
      await repo.deprecate('v-1');

      expect(lastQuery.notFilters).toEqual({ approved_at: { operator: 'is', value: null } });
      expect(lastQuery.isFilters).toEqual({ deprecated_at: null });
    });

    it('returns the mapped, deprecated row on success', async () => {
      mockUpdateResult = versionRow({
        id: 'v-1',
        approved_by: 'admin-1',
        approved_at: '2026-06-01T00:00:00.000Z',
        deprecated_at: '2026-08-16T00:00:00.000Z',
      });

      const result = await repo.deprecate('v-1');

      expect(result).toMatchObject({
        id: 'v-1',
        deprecatedAt: '2026-08-16T00:00:00.000Z',
        isDeprecated: true,
      });
      expect(result.weights).toBeUndefined();
    });

    it('returns null (not an error) when the conditional UPDATE matches zero rows — id missing, still a draft, or already deprecated', async () => {
      mockUpdateResult = null;
      const result = await repo.deprecate('v-1');
      expect(result).toBeNull();
    });

    it('wraps a Supabase error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockUpdateError = { message: 'connection refused', details: 'pg_connect failed' };

      await expect(repo.deprecate('v-1')).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });
});