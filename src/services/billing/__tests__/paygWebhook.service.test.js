'use strict';

/**
 * paygWebhook.service.test.js
 *
 * Normalization + relevance-routing tests for the PAYG-specific Stripe and
 * Razorpay handlers. recordPaygPaymentEvent is mocked — these tests are
 * about correct event -> normalized-shape mapping and about NOT firing
 * for subscription-shaped events (controlling prompt §13 isolation, from
 * the PAYG side).
 */

const mockRecordPaygPaymentEvent = jest.fn().mockResolvedValue({ skipped: false });

jest.mock('../paygPayment.service', () => ({
  recordPaygPaymentEvent: (...args) => mockRecordPaygPaymentEvent(...args),
}));

const {
  normalizeStripeEvent,
  normalizeRazorpayPayload,
  handleStripePaygWebhook,
  handleRazorpayPaygWebhook,
} = require('../paygWebhook.service');

describe('paygWebhook.service — Stripe normalization', () => {
  beforeEach(() => jest.clearAllMocks());

  it('normalizes a paid, mode:"payment" checkout.session.completed into a confirmed event', () => {
    const normalized = normalizeStripeEvent({
      id: 'evt_1',
      created: 1893456000,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 49900,
          currency: 'inr',
          metadata: { user_id: 'user-1', package_id: 'payg_500' },
        },
      },
    });

    expect(normalized).toMatchObject({
      provider: 'stripe',
      providerEventId: 'evt_1',
      providerPaymentId: 'pi_1',
      userId: 'user-1',
      packageId: 'payg_500',
      amount: 499,
      currency: 'INR',
      status: 'confirmed',
    });
  });

  it('ignores a mode:"subscription" checkout.session.completed (not PAYG)', () => {
    expect(normalizeStripeEvent({
      id: 'evt_2',
      created: 1893456000,
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', mode: 'subscription' } },
    })).toBeNull();
  });

  it('waits for payment_intent.succeeded when checkout session is not yet paid (async payment methods)', () => {
    expect(normalizeStripeEvent({
      id: 'evt_3',
      created: 1893456000,
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_3', mode: 'payment', payment_status: 'unpaid' } },
    })).toBeNull();
  });

  it('normalizes payment_intent.succeeded into a confirmed event when not tied to an invoice', () => {
    const normalized = normalizeStripeEvent({
      id: 'evt_4',
      created: 1893456000,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_4',
          amount: 49900,
          currency: 'inr',
          invoice: null,
          metadata: { user_id: 'user-1', package_id: 'payg_500' },
        },
      },
    });

    expect(normalized).toMatchObject({ status: 'confirmed', providerPaymentId: 'pi_4', amount: 499 });
  });

  it('ignores payment_intent.succeeded when tied to an invoice (subscription charge)', () => {
    expect(normalizeStripeEvent({
      id: 'evt_5',
      created: 1893456000,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_5', invoice: 'in_1' } },
    })).toBeNull();
  });

  it('normalizes payment_intent.payment_failed into a failed event', () => {
    const normalized = normalizeStripeEvent({
      id: 'evt_6',
      created: 1893456000,
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_6', amount: 49900, currency: 'inr' } },
    });

    expect(normalized).toMatchObject({ status: 'failed' });
  });

  it('normalizes charge.refunded (non-invoice) into a refunded event', () => {
    const normalized = normalizeStripeEvent({
      id: 'evt_7',
      created: 1893456000,
      type: 'charge.refunded',
      data: { object: { id: 'ch_7', payment_intent: 'pi_7', amount: 49900, currency: 'inr', invoice: null } },
    });

    expect(normalized).toMatchObject({ status: 'refunded', providerPaymentId: 'pi_7' });
  });

  it('normalizes charge.dispute.created into a disputed event', () => {
    const normalized = normalizeStripeEvent({
      id: 'evt_8',
      created: 1893456000,
      type: 'charge.dispute.created',
      data: { object: { payment_intent: 'pi_8', amount: 49900, currency: 'inr' } },
    });

    expect(normalized).toMatchObject({ status: 'disputed', providerPaymentId: 'pi_8' });
  });

  it('ignores unrelated event types', () => {
    expect(normalizeStripeEvent({ id: 'evt_9', created: 1, type: 'customer.updated', data: { object: {} } })).toBeNull();
  });

  it('handleStripePaygWebhook is a no-op for irrelevant events', async () => {
    await handleStripePaygWebhook({ id: 'evt_10', created: 1, type: 'customer.updated', data: { object: {} } });
    expect(mockRecordPaygPaymentEvent).not.toHaveBeenCalled();
  });

  it('handleStripePaygWebhook forwards a normalized PAYG event to recordPaygPaymentEvent', async () => {
    await handleStripePaygWebhook({
      id: 'evt_11',
      created: 1893456000,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_11', amount: 49900, currency: 'inr', metadata: { user_id: 'user-1', package_id: 'payg_500' } } },
    });

    expect(mockRecordPaygPaymentEvent).toHaveBeenCalledWith(expect.objectContaining({ providerPaymentId: 'pi_11' }));
  });
});

describe('paygWebhook.service — Razorpay normalization', () => {
  beforeEach(() => jest.clearAllMocks());

  it('normalizes payment.captured with no subscription entity into a confirmed event', () => {
    const normalized = normalizeRazorpayPayload({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_1',
            order_id: 'order_1',
            amount: 49900,
            currency: 'INR',
            notes: { user_id: 'user-1', package_id: 'payg_500' },
          },
        },
      },
    });

    expect(normalized).toMatchObject({
      provider: 'razorpay',
      providerPaymentId: 'order_1',
      userId: 'user-1',
      packageId: 'payg_500',
      amount: 499,
      currency: 'INR',
      status: 'confirmed',
    });
  });

  it('ignores payment.captured that carries a subscription entity (subscription charge, not PAYG)', () => {
    expect(normalizeRazorpayPayload({
      event: 'payment.captured',
      payload: {
        subscription: { entity: { id: 'sub_1' } },
        payment: { entity: { id: 'pay_1', amount: 49900 } },
      },
    })).toBeNull();
  });

  it('normalizes payment.failed with no subscription entity into a failed event', () => {
    const normalized = normalizeRazorpayPayload({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_2', amount: 49900, notes: { user_id: 'user-1' } } } },
    });

    expect(normalized).toMatchObject({ status: 'failed' });
  });

  it('ignores unrelated events', () => {
    expect(normalizeRazorpayPayload({ event: 'order.paid', payload: {} })).toBeNull();
  });

  it('does not attempt to parse refund.* or payment.dispute.* events (deferred — controlling prompt §9 Stop Condition)', async () => {
    await handleRazorpayPaygWebhook({ event: 'refund.processed', payload: { payload: { refund: { entity: { id: 'rfnd_1' } } } } });
    await handleRazorpayPaygWebhook({ event: 'payment.dispute.created', payload: {} });

    expect(mockRecordPaygPaymentEvent).not.toHaveBeenCalled();
  });

  it('handleRazorpayPaygWebhook forwards a normalized confirmed event to recordPaygPaymentEvent', async () => {
    await handleRazorpayPaygWebhook({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_3', order_id: 'order_3', amount: 49900, notes: { user_id: 'user-1', package_id: 'payg_500' } } } },
    });

    expect(mockRecordPaygPaymentEvent).toHaveBeenCalledWith(expect.objectContaining({ providerPaymentId: 'order_3' }));
  });
});
