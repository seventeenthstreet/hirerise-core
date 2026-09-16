'use strict';

/**
 * billing.service.paygIsolation.test.js
 *
 * PAYG Phase 1 — Subscription Isolation (controlling prompt §13) +
 * Subscription Regression (controlling prompt §19 report §10).
 *
 * Billing.service.js's legacy subscription webhook handlers received two
 * minimal, targeted guards as part of introducing PAYG:
 *   - Stripe: checkout.session.completed with mode:'payment' must NOT be
 *     treated as a subscription activation.
 *   - Razorpay: payment.captured with no subscription entity must NOT be
 *     treated as a subscription activation.
 * These tests prove (a) the guards correctly skip PAYG-shaped events
 * without calling activate_subscription_tx, and (b) genuine subscription
 * events are completely unaffected (regression coverage).
 */

const mockRpc = jest.fn();
const mockFrom = jest.fn(() => ({
  update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
}));

jest.mock('../../../config/supabase', () => ({
  supabase: {
    rpc: (...args) => mockRpc(...args),
    from: (...args) => mockFrom(...args),
  },
}));

jest.mock('../../../monitoring/alerts', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
  SEVERITY: { LOW: 'low', HIGH: 'high', CRITICAL: 'critical' },
}));

const { handleStripeWebhook, handleRazorpayWebhook } = require('../Billing.service');

function activateRpcRow() {
  return {
    data: [{ out_success: true, out_user_id: 'user-1', out_tier: 'pro', out_expires_at: null }],
    error: null,
  };
}

describe('Billing.service — PAYG subscription isolation guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Stripe', () => {
    it('does NOT call activate_subscription_tx for a checkout.session.completed with mode:"payment" (PAYG)', async () => {
      await handleStripeWebhook({
        id: 'evt_payg_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_payg_1',
            mode: 'payment',
            payment_status: 'paid',
            metadata: { user_id: 'user-1' },
          },
        },
      });

      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('STILL calls activate_subscription_tx for a genuine subscription checkout.session.completed (regression)', async () => {
      mockRpc.mockResolvedValue(activateRpcRow());

      await handleStripeWebhook({
        id: 'evt_sub_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_sub_1',
            mode: 'subscription',
            subscription: 'sub_1',
            metadata: { user_id: 'user-1' },
            amount_total: 49900,
            currency: 'inr',
          },
        },
      });

      expect(mockRpc).toHaveBeenCalledWith('activate_subscription_tx', expect.objectContaining({
        p_user_id: 'user-1',
        p_subscription_id: 'sub_1',
      }));
    });

    it('STILL calls activate_subscription_tx for customer.subscription.created (regression, unaffected by the guard)', async () => {
      mockRpc.mockResolvedValue(activateRpcRow());

      await handleStripeWebhook({
        id: 'evt_sub_2',
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_2',
            metadata: { user_id: 'user-1' },
            plan: { amount: 49900 },
            currency: 'inr',
          },
        },
      });

      expect(mockRpc).toHaveBeenCalledWith('activate_subscription_tx', expect.any(Object));
    });
  });

  describe('Razorpay', () => {
    it('does NOT call activate_subscription_tx for payment.captured with no subscription entity (PAYG order)', async () => {
      await handleRazorpayWebhook({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_payg_1',
              order_id: 'order_payg_1',
              amount: 49900,
              currency: 'INR',
              notes: { user_id: 'user-1' },
            },
          },
        },
      });

      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('STILL calls activate_subscription_tx for payment.captured WITH a subscription entity (regression)', async () => {
      mockRpc.mockResolvedValue(activateRpcRow());

      await handleRazorpayWebhook({
        event: 'payment.captured',
        payload: {
          subscription: {
            entity: {
              id: 'sub_rzp_1',
              notes: { user_id: 'user-1' },
              amount: 49900,
              currency: 'INR',
            },
          },
          payment: {
            entity: { id: 'pay_1', amount: 49900 },
          },
        },
      });

      expect(mockRpc).toHaveBeenCalledWith('activate_subscription_tx', expect.objectContaining({
        p_user_id: 'user-1',
        p_subscription_id: 'sub_rzp_1',
      }));
    });

    it('STILL calls activate_subscription_tx for subscription.charged (regression, unaffected by the guard)', async () => {
      mockRpc.mockResolvedValue(activateRpcRow());

      await handleRazorpayWebhook({
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: 'sub_rzp_2',
              notes: { user_id: 'user-1' },
              amount: 49900,
              currency: 'INR',
            },
          },
        },
      });

      expect(mockRpc).toHaveBeenCalledWith('activate_subscription_tx', expect.any(Object));
    });
  });
});
