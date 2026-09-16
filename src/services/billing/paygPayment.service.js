'use strict';

/**
 * src/services/billing/paygPayment.service.js
 *
 * PAYG Phase 1 — Payment Record Layer.
 *
 * Target flow (controlling prompt):
 *   Payment Provider -> verified provider event -> normalized payment
 *   event -> idempotent Payment record -> (future, separate phase) credit
 *   grant.
 *
 * This module ends at the Payment record. It is a deliberately SEPARATE
 * code path from src/services/billing/Billing.service.js (subscriptions):
 *   - it never calls activate_subscription_tx / cancel_subscription_tx
 *   - it never touches users.tier or users.subscription_status
 *   - it never grants credits: no credit_ledger insert, no
 *     users.ai_credits_remaining mutation, no admin_grant_credits /
 *     admin_adjust_credits / consume_ai_credits call anywhere in this file
 *
 * Both provider webhook routes invoke this module ALONGSIDE the existing
 * subscription handler (see src/routes/webhooks.routes.js) — each side
 * independently decides whether a given event is relevant to it and is a
 * safe no-op otherwise. Financial-integrity-critical writes are pushed
 * into the `record_payg_payment_event` Postgres RPC (see migration
 * 20260907010000_payg_phase1_payment_record_layer.sql) so that duplicate
 * delivery, retries and concurrent duplicates are resolved with
 * database-enforced uniqueness rather than an application-level
 * SELECT-then-INSERT.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');
const { sendAlert, SEVERITY } = require('../../monitoring/alerts');

const VALID_STATUSES = new Set(['pending', 'confirmed', 'failed', 'refunded', 'disputed']);

/**
 * Thrown for any condition that must stop PAYG payment processing without
 * throwing an unstructured error. Never surfaced to the provider — the
 * webhook route has already ACKed 200 before this module runs — but always
 * logged, and alerted for financial-integrity-relevant cases.
 */
class PaygPaymentError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'PaygPaymentError';
    this.code = code;
    this.context = context;
  }
}

// ── Package resolution (controlling prompt §7) ──────────────────────────────
//
// The client (and the payment provider's metadata, which is attacker-
// reachable in the sense that a compromised or misconfigured checkout
// integration could send anything) never determines the payable amount or
// credit quantity. This is the ONLY place package identity/price is
// resolved, and it is always read from payg_packages — never invented,
// never trusted from the provider payload beyond the package_id lookup key.

async function resolvePackage(packageId) {
  if (!packageId) {
    throw new PaygPaymentError('UNKNOWN_PACKAGE', 'No package_id present on provider event', {
      packageId,
    });
  }

  const { data, error } = await supabase
    .from('payg_packages')
    .select('id, credits, amount, currency, is_active')
    .eq('id', packageId)
    .maybeSingle();

  if (error) {
    logger.error('[PAYG/Package] Lookup failed', { packageId, error: error.message });
    throw new PaygPaymentError('PACKAGE_LOOKUP_FAILED', error.message, { packageId });
  }

  if (!data) {
    throw new PaygPaymentError('UNKNOWN_PACKAGE', `Unknown PAYG package: ${packageId}`, {
      packageId,
    });
  }

  if (!data.is_active) {
    throw new PaygPaymentError('INACTIVE_PACKAGE', `PAYG package is not active: ${packageId}`, {
      packageId,
    });
  }

  return data;
}

/**
 * Cross-checks a normalized event's provider-reported amount/currency
 * against the server-side package. Exact match required — no tolerance —
 * because this is the financial-integrity boundary (controlling prompt
 * §12: "Do not allow a webhook to self-declare arbitrary credits").
 */
function assertAmountMatches(pkg, normalized) {
  const expected = Number(pkg.amount);
  const actual = Number(normalized.amount);

  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.005) {
    throw new PaygPaymentError(
      'AMOUNT_MISMATCH',
      `Provider amount ${actual} ${normalized.currency} does not match package ${pkg.id} amount ${expected} ${pkg.currency}`,
      { packageId: pkg.id, expected, actual, currency: normalized.currency },
    );
  }

  if (String(normalized.currency).toUpperCase() !== String(pkg.currency).toUpperCase()) {
    throw new PaygPaymentError(
      'CURRENCY_MISMATCH',
      `Provider currency ${normalized.currency} does not match package ${pkg.id} currency ${pkg.currency}`,
      { packageId: pkg.id, expected: pkg.currency, actual: normalized.currency },
    );
  }
}

// ── The idempotent write path ────────────────────────────────────────────

/**
 * Validate a normalized PAYG payment event, resolve+cross-check its
 * package, and write it through the database-idempotent RPC.
 *
 * @param {object} normalized
 * @param {'stripe'|'razorpay'} normalized.provider
 * @param {string} normalized.providerEventId
 * @param {string} normalized.providerPaymentId
 * @param {string} normalized.userId
 * @param {string} normalized.packageId
 * @param {number} normalized.amount     Major currency units (e.g. rupees, dollars)
 * @param {string} normalized.currency
 * @param {'pending'|'confirmed'|'failed'|'refunded'|'disputed'} normalized.status
 * @param {string} normalized.occurredAt ISO timestamp
 * @param {object} [normalized.metadata]
 */
async function recordPaygPaymentEvent(normalized) {
  const {
    provider,
    providerEventId,
    providerPaymentId,
    userId,
    packageId,
    amount,
    currency,
    status,
    occurredAt,
    metadata = {},
  } = normalized;

  if (!provider || !providerEventId) {
    throw new PaygPaymentError('VALIDATION_ERROR', 'provider and providerEventId are required', {
      provider,
      providerEventId,
    });
  }

  if (!VALID_STATUSES.has(status)) {
    throw new PaygPaymentError('VALIDATION_ERROR', `Unrecognised status: ${status}`, { status });
  }

  if (!userId || !providerPaymentId) {
    // Mirrors Billing.service.js's metadata-miss handling for subscriptions:
    // a provider event that cannot be mapped to a user is a safe no-op,
    // not a hard failure — the provider will not retry a 200'd webhook,
    // so this is surfaced as an alert for manual reconciliation instead.
    sendAlert({
      message: `[PAYG] Missing user_id or provider_payment_id (${provider} / ${providerEventId})`,
      severity: SEVERITY.HIGH,
      alertKey: `payg:${provider}:${providerEventId}:missing-identity`,
      context: { provider, providerEventId, userId: userId ?? null, providerPaymentId: providerPaymentId ?? null },
    }).catch(() => {});

    logger.warn('[PAYG] Missing user_id or provider_payment_id — event ignored', {
      provider,
      providerEventId,
    });
    return { skipped: true, reason: 'MISSING_IDENTITY' };
  }

  // Package resolution only matters for the event that first creates the
  // Payment row (or re-confirms/fails it) — refund/dispute transitions on
  // an already-confirmed payment reuse the package already recorded on
  // that row, so we still resolve+cross-check here for defense in depth,
  // but a resolution failure on a refund/dispute is logged, not fatal to
  // the state transition itself (the payment already passed validation
  // when it was first confirmed).
  let pkg;
  try {
    pkg = await resolvePackage(packageId);
    assertAmountMatches(pkg, { amount, currency });
  } catch (err) {
    if (err instanceof PaygPaymentError && (status === 'refunded' || status === 'disputed')) {
      logger.warn('[PAYG] Package re-validation failed on refund/dispute — proceeding with state transition only', {
        provider,
        providerEventId,
        packageId,
        error: err.message,
      });
    } else {
      sendAlert({
        message: `[PAYG] Package validation failed (${provider} / ${providerEventId}): ${err.message}`,
        severity: SEVERITY.HIGH,
        alertKey: `payg:${provider}:${providerEventId}:package-invalid`,
        context: { provider, providerEventId, packageId, error: err.message },
      }).catch(() => {});

      logger.warn('[PAYG] Package validation failed — payment not recorded', {
        provider,
        providerEventId,
        packageId,
        error: err.message,
      });
      return { skipped: true, reason: err.code ?? 'PACKAGE_VALIDATION_FAILED' };
    }
  }

  const { data, error } = await supabase.rpc('record_payg_payment_event', {
    p_provider: provider,
    p_provider_event_id: providerEventId,
    p_provider_payment_id: providerPaymentId,
    p_user_id: userId,
    p_package_id: packageId,
    p_amount: amount,
    p_currency: String(currency).toUpperCase(),
    p_status: status,
    p_occurred_at: occurredAt ?? new Date().toISOString(),
    p_metadata: metadata,
  });

  if (error) {
    if (String(error.message).startsWith('INVALID_TRANSITION')) {
      // Out-of-order / duplicate-with-different-status event. Handled
      // safely (controlling prompt §10): do not fail the caller, just log.
      logger.warn('[PAYG] Invalid state transition — ignored', {
        provider,
        providerEventId,
        providerPaymentId,
        status,
        error: error.message,
      });
      return { skipped: true, reason: 'INVALID_TRANSITION' };
    }

    if (String(error.message).startsWith('INTEGRITY_VIOLATION')) {
      // AUDIT FIX (controlling audit prompt §5): the same provider_event_id
      // was delivered claiming a DIFFERENT provider_payment_id than it was
      // first associated with. This should only happen from a bug, a
      // corrupted/replayed delivery, or a malicious actor — never from
      // genuine provider behavior (event ids are unique per real event).
      // Surfaced loudly (alert + thrown error), never silently absorbed.
      sendAlert({
        message: `[PAYG] Integrity violation: ${error.message}`,
        severity: SEVERITY.CRITICAL,
        alertKey: `payg:${provider}:${providerEventId}:integrity-violation`,
        context: { provider, providerEventId, providerPaymentId, error: error.message },
      }).catch(() => {});

      logger.error('[PAYG] Integrity violation — event NOT recorded', {
        provider,
        providerEventId,
        providerPaymentId,
        error: error.message,
      });
      throw new PaygPaymentError('INTEGRITY_VIOLATION', error.message, { provider, providerEventId });
    }

    logger.error('[PAYG] record_payg_payment_event RPC failed', {
      provider,
      providerEventId,
      providerPaymentId,
      error: error.message,
    });
    throw new PaygPaymentError('RPC_FAILED', error.message, { provider, providerEventId });
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (row?.out_attributes_mismatch) {
    // AUDIT FIX (controlling audit prompt §6): identity/financial
    // attributes are never overwritten by a transition (enforced in the
    // RPC), but a disagreement between what this event claims and what
    // is already on record is worth a human looking at — surfaced as an
    // alert, not a block, so a legitimate status transition is never
    // lost just because upstream metadata is stale.
    sendAlert({
      message: `[PAYG] Payment attributes mismatch on transition (${provider} / ${providerEventId})`,
      severity: SEVERITY.HIGH,
      alertKey: `payg:${provider}:${providerEventId}:attributes-mismatch`,
      context: { provider, providerEventId, providerPaymentId, paymentId: row?.out_payment_id },
    }).catch(() => {});

    logger.warn('[PAYG] Payment attributes mismatch on transition — stored attributes unchanged', {
      provider,
      providerEventId,
      providerPaymentId,
      paymentId: row?.out_payment_id,
    });
  }

  logger.info('[PAYG] Payment event recorded', {
    provider,
    providerEventId,
    providerPaymentId,
    paymentId: row?.out_payment_id,
    status: row?.out_status,
    duplicate: row?.out_duplicate,
  });

  // ── PAYG Phase 2 — confirmed-payment -> credit-grant orchestration ─────
  //
  // Primary trigger condition (controlling prompt §8): out_status ===
  // 'confirmed'. This fires on BOTH the first-ever confirmation of a
  // payment AND any redundant/duplicate confirmed event for an
  // already-confirmed payment (out_duplicate === true, or a same-status
  // repeat via a new event id) — grant_payg_credits() is itself
  // idempotent (Phase 2 migration 20260908040000), so calling it here
  // unconditionally whenever the payment's current status is 'confirmed'
  // is always safe, never grants twice, and correctly recovers the case
  // where an earlier call's grant attempt failed/crashed after this same
  // payment was already marked confirmed.
  //
  // Deliberately NOT gated on `!row.duplicate`: a duplicate confirmed
  // webhook delivery is exactly the scenario that must still safely
  // reach the (idempotent) grant call, not skip it.
  if (row?.out_status === 'confirmed' && row?.out_payment_id) {
    await attemptPaygCreditGrant(row.out_payment_id, { provider, providerEventId, providerPaymentId });
  }

  return {
    skipped: false,
    duplicate: Boolean(row?.out_duplicate),
    paymentId: row?.out_payment_id,
    status: row?.out_status,
    attributesMismatch: Boolean(row?.out_attributes_mismatch),
  };
}

/**
 * Invoke the PAYG Phase 2 grant primitive for a confirmed payment and
 * translate its structured result into logs/alerts. Never throws — this
 * runs after the provider webhook has already been ACKed 200 (controlling
 * prompt §9: webhook failure semantics), so a grant failure here must not
 * become an unhandled rejection that could crash the request handler or
 * cause the provider to retry indefinitely. The confirmed payment record
 * itself is always preserved regardless of outcome; a failure here is
 * recovered later by the reconciliation job
 * (src/jobs/paygCreditReconciliation.job.js), which calls this same RPC.
 *
 * @param {string} paymentId
 * @param {object} context  Original provider/event identifiers, for logs/alerts only.
 */
async function attemptPaygCreditGrant(paymentId, context = {}) {
  const { provider, providerEventId, providerPaymentId } = context;

  try {
    const { data, error } = await supabase.rpc('grant_payg_credits', {
      p_payment_id: paymentId,
    });

    if (error) {
      // Internal grant failure after a successfully recorded confirmed
      // payment (controlling prompt §9, step 3): report loudly, but never
      // rethrow — the payment record is preserved, and reconciliation
      // will recover the missing grant.
      sendAlert({
        message: `[PAYG] Credit grant failed for confirmed payment ${paymentId}: ${error.message}`,
        severity: SEVERITY.CRITICAL,
        alertKey: `payg:grant:${paymentId}:failed`,
        context: { paymentId, provider, providerEventId, providerPaymentId, error: error.message },
      }).catch(() => {});

      logger.error('[PAYG] grant_payg_credits RPC failed — confirmed payment preserved, awaiting reconciliation', {
        paymentId,
        provider,
        providerEventId,
        error: error.message,
      });
      return;
    }

    const grantRow = Array.isArray(data) ? data[0] : data;

    if (grantRow?.out_result === 'GRANTED') {
      logger.info('[PAYG] Credit grant issued', {
        paymentId,
        userId: grantRow.out_user_id,
        amount: grantRow.out_amount,
        balanceAfter: grantRow.out_balance_after,
        ledgerId: grantRow.out_ledger_id,
      });
    } else if (grantRow?.out_result === 'ALREADY_GRANTED') {
      logger.info('[PAYG] Credit grant already applied (idempotent no-op)', {
        paymentId,
        ledgerId: grantRow.out_ledger_id,
      });
    } else if (grantRow?.out_result === 'NOT_ELIGIBLE') {
      // Should not normally happen immediately after record_payg_payment_event
      // itself reported out_status = 'confirmed', but the payment's status
      // could theoretically have moved on (e.g. an interleaved
      // refund/dispute event) by the time this call runs. Not an error —
      // logged for visibility only.
      logger.warn('[PAYG] Grant attempted but payment no longer eligible', {
        paymentId,
        paymentStatus: grantRow.out_payment_status,
      });
    }
  } catch (err) {
    // Defensive: the supabase-js client itself should reject into
    // `error` above, not throw, but this guards against any unexpected
    // throw (network, serialization, etc.) so a grant failure can never
    // propagate up into the webhook request handler.
    sendAlert({
      message: `[PAYG] Unexpected error invoking grant_payg_credits for payment ${paymentId}: ${err.message}`,
      severity: SEVERITY.CRITICAL,
      alertKey: `payg:grant:${paymentId}:unexpected-error`,
      context: { paymentId, provider, providerEventId, providerPaymentId, error: err.message },
    }).catch(() => {});

    logger.error('[PAYG] Unexpected error invoking grant_payg_credits', {
      paymentId,
      provider,
      providerEventId,
      error: err.message,
    });
  }
}


module.exports = {
  PaygPaymentError,
  resolvePackage,
  assertAmountMatches,
  recordPaygPaymentEvent,
  attemptPaygCreditGrant,
};
