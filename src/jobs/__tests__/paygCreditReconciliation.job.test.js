'use strict';

/**
 * paygCreditReconciliation.job.test.js — PAYG Phase 2 reconciliation
 *
 * Pure orchestration tests: the Supabase client is mocked. Verifies the
 * job (a) queries find_unreconciled_payg_grants (never a raw table scan),
 * (b) calls grant_payg_credits for every candidate, (c) never double-
 * counts/mutates directly, (d) is safely repeatable (a second run with no
 * candidates is a clean no-op), and (e) surfaces failures without
 * throwing away partial progress.
 */

const mockRpc = jest.fn();

jest.mock('../../config/supabase', () => ({
  supabase: {
    rpc: (...args) => mockRpc(...args),
  },
}));

jest.mock('../../monitoring/alerts', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
  SEVERITY: { LOW: 'low', HIGH: 'high', CRITICAL: 'critical' },
}));

const job = require('../paygCreditReconciliation.job');
const { sendAlert, SEVERITY } = require('../../monitoring/alerts');

describe('paygCreditReconciliation.job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is a clean no-op when there are no unreconciled candidates', async () => {
    mockRpc.mockImplementation((name) => {
      if (name === 'find_unreconciled_payg_grants') {
        return Promise.resolve({ data: [], error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await job.runJob();

    expect(result).toMatchObject({ candidates: 0, granted: 0, alreadyGranted: 0, notEligible: 0, failed: 0 });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['find_unreconciled_payg_grants']);
  });

  it('calls grant_payg_credits for every candidate payment and reports GRANTED', async () => {
    mockRpc.mockImplementation((name, args) => {
      if (name === 'find_unreconciled_payg_grants') {
        return Promise.resolve({
          data: [
            { out_payment_id: 'payment-1', out_user_id: 'user-1', out_confirmed_at: '2026-01-01T00:00:00Z' },
            { out_payment_id: 'payment-2', out_user_id: 'user-2', out_confirmed_at: '2026-01-01T00:01:00Z' },
          ],
          error: null,
        });
      }
      if (name === 'grant_payg_credits') {
        return Promise.resolve({
          data: [{ out_result: 'GRANTED', out_payment_id: args.p_payment_id, out_ledger_id: `ledger-${args.p_payment_id}` }],
          error: null,
        });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await job.runJob();

    expect(result).toMatchObject({ candidates: 2, granted: 2, alreadyGranted: 0, notEligible: 0, failed: 0 });
    const grantCalls = mockRpc.mock.calls.filter(([name]) => name === 'grant_payg_credits');
    expect(grantCalls).toHaveLength(2);
    expect(grantCalls.map(([, args]) => args.p_payment_id)).toEqual(['payment-1', 'payment-2']);
  });

  it('never double-credits: a candidate already granted by a concurrent path resolves to ALREADY_GRANTED, not an error', async () => {
    mockRpc.mockImplementation((name) => {
      if (name === 'find_unreconciled_payg_grants') {
        return Promise.resolve({ data: [{ out_payment_id: 'payment-1', out_user_id: 'user-1' }], error: null });
      }
      if (name === 'grant_payg_credits') {
        return Promise.resolve({ data: [{ out_result: 'ALREADY_GRANTED', out_payment_id: 'payment-1' }], error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await job.runJob();

    expect(result).toMatchObject({ candidates: 1, granted: 0, alreadyGranted: 1, failed: 0 });
  });

  it('is safely repeatable: a second run after full recovery finds zero candidates', async () => {
    mockRpc.mockImplementation((name) => {
      if (name === 'find_unreconciled_payg_grants') {
        return Promise.resolve({ data: [], error: null }); // second-run behavior
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const firstRerun = await job.runJob();
    const secondRerun = await job.runJob();

    expect(firstRerun.candidates).toBe(0);
    expect(secondRerun.candidates).toBe(0);
  });

  it('continues processing remaining candidates after one grant call fails, and alerts', async () => {
    mockRpc.mockImplementation((name, args) => {
      if (name === 'find_unreconciled_payg_grants') {
        return Promise.resolve({
          data: [
            { out_payment_id: 'payment-fail' },
            { out_payment_id: 'payment-ok' },
          ],
          error: null,
        });
      }
      if (name === 'grant_payg_credits') {
        if (args.p_payment_id === 'payment-fail') {
          return Promise.resolve({ data: null, error: { message: 'db unavailable' } });
        }
        return Promise.resolve({ data: [{ out_result: 'GRANTED', out_payment_id: 'payment-ok' }], error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await job.runJob();

    expect(result).toMatchObject({ candidates: 2, granted: 1, failed: 1 });
    expect(result.failures).toEqual([{ paymentId: 'payment-fail', error: 'db unavailable' }]);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: SEVERITY.HIGH }));
  });

  it('throws if the lookup itself fails (nothing to iterate, surfaced loudly rather than silently doing nothing)', async () => {
    mockRpc.mockImplementation((name) => {
      if (name === 'find_unreconciled_payg_grants') {
        return Promise.resolve({ data: null, error: { message: 'permission denied' } });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    await expect(job.runJob()).rejects.toThrow(/permission denied/);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: SEVERITY.HIGH }));
  });

  it('respects a custom limit and forwards it to the lookup RPC', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await job.runJob({ limit: 50 });

    expect(mockRpc).toHaveBeenCalledWith('find_unreconciled_payg_grants', { p_limit: 50 });
  });
});
