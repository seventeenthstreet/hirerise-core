'use strict';

/**
 * core/src/modules/admin/intelligence/__tests__/adminSignalLineage.controller.test.js
 *
 * Unit test skeleton — A09 Controller
 * HireRise Phase 2A.1.3
 *
 * Test runner: Jest (consistent with existing HireRise test tooling)
 * Coverage targets: all branches in getSignalLineage
 */

// ─────────────────────────────────────────────────────────────
// MOCKS
// ─────────────────────────────────────────────────────────────

jest.mock('../../../config/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
  },
}));

jest.mock('../../../utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

const { supabase } = require('../../../config/supabase');
const { getSignalLineage } = require('../adminSignalLineage.controller');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Creates a minimal mock req object with signal_key already in params.
 */
function makeReq(signalKey = 'skills.data_analysis.advanced', overrides = {}) {
  return {
    params: { signal_key: signalKey },
    user:   { uid: 'admin-uid-123', email: 'admin@hirerise.com' },
    adminPrincipal: { id: 'admin-uid-123' },
    ...overrides,
  };
}

/**
 * Creates a minimal mock res object with json() spy.
 */
function makeRes() {
  const res = {};
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res;
}

/**
 * Builds a raw RPC row matching fn_get_signal_lineage_summary column contract.
 */
function makeRpcRow(overrides = {}) {
  return {
    lineage_id:                    '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    predecessor_signal_key:        'skills.data_analysis',
    successor_signal_key:          'skills.data_analysis.advanced',
    lineage_type:                  'renamed_to',
    lineage_reason:                'Taxonomy v2 granularity expansion',
    effective_date:                '2026-07-01',
    taxonomy_version:              'v2.0.0',
    proposed_by:                   'alice@hirerise.com',
    proposed_at:                   '2026-06-01T09:00:00.000Z',
    approved_by:                   'bob@hirerise.com',
    approved_at:                   '2026-06-02T14:00:00.000Z',
    weight_review_required:        true,
    weight_review_completed_at:    null,
    triggered_by_pipeline_run_id:  null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── 1. Valid request — lineage rows returned ─────────────────

describe('getSignalLineage — valid request', () => {
  it('returns 200 with correctly mapped lineage array', async () => {
    const rawRow = makeRpcRow();
    supabase.rpc.mockResolvedValueOnce({ data: [rawRow], error: null });

    const req = makeReq('skills.data_analysis.advanced');
    const res = makeRes();

    await getSignalLineage(req, res);

    expect(supabase.rpc).toHaveBeenCalledWith(
      'fn_get_signal_lineage_summary',
      { p_signal_key: 'skills.data_analysis.advanced' }
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          signalKey: 'skills.data_analysis.advanced',
          total: 1,
          lineage: [
            expect.objectContaining({
              id:                       rawRow.lineage_id,
              predecessorSignalKey:     rawRow.predecessor_signal_key,
              successorSignalKey:       rawRow.successor_signal_key,
              lineageType:              rawRow.lineage_type,
              lineageReason:            rawRow.lineage_reason,
              effectiveDate:            rawRow.effective_date,
              taxonomyVersion:          rawRow.taxonomy_version,
              proposedBy:               rawRow.proposed_by,
              proposedAt:               rawRow.proposed_at,
              approvedBy:               rawRow.approved_by,
              approvedAt:               rawRow.approved_at,
              weightReviewRequired:     rawRow.weight_review_required,
              weightReviewCompletedAt:  null,
              triggeredByPipelineRunId: null,
            }),
          ],
        }),
        meta: expect.objectContaining({ duration_ms: expect.any(Number) }),
      })
    );
  });

  it('response does NOT include updatedAt field', async () => {
    supabase.rpc.mockResolvedValueOnce({ data: [makeRpcRow()], error: null });

    const res = makeRes();
    await getSignalLineage(makeReq(), res);

    const [call] = res.json.mock.calls;
    const lineageItem = call[0].data.lineage[0];
    expect(lineageItem).not.toHaveProperty('updatedAt');
  });

  it('passes proposedBy null through without substitution', async () => {
    supabase.rpc.mockResolvedValueOnce({
      data: [makeRpcRow({ proposed_by: null })],
      error: null,
    });

    const res = makeRes();
    await getSignalLineage(makeReq(), res);

    const lineageItem = res.json.mock.calls[0][0].data.lineage[0];
    expect(lineageItem.proposedBy).toBeNull();
  });

  it('passes all nullable fields through as null when RPC returns null', async () => {
    const nullableRow = makeRpcRow({
      successor_signal_key:          null,
      proposed_by:                   null,
      approved_by:                   null,
      approved_at:                   null,
      weight_review_completed_at:    null,
      triggered_by_pipeline_run_id:  null,
    });
    supabase.rpc.mockResolvedValueOnce({ data: [nullableRow], error: null });

    const res = makeRes();
    await getSignalLineage(makeReq(), res);

    const row = res.json.mock.calls[0][0].data.lineage[0];
    expect(row.successorSignalKey).toBeNull();
    expect(row.proposedBy).toBeNull();
    expect(row.approvedBy).toBeNull();
    expect(row.approvedAt).toBeNull();
    expect(row.weightReviewCompletedAt).toBeNull();
    expect(row.triggeredByPipelineRunId).toBeNull();
  });

  it('includes duration_ms in meta', async () => {
    supabase.rpc.mockResolvedValueOnce({ data: [], error: null });
    const res = makeRes();
    await getSignalLineage(makeReq(), res);

    const meta = res.json.mock.calls[0][0].meta;
    expect(typeof meta.duration_ms).toBe('number');
    expect(meta.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── 2. Empty lineage result ──────────────────────────────────

describe('getSignalLineage — empty result', () => {
  it('returns 200 with empty lineage array when RPC returns []', async () => {
    supabase.rpc.mockResolvedValueOnce({ data: [], error: null });

    const res = makeRes();
    await getSignalLineage(makeReq('skills.unknown.key'), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          signalKey: 'skills.unknown.key',
          lineage: [],
          total: 0,
        }),
      })
    );
  });

  it('returns 200 with empty lineage array when RPC returns null data', async () => {
    supabase.rpc.mockResolvedValueOnce({ data: null, error: null });

    const res = makeRes();
    await getSignalLineage(makeReq('skills.unknown.key'), res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.lineage).toEqual([]);
    expect(payload.data.total).toBe(0);
  });
});

// ── 3. RPC failure ───────────────────────────────────────────

describe('getSignalLineage — RPC failure', () => {
  it('throws AppError with 500 / INTERNAL_ERROR when RPC returns error', async () => {
    supabase.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection timeout' },
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    // asyncHandler forwards thrown errors to next()
    await expect(getSignalLineage(req, res, next)).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('does not expose raw Supabase error message in thrown error message', async () => {
    const rawSupabaseMsg = 'pg: could not connect to server';
    supabase.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: rawSupabaseMsg },
    });

    let thrownError;
    try {
      await getSignalLineage(makeReq(), makeRes());
    } catch (err) {
      thrownError = err;
    }

    // The AppError message presented externally should not leak the Supabase detail
    expect(thrownError).toBeDefined();
    expect(thrownError.message).not.toContain(rawSupabaseMsg);
  });
});

// ── 4. signal_key validation (secondary guard) ───────────────

describe('getSignalLineage — secondary validation guard', () => {
  it('throws 400 / VALIDATION_ERROR when signal_key is empty string after trim', async () => {
    const req = makeReq('   ');  // whitespace only — would be caught by route validator in prod
    const res = makeRes();

    await expect(getSignalLineage(req, res)).rejects.toMatchObject({
      statusCode: 400,
    });

    // RPC must NOT be called
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
