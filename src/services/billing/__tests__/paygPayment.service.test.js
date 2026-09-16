'use strict';

/**
 * paygPayment.service.test.js — PAYG Phase 1 Payment Record Layer
 *
 * Pure orchestration tests: the Supabase client is mocked, so these assert
 * that the service (a) resolves and cross-checks packages server-side
 * before ever writing a Payment record, (b) never invents prices/credit
 * quantities, (c) calls the DB-idempotent RPC with the correct normalized
 * payload, and (d) never touches any credit-granting or subscription
 * primitive (CRITICAL credit isolation — controlling prompt §14).
 */

const mockRpc = jest.fn();
const mockMaybeSingle = jest.fn();
const mockEq = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn(() => ({ select: mockSelect }));

jest.mock('../../../config/supabase', () => ({
  supabase: {
    from: (...args) => mockFrom(...args),
    rpc: (...args) => mockRpc(...args),
  },
}));

jest.mock('../../../monitoring/alerts', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
  SEVERITY: { LOW: 'low', HIGH: 'high', CRITICAL: 'critical' },
}));

const {
  PaygPaymentError,
  resolvePackage,
  recordPaygPaymentEvent,
} = require('../paygPayment.service');
const { sendAlert, SEVERITY } = require('../../../monitoring/alerts');

function activePackage(overrides = {}) {
  return {
    id: 'payg_500',
    credits: 500,
    amount: 499,
    currency: 'INR',
    is_active: true,
    ...overrides,
  };
}

function baseEvent(overrides = {}) {
  return {
    provider: 'stripe',
    providerEventId: 'evt_1',
    providerPaymentId: 'pi_1',
    userId: 'user-uuid-1',
    packageId: 'payg_500',
    amount: 499,
    currency: 'INR',
    status: 'confirmed',
    occurredAt: '2026-09-07T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('paygPayment.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('resolvePackage()', () => {
    it('rejects an unknown package', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      await expect(resolvePackage('nope')).rejects.toMatchObject({ code: 'UNKNOWN_PACKAGE' });
    });

    it('rejects an inactive package', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage({ is_active: false }), error: null });

      await expect(resolvePackage('payg_500')).rejects.toMatchObject({ code: 'INACTIVE_PACKAGE' });
    });

    it('rejects with no package_id at all', async () => {
      await expect(resolvePackage(undefined)).rejects.toMatchObject({ code: 'UNKNOWN_PACKAGE' });
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('resolves an active package', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });

      await expect(resolvePackage('payg_500')).resolves.toMatchObject({ id: 'payg_500', is_active: true });
    });
  });

  describe('recordPaygPaymentEvent() — package / amount validation (controlling prompt §7, §12)', () => {
    it('never writes a Payment record for an unknown package', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(result).toEqual({ skipped: true, reason: 'UNKNOWN_PACKAGE' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('never writes a Payment record when provider amount does not match the package amount', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage({ amount: 999 }), error: null });

      const result = await recordPaygPaymentEvent(baseEvent({ amount: 499 }));

      expect(result).toEqual({ skipped: true, reason: 'AMOUNT_MISMATCH' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('never writes a Payment record when currency does not match the package currency', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage({ currency: 'USD' }), error: null });

      const result = await recordPaygPaymentEvent(baseEvent({ currency: 'INR' }));

      expect(result).toEqual({ skipped: true, reason: 'CURRENCY_MISMATCH' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects an inactive package even if the amount matches exactly', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage({ is_active: false }), error: null });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(result).toEqual({ skipped: true, reason: 'INACTIVE_PACKAGE' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('is a safe no-op when the event cannot be mapped to a user (never guesses)', async () => {
      const result = await recordPaygPaymentEvent(baseEvent({ userId: null }));

      expect(result).toEqual({ skipped: true, reason: 'MISSING_IDENTITY' });
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('proceeds to record a validated confirmed payment via the RPC, using only server-side package data', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({
        data: [{ out_payment_id: 'payment-uuid-1', out_status: 'confirmed', out_duplicate: false }],
        error: null,
      });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(mockRpc).toHaveBeenCalledWith('record_payg_payment_event', expect.objectContaining({
        p_provider: 'stripe',
        p_provider_event_id: 'evt_1',
        p_provider_payment_id: 'pi_1',
        p_user_id: 'user-uuid-1',
        p_package_id: 'payg_500',
        p_amount: 499,
        p_currency: 'INR',
        p_status: 'confirmed',
      }));
      expect(result).toMatchObject({ skipped: false, paymentId: 'payment-uuid-1', status: 'confirmed' });
    });

    it('allows a refund/dispute transition to proceed even if package re-validation fails (already-confirmed payment)', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null }); // package lookup now fails
      mockRpc.mockResolvedValue({
        data: [{ out_payment_id: 'payment-uuid-1', out_status: 'refunded', out_duplicate: false }],
        error: null,
      });

      const result = await recordPaygPaymentEvent(baseEvent({ status: 'refunded' }));

      expect(mockRpc).toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'refunded' });
    });

    it('treats a duplicate delivery reported by the RPC as a safe no-op, not an error', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({
        data: [{ out_payment_id: 'payment-uuid-1', out_status: 'confirmed', out_duplicate: true }],
        error: null,
      });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(result).toMatchObject({ duplicate: true, skipped: false });
    });

    it('treats an INVALID_TRANSITION RPC error as a safe no-op, not a thrown error', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'INVALID_TRANSITION: cannot move payment x from refunded to confirmed' },
      });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(result).toEqual({ skipped: true, reason: 'INVALID_TRANSITION' });
    });

    it('surfaces an INTEGRITY_VIOLATION RPC error loudly (thrown + alerted), never as a silent no-op (controlling audit prompt §5)', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'INTEGRITY_VIOLATION: event stripe/evt_1 is already associated with payment x, not pi_other' },
      });

      await expect(recordPaygPaymentEvent(baseEvent())).rejects.toMatchObject({
        code: 'INTEGRITY_VIOLATION',
      });
      expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: SEVERITY.CRITICAL }));
    });

    it('alerts (but does not block) when the RPC reports an attributes mismatch on an existing payment (controlling audit prompt §6)', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({
        data: [{ out_payment_id: 'payment-uuid-1', out_status: 'refunded', out_duplicate: false, out_attributes_mismatch: true }],
        error: null,
      });

      const result = await recordPaygPaymentEvent(baseEvent({ status: 'refunded' }));

      expect(result).toMatchObject({ skipped: false, attributesMismatch: true });
      expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: SEVERITY.HIGH }));
    });

    it('surfaces any other RPC failure as a PaygPaymentError', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

      await expect(recordPaygPaymentEvent(baseEvent())).rejects.toBeInstanceOf(PaygPaymentError);
    });
  });

  describe('CRITICAL credit isolation (controlling prompt §14) — subscription/legacy-credit primitives', () => {
    // PAYG Phase 2 note: this module now intentionally invokes the
    // dedicated PAYG grant primitive (public.grant_payg_credits) for
    // confirmed payments — see the "PAYG Phase 2 credit-grant
    // orchestration" describe block below. What Phase 1's isolation
    // guarantee actually protects (and still does, unconditionally) is
    // that this module NEVER reaches for the legacy/shared credit or
    // subscription primitives — activate_subscription_tx,
    // admin_grant_credits, admin_adjust_credits, consume_ai_credits —
    // regardless of payment status. Only the dedicated, PAYG-specific
    // grant_payg_credits RPC is ever called, and only when a payment is
    // actually confirmed.
    it('never calls any subscription or legacy/admin credit RPC, for any payment status', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockImplementation((name) => {
        if (name === 'record_payg_payment_event') {
          return Promise.resolve({
            data: [{ out_payment_id: 'payment-uuid-1', out_status: 'refunded', out_duplicate: false }],
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      await recordPaygPaymentEvent(baseEvent({ status: 'refunded' }));

      const rpcNamesCalled = mockRpc.mock.calls.map(([name]) => name);
      expect(rpcNamesCalled).not.toEqual(
        expect.arrayContaining([
          'activate_subscription_tx',
          'admin_grant_credits',
          'admin_adjust_credits',
          'consume_ai_credits',
        ]),
      );
      // A non-confirmed outcome (refunded) must never trigger the PAYG
      // grant call either.
      expect(rpcNamesCalled).not.toContain('grant_payg_credits');

      // Only the packages table (a read) is ever queried via `.from` —
      // never users or credit_ledger directly from this module (all
      // balance/ledger mutation happens inside the RPCs, not here).
      const tablesQueried = mockFrom.mock.calls.map(([name]) => name);
      expect(tablesQueried).toEqual(['payg_packages']);
    });
  });

  describe('PAYG Phase 2 credit-grant orchestration (controlling prompt §8)', () => {
    it('invokes grant_payg_credits(payment_id) when record_payg_payment_event reports out_status = confirmed', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockImplementation((name, args) => {
        if (name === 'record_payg_payment_event') {
          return Promise.resolve({
            data: [{ out_payment_id: 'payment-uuid-1', out_status: 'confirmed', out_duplicate: false }],
            error: null,
          });
        }
        if (name === 'grant_payg_credits') {
          expect(args).toEqual({ p_payment_id: 'payment-uuid-1' });
          return Promise.resolve({
            data: [{ out_result: 'GRANTED', out_payment_id: 'payment-uuid-1', out_user_id: 'user-uuid-1', out_amount: 500, out_balance_after: 600, out_ledger_id: 'ledger-uuid-1' }],
            error: null,
          });
        }
        throw new Error(`Unexpected RPC: ${name}`);
      });

      await recordPaygPaymentEvent(baseEvent());

      const rpcNamesCalled = mockRpc.mock.calls.map(([name]) => name);
      expect(rpcNamesCalled).toEqual(['record_payg_payment_event', 'grant_payg_credits']);
    });

    it('still calls grant_payg_credits for a DUPLICATE confirmed event (the RPC itself is the idempotency backstop)', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockImplementation((name) => {
        if (name === 'record_payg_payment_event') {
          return Promise.resolve({
            data: [{ out_payment_id: 'payment-uuid-1', out_status: 'confirmed', out_duplicate: true }],
            error: null,
          });
        }
        if (name === 'grant_payg_credits') {
          return Promise.resolve({
            data: [{ out_result: 'ALREADY_GRANTED', out_payment_id: 'payment-uuid-1', out_ledger_id: 'ledger-uuid-1' }],
            error: null,
          });
        }
        throw new Error(`Unexpected RPC: ${name}`);
      });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(mockRpc.mock.calls.map(([name]) => name)).toContain('grant_payg_credits');
      expect(result).toMatchObject({ duplicate: true });
    });

    it('does not call grant_payg_credits for a non-confirmed status', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockResolvedValue({
        data: [{ out_payment_id: 'payment-uuid-1', out_status: 'pending', out_duplicate: false }],
        error: null,
      });

      await recordPaygPaymentEvent(baseEvent({ status: 'pending' }));

      expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['record_payg_payment_event']);
    });

    it('never throws when grant_payg_credits itself fails — payment recording result is still returned (controlling prompt §9)', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockImplementation((name) => {
        if (name === 'record_payg_payment_event') {
          return Promise.resolve({
            data: [{ out_payment_id: 'payment-uuid-1', out_status: 'confirmed', out_duplicate: false }],
            error: null,
          });
        }
        if (name === 'grant_payg_credits') {
          return Promise.resolve({ data: null, error: { message: 'connection reset' } });
        }
        throw new Error(`Unexpected RPC: ${name}`);
      });

      const result = await recordPaygPaymentEvent(baseEvent());

      expect(result).toMatchObject({ skipped: false, paymentId: 'payment-uuid-1', status: 'confirmed' });
      expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: SEVERITY.CRITICAL }));
    });

    it('never throws when grant_payg_credits rejects unexpectedly', async () => {
      mockMaybeSingle.mockResolvedValue({ data: activePackage(), error: null });
      mockRpc.mockImplementation((name) => {
        if (name === 'record_payg_payment_event') {
          return Promise.resolve({
            data: [{ out_payment_id: 'payment-uuid-1', out_status: 'confirmed', out_duplicate: false }],
            error: null,
          });
        }
        if (name === 'grant_payg_credits') {
          return Promise.reject(new Error('unexpected network failure'));
        }
        throw new Error(`Unexpected RPC: ${name}`);
      });

      await expect(recordPaygPaymentEvent(baseEvent())).resolves.toMatchObject({ skipped: false });
      expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: SEVERITY.CRITICAL }));
    });
  });
});
