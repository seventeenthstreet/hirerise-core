'use strict';

/**
 * tests/manual/payg-grant-concurrency-harness.js
 *
 * PAYG Phase 2 — genuine 20-way concurrency test for
 * public.grant_payg_credits(uuid).
 *
 * COMPANION FILE — run supabase/tests/PAYG_Phase2_Grant_Concurrency_regression.sql
 * PART 1 first to create an isolated test payment. That script prints
 * (and re-selects) `test_payment_id` — pass it here as --payment-id.
 * Run that same file's CLEANUP section after you are done, every time.
 *
 * WHY THIS SCRIPT, NOT A SQL DO BLOCK
 *   A sequential DO block, or 20 statements in one .sql file, execute in
 *   program order on ONE Postgres connection/session — that is not
 *   concurrency, it's 20 sequential calls that happen to be adjacent in
 *   a file. This script instead fires 20 independent HTTP requests to
 *   PostgREST via 20 separate supabase-js `.rpc()` calls, issued together
 *   via Promise.all and awaited together. Each request is served by its
 *   own Postgres backend/session on the server side — this is genuine,
 *   OS-level concurrency, the same shape of race a real burst of
 *   duplicate/retried webhook deliveries would produce in production.
 *
 * TOOLING
 *   Uses only @supabase/supabase-js and dotenv — both already project
 *   dependencies (see package.json; scripts/run-migrations.js and
 *   tests/manual/test-supabase.js already use exactly this pattern). No
 *   new dependency is introduced for this harness.
 *
 * CREDENTIALS
 *   Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 *   environment (via dotenv, matching scripts/run-migrations.js). Never
 *   hard-code a key here. grant_payg_credits is REVOKEd from anon/
 *   authenticated and GRANTed only to service_role (see migration
 *   20260908040000) — no other credential type can call it at all, so
 *   the service-role key is a functional requirement of this test, not
 *   an avoidable escalation. Run this only from a trusted environment
 *   that already holds that key (e.g. wherever scripts/run-migrations.js
 *   is normally run from), never from a client/browser context.
 *
 * SAFETY
 *   This script NEVER creates or deletes any state itself — it only
 *   calls grant_payg_credits(paymentId) 20 times for the ONE payment id
 *   you pass it. All setup and cleanup is the companion .sql file's
 *   responsibility, so you always know exactly what test state exists
 *   and can inspect/remove it independently of whether this script's
 *   run succeeds, hangs, or crashes.
 *
 * USAGE
 *   cd core
 *   node tests/manual/payg-grant-concurrency-harness.js --payment-id <uuid>
 *
 *   Optional: --calls <n>   (default 20 — matches the controlling
 *                            prompt's required concurrency width; only
 *                            change this for exploratory runs, not for
 *                            the evidence artifact itself)
 *
 * OUTPUT
 *   Prints each of the 20 individual (out_result, out_ledger_id,
 *   out_balance_after) tuples, then an aggregate summary, then a
 *   PASS/FAIL verdict against the documented invariant:
 *     - exactly one GRANTED (or zero, if a prior run already granted
 *       this payment — both are valid starting states, see the .sql
 *       file's PART 3 note)
 *     - every other call is ALREADY_GRANTED
 *     - every call that returned GRANTED or ALREADY_GRANTED reports the
 *       SAME out_ledger_id
 *     - no call throws / rejects (an unhandled error is an automatic
 *       FAIL — grant_payg_credits is documented to convert even a raw
 *       unique_violation into a clean ALREADY_GRANTED, so a thrown error
 *       reaching here would itself be evidence of a real defect, per
 *       this task's instruction to report rather than silently patch
 *       one if found)
 *
 *   This script does NOT modify grant_payg_credits, any migration, or
 *   any other production code. It only calls the existing RPC.
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

function parseArgs(argv) {
  const out = { calls: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--payment-id') out.paymentId = argv[i + 1];
    if (argv[i] === '--calls') out.calls = parseInt(argv[i + 1], 10);
  }
  return out;
}

async function main() {
  const { paymentId, calls } = parseArgs(process.argv.slice(2));

  if (!paymentId) {
    console.error('Usage: node tests/manual/payg-grant-concurrency-harness.js --payment-id <uuid> [--calls 20]');
    console.error('Get <uuid> by running supabase/tests/PAYG_Phase2_Grant_Concurrency_regression.sql PART 1 first.');
    process.exitCode = 1;
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (grant_payg_credits is service_role-only).');
    process.exitCode = 1;
    return;
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
    // HTTP/PostgREST-only client — do not initialize Realtime/WebSocket.
    //
    // @supabase/supabase-js's SupabaseClient constructor unconditionally
    // builds a RealtimeClient (SupabaseClient.ts#_initRealtimeClient),
    // even though this harness never calls .channel()/.realtime.connect()
    // and only ever uses .rpc() (PostgREST over plain HTTP, entirely
    // independent of Realtime). RealtimeClient's own constructor resolves
    // its transport eagerly: `result.transport = options?.transport ??
    // WebSocketFactory.getWebSocketConstructor()`
    // (@supabase/realtime-js RealtimeClient.ts#_initializeOptions). When
    // no `transport` override is supplied, getWebSocketConstructor() runs
    // immediately — and throws on Node.js 20, which has no global
    // `WebSocket` (added in Node 22; this is exactly the "Node.js 20
    // detected without native WebSocket support" crash, thrown during
    // createClient() itself, before any RPC call is made).
    //
    // Supplying our own `transport` here short-circuits that `??` and
    // getWebSocketConstructor() is never called, so the crash cannot
    // occur — no `ws` package, no other new dependency, no change to any
    // installed package. The placeholder below is never invoked: it
    // would only be constructed if something called
    // supabase.realtime.connect() or supabase.channel(...).subscribe(),
    // and this harness does neither. If it is ever accidentally invoked,
    // it fails loudly and specifically rather than pretending to be a
    // working socket.
    realtime: {
      transport: class RealtimeDisabledTransport {
        constructor() {
          throw new Error(
            'Realtime/WebSocket transport was invoked, but this harness is HTTP/PostgREST-only ' +
              '(grant_payg_credits is called via supabase.rpc(), not Realtime). ' +
              'This indicates unexpected use of supabase.channel()/supabase.realtime — not a supported code path here.'
          );
        }
      },
    },
  });

  console.log(`Firing ${calls} concurrent grant_payg_credits('${paymentId}') calls...`);

  const started = Date.now();

  // Promise.all + independent .rpc() calls = independent concurrent HTTP
  // requests, not sequential awaits. This is the true-concurrency step.
  const settled = await Promise.allSettled(
    Array.from({ length: calls }, () =>
      supabase.rpc('grant_payg_credits', { p_payment_id: paymentId })
    )
  );

  const elapsedMs = Date.now() - started;

  const results = [];
  const errors = [];

  settled.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      errors.push({ call: i + 1, error: outcome.reason?.message ?? String(outcome.reason) });
      return;
    }
    const { data, error } = outcome.value;
    if (error) {
      errors.push({ call: i + 1, error: error.message });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    results.push({ call: i + 1, ...row });
  });

  console.log(`\nCompleted in ${elapsedMs}ms. ${results.length} calls returned normally, ${errors.length} threw/rejected.\n`);

  console.log('Individual results:');
  results.forEach((r) => {
    console.log(`  call ${String(r.call).padStart(2, ' ')}: out_result=${r.out_result}  out_ledger_id=${r.out_ledger_id}  out_balance_after=${r.out_balance_after}`);
  });

  if (errors.length > 0) {
    console.log('\nErrors (should be empty — grant_payg_credits is documented to never throw for a concurrent-idempotency race):');
    errors.forEach((e) => console.log(`  call ${e.call}: ${e.error}`));
  }

  // ── Aggregate ──────────────────────────────────────────────────────
  const grantedCount = results.filter((r) => r.out_result === 'GRANTED').length;
  const alreadyGrantedCount = results.filter((r) => r.out_result === 'ALREADY_GRANTED').length;
  const notEligibleCount = results.filter((r) => r.out_result === 'NOT_ELIGIBLE').length;
  const otherCount = results.length - grantedCount - alreadyGrantedCount - notEligibleCount;

  const ledgerIds = new Set(
    results
      .filter((r) => r.out_result === 'GRANTED' || r.out_result === 'ALREADY_GRANTED')
      .map((r) => r.out_ledger_id)
      .filter(Boolean)
  );

  console.log('\nAggregate:');
  console.log(`  GRANTED:         ${grantedCount}`);
  console.log(`  ALREADY_GRANTED: ${alreadyGrantedCount}`);
  console.log(`  NOT_ELIGIBLE:    ${notEligibleCount}`);
  console.log(`  other/unexpected:${otherCount}`);
  console.log(`  distinct ledger ids among GRANTED/ALREADY_GRANTED: ${ledgerIds.size}`);

  // ── Verdict ────────────────────────────────────────────────────────
  // grantedCount must be 0 or 1 across THIS run (1 if this payment had
  // never been granted before this run; 0 if PART 2 of the .sql script,
  // or a prior run of this harness, already granted it — both are valid
  // per grant_payg_credits' idempotency contract).
  const noErrors = errors.length === 0;
  const grantedAtMostOnce = grantedCount <= 1;
  const restAreAlreadyGrantedOrEligibleGranted = grantedCount + alreadyGrantedCount === results.length || notEligibleCount === results.length;
  const singleLedgerId = ledgerIds.size <= 1;

  const pass = noErrors && grantedAtMostOnce && restAreAlreadyGrantedOrEligibleGranted && singleLedgerId && results.length === calls;

  console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'} — invariant is "at most one GRANTED, everything else ALREADY_GRANTED, one ledger id, zero errors" for this run.`);
  if (!pass) {
    console.log('This is evidence of a possible real defect, not a harness bug to silently work around — do not patch grant_payg_credits based on this script alone; report the specific failing dimension above.');
  }

  console.log('\nNext: run the verification queries (V1/V2) in the companion .sql file against the same payment id to cross-check ledger/balance state, then run its CLEANUP section.');
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});
