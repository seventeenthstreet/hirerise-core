'use strict';

/**
 * adminWeights.repository.test.js — WP-ADMIN-COMP-08-R23
 *
 * Exercises AdminWeightsRepository against a local, minimal chainable
 * fake of the Supabase client — scoped to exactly what this repository
 * calls (.from().select().order().eq() for list(), .rpc() for
 * getActiveModelVersion()). Not reused from the studentIntelligence
 * testHelpers supabaseMock (under knowledge-runtime) because that fake is
 * scoped to BaseRepository's camelCase-remapping query shape, which this
 * repository deliberately does not use (see repository module docstring
 * for why).
 */

let mockRows;
let mockError;
let mockRpcResult;
let mockRpcError;
let lastQuery;

function makeQueryBuilder() {
  const state = { filters: {}, order: null };
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
    then: (resolve, reject) => {
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
    lastQuery = null;
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

    it('wraps an RPC error in AppError with ErrorCodes.INTERNAL_ERROR, never leaking the raw error', async () => {
      mockRpcError = { message: 'function does not exist', details: null };

      await expect(repo.getActiveModelVersion()).rejects.toMatchObject({
        name: 'AppError',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });
});
