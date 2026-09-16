'use strict';

/**
 * src/jobs/paygCreditReconciliation.job.js
 *
 * PAYG Phase 2 — Reconciliation safety net (controlling prompt §10).
 *
 * Purpose:
 *   confirmation succeeds -> process crashes before/during the credit
 *   grant call -> grant_payg_credits() is never invoked for that payment
 *   -> this job finds it and recovers it.
 *
 * This is the SAME pattern already used in this codebase for the daily
 * metrics aggregation worker (src/workers/daily-aggregation.worker.js):
 * a plain class with a runJob() entry point, invocable directly via
 * `node src/jobs/paygCreditReconciliation.job.js`, with NO in-process
 * scheduler. There is no cron/node-cron/Cloud-Scheduler wiring anywhere
 * in this codebase today (grep-verified: no `node-cron` dependency in
 * package.json; src/infrastructure/resilience/recoveryScheduler.service.js
 * is an explicit stub with no scheduling logic). Inventing a new
 * production scheduler framework is out of scope for this phase
 * (controlling prompt §10 / §18) — this file is the job HANDLER; wiring
 * it to run periodically (Cloud Scheduler -> Cloud Run Job, a
 * node-cron entry in the main process, or an ops cron entry calling this
 * file with `node`) is a deployment/infra decision that still needs to
 * be made and is called out explicitly in the final report as a
 * deferred item.
 *
 * Query: uses public.find_unreconciled_payg_grants(), a bounded,
 * read-only SECURITY DEFINER SQL function added in migration
 * 20260908040000. That function encodes exactly the logical condition
 * from the controlling prompt:
 *   payg_payments.status = 'confirmed'
 *   AND no credit_ledger GRANT row exists
 *     where source = 'payg' and reference_id = payg_payments.id::text
 *
 * Recovery: for each candidate payment id returned, calls
 * public.grant_payg_credits(payment_id) — the SAME idempotent primitive
 * the confirmed-payment orchestration path uses
 * (paygPayment.service.js#attemptPaygCreditGrant). This job never
 * mutates balances or the ledger directly; it only ever calls that one
 * RPC, so "never double-credit" is guaranteed by the RPC's own
 * idempotency, not by anything this job does.
 *
 * Safely repeatable: running this job again after a fully successful run
 * finds zero candidates (the GRANT row now exists) and is a clean no-op.
 * Running it again after a PARTIALLY successful run (e.g. it crashed
 * halfway through a batch) is equally safe — already-granted payments
 * are simply not returned by find_unreconciled_payg_grants() a second
 * time, and any payment it does re-attempt resolves to ALREADY_GRANTED
 * rather than a second grant.
 *
 * Bounded and observable: batch size is capped (BATCH_LIMIT, matching
 * the p_limit clamp — 1..5000 — enforced inside the SQL function
 * itself), and every outcome is logged with a per-run summary
 * (processed / granted / already_granted / not_eligible / failed)
 * returned from runJob() for the caller (ops tooling, a manual
 * invocation, or a future scheduler integration) to record or alert on.
 *
 * Uses only service_role-authorized execution (the shared `supabase`
 * client in src/config/supabase.js is the service-role client used by
 * every other backend-only RPC call in this codebase — this file adds
 * no new credential path).
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const { sendAlert, SEVERITY } = require('../monitoring/alerts');

const DEFAULT_BATCH_LIMIT = 500;

class PaygCreditReconciliationJob {
  /**
   * @param {object} [options]
   * @param {number} [options.limit] Max unreconciled payments to process
   *   in this run (clamped 1..5000 by the underlying SQL function
   *   regardless of what is passed here).
   */
  async runJob(options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_BATCH_LIMIT;
    const jobStart = Date.now();

    logger.info('[PAYG/Reconciliation] Starting run', { limit });

    const { data: candidates, error: lookupError } = await supabase.rpc(
      'find_unreconciled_payg_grants',
      { p_limit: limit }
    );

    if (lookupError) {
      sendAlert({
        message: `[PAYG/Reconciliation] Lookup failed: ${lookupError.message}`,
        severity: SEVERITY.HIGH,
        alertKey: 'payg:reconciliation:lookup-failed',
        context: { error: lookupError.message },
      }).catch(() => {});

      logger.error('[PAYG/Reconciliation] find_unreconciled_payg_grants RPC failed', {
        error: lookupError.message,
      });
      throw new Error(`PAYG reconciliation lookup failed: ${lookupError.message}`);
    }

    const rows = candidates ?? [];

    const summary = {
      candidates: rows.length,
      granted: 0,
      alreadyGranted: 0,
      notEligible: 0,
      failed: 0,
      failures: [],
    };

    for (const row of rows) {
      const paymentId = row.out_payment_id;

      try {
        const { data, error } = await supabase.rpc('grant_payg_credits', {
          p_payment_id: paymentId,
        });

        if (error) {
          summary.failed += 1;
          summary.failures.push({ paymentId, error: error.message });
          logger.error('[PAYG/Reconciliation] grant_payg_credits failed for candidate', {
            paymentId,
            error: error.message,
          });
          continue;
        }

        const grantRow = Array.isArray(data) ? data[0] : data;

        if (grantRow?.out_result === 'GRANTED') {
          summary.granted += 1;
          logger.info('[PAYG/Reconciliation] Recovered missing grant', {
            paymentId,
            userId: grantRow.out_user_id,
            amount: grantRow.out_amount,
            ledgerId: grantRow.out_ledger_id,
          });
        } else if (grantRow?.out_result === 'ALREADY_GRANTED') {
          // Benign race: something else (the original orchestration path,
          // or an overlapping reconciliation run) granted it between the
          // lookup query and this call.
          summary.alreadyGranted += 1;
        } else if (grantRow?.out_result === 'NOT_ELIGIBLE') {
          // Payment moved out of 'confirmed' (e.g. a refund/dispute
          // arrived) between the lookup query and this call.
          summary.notEligible += 1;
        }
      } catch (err) {
        summary.failed += 1;
        summary.failures.push({ paymentId, error: err.message });
        logger.error('[PAYG/Reconciliation] Unexpected error processing candidate', {
          paymentId,
          error: err.message,
        });
      }
    }

    const elapsed = Date.now() - jobStart;
    const result = { ...summary, durationMs: elapsed };

    if (summary.failed > 0) {
      sendAlert({
        message: `[PAYG/Reconciliation] ${summary.failed} grant(s) failed to recover`,
        severity: SEVERITY.HIGH,
        alertKey: 'payg:reconciliation:partial-failure',
        context: result,
      }).catch(() => {});
    }

    logger.info('[PAYG/Reconciliation] Run complete', result);
    return result;
  }
}

const paygCreditReconciliationJob = new PaygCreditReconciliationJob();

// Entry point when invoked directly (matches
// src/workers/daily-aggregation.worker.js convention).
if (require.main === module) {
  const limitArg = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;

  paygCreditReconciliationJob
    .runJob(limitArg ? { limit: limitArg } : {})
    .then(result => {
      logger.info('[PAYG/Reconciliation] CLI completed', { result });
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch(err => {
      logger.error('[PAYG/Reconciliation] CLI failed', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}

module.exports = paygCreditReconciliationJob;
