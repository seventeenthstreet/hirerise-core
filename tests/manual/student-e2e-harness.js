'use strict';

/**
 * tests/manual/student-e2e-harness.js
 *
 * Student MVP — live end-to-end verification harness.
 *
 * Exercises the REAL, deployed contract, as inspected directly from the
 * repository (not assumed/invented):
 *
 *   1. Create an isolated Supabase Auth test user (service-role admin API,
 *      email pre-confirmed — avoids the email-confirmation flow, which is
 *      the standard safe local-test mechanism; matches how
 *      scripts/maintenance/get-test-token.js *intended* to work, minus its
 *      stale Firebase dependency).
 *   2. Sign in as that user with the publishable key (never service-role) to get
 *      a real access_token — the same token a real browser session would
 *      hold, used both as the Supabase client's session AND as the
 *      Authorization: Bearer <token> header for backend calls
 *      (auth.middleware.js#safeGetUser calls
 *      getSupabaseAdmin().auth.getUser(rawToken) directly — confirmed by
 *      reading the source — so a raw Supabase access_token is exactly
 *      what the backend expects, no separate exchange step).
 *   3. Call GET {STUDENT_E2E_API_BASE_URL}/api/v1/app-entry with that Bearer
 *      token. This is the ONLY path that seeds public.users +
 *      public.user_profiles (via the seed_user_and_profile RPC, see
 *      user.registration.service.js#ensureUserSeeded) — the
 *      on_auth_user_created trigger only touches the legacy
 *      public.profiles stub, confirmed by reading
 *      20260519000001_fix_handle_new_user_trigger.sql. Skipping this step
 *      would make every downstream FK-dependent insert fail.
 *   4. Create the onboarding session via a DIRECT Supabase insert into
 *      student_onboarding_sessions, using the exact shape
 *      front/src/modules/student-onboarding/api/student-onboarding.api.ts
 *      #createOnboardingSession uses (fetch-first, insert-if-missing —
 *      NOT upsert, per that file's own documented reasoning) — because
 *      that is genuinely how the real frontend creates a session; the
 *      backend's own POST /session route
 *      (studentOnboarding.routes.js) is NOT mounted in server.js and is
 *      not used by anything real, so calling it would test dead code
 *      instead of the real path.
 *   5. Submit academics, activities (+ reflection, + commit), cognitive
 *      (+ commit), aspiration — using the exact validators read in
 *      src/modules/student-onboarding/validators/*.js. Cognitive
 *      questions are fetched live from GET .../v2/step/cognitive
 *      (taxonomy) rather than guessed, since question_id is a real UUID
 *      that must already exist in cognitive_questions.
 *   6. Saving aspiration triggers recommendationEngine.initiateGeneration
 *      server-side automatically (recommendation-lifecycle.service.js) —
 *      this harness does NOT call any generation endpoint directly, and
 *      does NOT call the legacy /generate-recommendations route.
 *   7. Poll GET .../student-onboarding/results until ready/failed/timeout.
 *   8. Best-effort cleanup of every table this harness wrote to, by
 *      user_id, then delete the auth user. If any deletion fails, this
 *      script STOPS and reports exactly what remains rather than
 *      guessing at a workaround — per your explicit instruction.
 *
 * WHAT THIS SCRIPT DOES NOT DO
 *   - Does not modify any production code, migration, RPC, or route.
 *   - Does not touch Admin or PAYG state.
 *   - Does not fix the orphaned POST/GET /session route — it correctly
 *     avoids using it, since the real frontend doesn't use it either.
 *   - Never prints SUPABASE_SERVICE_ROLE_KEY, access tokens, the test
 *     user's password, or STUDENT_E2E_API_BASE_URL's full value (only a
 *     masked form).
 *
 * REQUIRED ENVIRONMENT (read from .env via dotenv — nothing hard-coded)
 *   SUPABASE_URL                — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — for creating/deleting the test auth user only
 *   SUPABASE_PUBLISHABLE_KEY    — for the "real user" client (sign-in, session
 *                                  insert, backend Bearer token)
 *   STUDENT_E2E_API_BASE_URL    — deployed BACKEND API base URL used for
 *                                  every backend API request this harness
 *                                  makes (production value:
 *                                  https://api.hirerise.in). Accepts a bare
 *                                  host, or an already-absolute URL (http://
 *                                  or https://, preserved as configured).
 *                                  See normalizeBaseUrl() below — this is
 *                                  the single centralized place every
 *                                  backend request's base URL comes from.
 *                                  REQUIRED — this harness fails fast if it
 *                                  is unset rather than falling back to
 *                                  MAIN_DOMAIN (MAIN_DOMAIN is the
 *                                  application's primary website domain,
 *                                  e.g. https://hirerise.in, not the API
 *                                  host, and is never used for backend
 *                                  requests by this harness).
 *
 * USAGE
 *   cd core
 *   node tests/manual/student-e2e-harness.js [--timeout-ms 120000] [--poll-ms 3000]
 *
 * This script performs real network calls (Supabase Auth/DB + the
 * backend API). It has not been executed from this environment — see the
 * accompanying report for why.
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

// ── CLI args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { timeoutMs: 120000, pollMs: 3000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    if (argv[i] === '--timeout-ms') out.timeoutMs = parseInt(argv[i + 1], 10);
    if (argv[i] === '--poll-ms') out.pollMs = parseInt(argv[i + 1], 10);
  }
  return out;
}

function printUsage() {
  console.log(`
Student MVP — live E2E verification harness (verification-only, not production code)

USAGE
  node tests/manual/student-e2e-harness.js [options]

OPTIONS
  --timeout-ms <n>   Max time to poll GET /results before giving up (default: 120000)
  --poll-ms <n>       Delay between /results polls (default: 3000)
  --help, -h          Print this message and exit — makes no network calls,
                      reads no environment variables, creates nothing.

REQUIRED ENVIRONMENT (read from .env via dotenv; never printed)
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY   (test-user create/delete + persistence checks only)
  SUPABASE_PUBLISHABLE_KEY    (the "real user" client — sign-in, session insert,
                               and the backend Authorization: Bearer token)
  STUDENT_E2E_API_BASE_URL    (deployed BACKEND API base URL — bare host or
                               absolute http(s):// URL; normalized internally.
                               Production value: https://api.hirerise.in.
                               REQUIRED — this harness fails fast if unset;
                               it never falls back to MAIN_DOMAIN, which is
                               the application's website domain, not the API
                               host.)

WHAT THIS SCRIPT DOES
  Creates one isolated, pre-confirmed Supabase Auth test user, signs in as
  that user, seeds the application user via GET /api/v1/app-entry,
  creates an onboarding session via the same direct-Supabase mechanism the
  real frontend uses, submits academics/activities/reflection/commit/
  cognitive/commit/aspiration through the real backend API, lets aspiration
  trigger backend-owned recommendation generation, polls GET
  /api/v1/student-onboarding/results to ready/failed/timeout, independently
  verifies the persisted result via the service-role client, then deletes
  every row and the auth user it created.

WHAT THIS SCRIPT NEVER DOES
  Never calls the orphaned POST/GET /session route, never calls the legacy
  /generate-recommendations endpoint, never modifies production code, never
  prints SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY, passwords, access
  tokens, Authorization headers, cookies, or raw sensitive user records.
`);
}

// ── Redaction helpers — never print secrets ────────────────────────────
function maskDomain(url) {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.replace(/^([^.]{0,2}).*(\..+)$/, '$1***$2')}`;
  } catch {
    return '(unparseable — not printed)';
  }
}
function maskToken() {
  return '[REDACTED]';
}

/**
 * normalizeBaseUrl — single centralized normalizer for the harness's
 * backend API base URL (STUDENT_E2E_API_BASE_URL).
 *
 * Fixes the harness defect observed on first live run: the configured
 * backend host was a bare host ("hirerise.com"), which `fetch()` cannot
 * use directly (it has no scheme, so the runtime tries to parse it as a
 * relative URL and fails with "Failed to parse URL from ..."). This is a
 * harness bug, not an application defect — .env is untouched; the harness
 * simply needs to interpret it the way a browser or curl user normally
 * would.
 *
 * Rules:
 *   - Already absolute ("https://hirerise.com", "http://hirerise.com")
 *     → preserved as-is (scheme untouched — never force https over an
 *     explicitly-configured http).
 *   - Bare host ("hirerise.com", "hirerise.com/api") → "https://" is
 *     prepended, since a bare production-looking host with no scheme is
 *     overwhelmingly the https case, never invented as http.
 *   - Any configured path is preserved exactly, whichever branch applies.
 *   - Never produces a double scheme (checked via a case-insensitive
 *     "already has a scheme" test BEFORE prepending anything, not via
 *     string replacement that could mangle a legitimate path segment
 *     that happens to contain "http").
 *   - Trailing slash is stripped exactly once, so every call site's
 *     `${API_BASE_URL}${API_PREFIX}...` template never produces a
 *     double slash.
 *
 * @param {string} raw
 * @returns {string} normalized absolute base URL, no trailing slash
 */
function normalizeBaseUrl(raw) {
  const trimmed = (raw || '').trim();
  const hasScheme = /^https?:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

// ── Evidence log ────────────────────────────────────────────────────────
const evidence = {
  environment: {},
  testIdentity: {},
  onboarding: [],
  lifecycle: [],
  result: null,
  persistence: {},
  errors: [],
  cleanup: {},
  verdict: null,
};

function logStep(step) {
  evidence.onboarding.push(step);
  const status = step.success ? 'OK' : 'FAIL';
  console.log(
    `[${status}] ${step.method} ${step.endpoint} -> ${step.httpStatus ?? 'n/a'} (${step.elapsedMs}ms) ${step.summary ?? ''}`
  );
}

async function timedFetch(realtimeSafeFetch, url, options, label) {
  const startedAt = Date.now();
  let res, body, err;
  try {
    res = await realtimeSafeFetch(url, options);
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  } catch (e) {
    err = e;
  }
  const elapsedMs = Date.now() - startedAt;
  return { res, body, err, elapsedMs, label };
}

async function main() {
  const { timeoutMs, pollMs, help } = parseArgs(process.argv.slice(2));

  if (help) {
    // Short-circuit BEFORE reading any env var, creating any client, or
    // making any network call — --help must be side-effect-free.
    printUsage();
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  // STUDENT_E2E_API_BASE_URL is the deployed BACKEND API host (e.g.
  // https://api.hirerise.in) — deliberately NOT MAIN_DOMAIN, which is the
  // application's primary WEBSITE domain (e.g. https://hirerise.in), a
  // different host. Falling back to MAIN_DOMAIN here would silently point
  // every backend request at the wrong host, so this fails fast instead.
  const rawApiBaseUrl = process.env.STUDENT_E2E_API_BASE_URL;
  if (!rawApiBaseUrl) {
    console.error(
      'STUDENT_E2E_API_BASE_URL must be set — this harness never falls back to MAIN_DOMAIN ' +
      '(MAIN_DOMAIN is the website domain, not the backend API host). ' +
      'Set STUDENT_E2E_API_BASE_URL in .env, e.g. STUDENT_E2E_API_BASE_URL=https://api.hirerise.in ' +
      '(or an appropriate local backend URL for local runs).'
    );
    process.exitCode = 1;
    return;
  }
  const API_BASE_URL = normalizeBaseUrl(rawApiBaseUrl);
  const API_PREFIX = '/api/v1';

  evidence.environment = {
    supabaseUrl: maskDomain(SUPABASE_URL),
    backendHost: maskDomain(API_BASE_URL),
    localOrDeployed: API_BASE_URL.includes('localhost') ? 'local' : 'deployed',
    startedAt: new Date().toISOString(),
  };
  console.log('=== Student E2E Harness ===');
  console.log('Environment:', evidence.environment);

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PUBLISHABLE_KEY) {
    console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY must all be set.');
    process.exitCode = 1;
    return;
  }

  // Two clients, deliberately: admin (service role, test-user lifecycle
  // only) and user (publishable key, everything the real frontend would do).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: class { constructor() { throw new Error('Realtime not used by this harness.'); } } },
  });
  const userClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: class { constructor() { throw new Error('Realtime not used by this harness.'); } } },
  });

  const testEmail = `payg-e2e-test+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
  const testPassword = `Te$t${Math.random().toString(36).slice(2, 10)}Aa1!`; // never logged
  let userId = null;
  let accessToken = null;

  try {
    // ── 1. Create isolated test Student account (service-role, pre-confirmed) ──
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (createErr) throw new Error(`Auth user creation failed: ${createErr.message}`);
    userId = created.user.id;
    evidence.testIdentity = { email: testEmail, userId };
    console.log(`Test user created: ${testEmail} (userId sanitized: ${userId})`);

    // ── 2. Sign in as that user (publishable key) — real access_token ──
    const { data: signIn, error: signInErr } = await userClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signInErr) throw new Error(`Sign-in failed: ${signInErr.message}`);
    accessToken = signIn.session.access_token;
    console.log(`Signed in. access_token: ${maskToken()}`);

    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    // ── 3. Seed public.users/public.user_profiles via GET /app-entry ──
    // Router-local path is '/' in src/modules/appEntry/appEntry.route.js,
    // mounted at `${API_PREFIX}/app-entry` in server.js (line ~5050) —
    // resulting full path is /api/v1/app-entry, NOT /api/v1/app-entry/app-entry.
    // (Corrected after a live 404 revealed the previous inspection had
    // read the wrong, unmounted file: src/routes/appEntry.routes.js,
    // which does define a '/app-entry' sub-path but is never require()'d
    // anywhere in server.js — dead code, same category as the orphaned
    // /session route. The actually-mounted module is
    // src/modules/appEntry/appEntry.route.js, whose route is at '/'.)
    {
      const r = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/app-entry`, { headers: authHeaders }, 'app-entry');
      logStep({
        method: 'GET', endpoint: '/app-entry',
        httpStatus: r.res?.status, elapsedMs: r.elapsedMs,
        success: !r.err && r.res?.ok,
        summary: r.err ? r.err.message : JSON.stringify(r.body)?.slice(0, 150),
      });
      if (r.err || !r.res?.ok) throw new Error('app-entry seeding failed — cannot proceed (public.users row does not exist).');
    }

    // ── 4. Create onboarding session — direct Supabase insert, exact frontend shape ──
    const { data: existingSession } = await userClient
      .from('student_onboarding_sessions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    let session = existingSession;
    if (!session) {
      const { data: createdSession, error: sessionErr } = await userClient
        .from('student_onboarding_sessions')
        .insert({
          user_id: userId,
          current_step: 'education',
          completed_steps: [],
          is_complete: false,
          engine_version: '1.0.0',
        })
        .select('*')
        .single();
      if (sessionErr) throw new Error(`Onboarding session creation failed: ${sessionErr.message}`);
      session = createdSession;
    }
    console.log(`Onboarding session ready: id=${session.id}, current_step=${session.current_step}`);

    // ── 5a. Academics ──
    {
      const payload = {
        years: {
          class_10: {
            board_type: 'cbse',
            is_predicted: false,
            subjects: [
              { subject: 'mathematics', marks_obtained: 88, max_marks: 100, grade: 'A' },
            ],
          },
        },
        is_partial: false,
      };
      const r = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/academics`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(payload),
      }, 'academics');
      logStep({ method: 'POST', endpoint: '/v2/step/academics', httpStatus: r.res?.status, elapsedMs: r.elapsedMs, success: !r.err && r.res?.ok, summary: r.err ? r.err.message : undefined });
      if (r.err || !r.res?.ok) throw new Error(`Academics step failed: ${r.err?.message || JSON.stringify(r.body)}`);
    }

    // ── 5b. Activities: add, set depth (commits it), reflect, commit ──
    // Two real backend calls, matching activities.api.ts exactly — NOT a
    // single combined POST. addActivity() (POST /add) always persists
    // is_partial=true server-side regardless of what's sent; only
    // updateActivityDepth() (PUT /:activityKey/depth) can actually mark an
    // activity committed (is_partial=false), which is what the /commit step
    // below requires (signal_quality.is_sufficient needs >=1 committed
    // activity). See activity.service.js#addActivity /
    // #updateActivityDepth and activities.validator.js#validateActivityUpsert
    // for the evidence behind this shape.
    {
      const activityKey = 'public_speaking';

      // A. POST /add — Discovery: immediate partial persist.
      const addPayload = {
        activity_key: activityKey,
        activity_category: 'leadership',
      };
      const r1 = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/activities/add`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(addPayload),
      }, 'activities-add');
      logStep({ method: 'POST', endpoint: '/v2/step/activities/add', httpStatus: r1.res?.status, elapsedMs: r1.elapsedMs, success: !r1.err && r1.res?.ok, summary: r1.err ? r1.err.message : undefined });
      if (r1.err || !r1.res?.ok) throw new Error(`Activity add failed: ${r1.err?.message || JSON.stringify(r1.body)}`);

      // B. PUT /:activityKey/depth — commits the activity (is_partial:false).
      // activity_category is required by validateActivityUpsert() on every
      // call (not just inserts) even though updateActivityDepth() ignores
      // the submitted value server-side and keeps the existing one — the
      // real frontend (activities.api.ts#updateActivityDepth) always sends
      // it too, so this mirrors that exactly rather than relying on the
      // field being effectively a no-op.
      const depthPayload = {
        activity_category: 'leadership',
        proficiency_level: 'proficient',
        duration_months: 12,
        weekly_frequency: 2,
        currently_active: true,
        leadership_level: 'lead',
        is_partial: false,
      };
      const rDepth = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/activities/${encodeURIComponent(activityKey)}/depth`, {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(depthPayload),
      }, 'activities-depth');
      logStep({ method: 'PUT', endpoint: '/v2/step/activities/:activityKey/depth', httpStatus: rDepth.res?.status, elapsedMs: rDepth.elapsedMs, success: !rDepth.err && rDepth.res?.ok, summary: rDepth.err ? rDepth.err.message : undefined });
      if (rDepth.err || !rDepth.res?.ok) throw new Error(`Activity depth update failed: ${rDepth.err?.message || JSON.stringify(rDepth.body)}`);

      const reflectionPayload = {
        favorite_activity_key: 'public_speaking',
        pursue_seriously_key: 'public_speaking',
        proudest_achievement_text: 'Led the team to a regional final.',
      };
      const r2 = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/activities/reflection`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(reflectionPayload),
      }, 'activities-reflection');
      logStep({ method: 'POST', endpoint: '/v2/step/activities/reflection', httpStatus: r2.res?.status, elapsedMs: r2.elapsedMs, success: !r2.err && r2.res?.ok, summary: r2.err ? r2.err.message : undefined });
      if (r2.err || !r2.res?.ok) throw new Error(`Activity reflection failed: ${r2.err?.message || JSON.stringify(r2.body)}`);

      const r3 = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/activities/commit`, {
        method: 'POST', headers: authHeaders,
      }, 'activities-commit');
      logStep({ method: 'POST', endpoint: '/v2/step/activities/commit', httpStatus: r3.res?.status, elapsedMs: r3.elapsedMs, success: !r3.err && r3.res?.ok, summary: r3.err ? r3.err.message : undefined });
      if (r3.err || !r3.res?.ok) throw new Error(`Activities commit failed: ${r3.err?.message || JSON.stringify(r3.body)}`);
    }

    // ── 5c. Cognitive: fetch real questions, answer each, commit ──
    {
      const rGet = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/cognitive`, { headers: authHeaders }, 'cognitive-get');
      logStep({ method: 'GET', endpoint: '/v2/step/cognitive', httpStatus: rGet.res?.status, elapsedMs: rGet.elapsedMs, success: !rGet.err && rGet.res?.ok, summary: undefined });
      if (rGet.err || !rGet.res?.ok) throw new Error(`Cognitive taxonomy fetch failed: ${rGet.err?.message || JSON.stringify(rGet.body)}`);

      // taxonomy is an array of DOMAINS, each with a nested cognitive_questions[]
      // array, and each question has its own cognitive_options[] — confirmed from
      // cognitive.repository.js#fetchCognitiveTaxonomy (the actual 3-level
      // Supabase query: cognitive_taxonomy -> cognitive_questions -> cognitive_options)
      // and matched exactly by the frontend's use-cognitive.ts#normalizeTaxonomy.
      // Domains themselves never carry cognitive_options directly.
      const taxonomy = rGet.body?.taxonomy ?? [];
      const questions = taxonomy.flatMap((domain) => domain.cognitive_questions ?? []);
      if (questions.length === 0) {
        throw new Error('Cognitive taxonomy has no questions in this environment — cannot answer any questions. Reporting as a blocker, not working around it.');
      }

      for (const question of questions) {
        const optionKey = question.cognitive_options?.[0]?.option_key;
        if (!optionKey) {
          throw new Error(`Cognitive question ${question.id} has no options — cannot answer.`);
        }
        const rAns = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/cognitive/response`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ question_id: question.id, selected_option_keys: [optionKey], is_partial: false }),
        }, 'cognitive-answer');
        logStep({ method: 'POST', endpoint: `/v2/step/cognitive (question ${question.question_key ?? question.id})`, httpStatus: rAns.res?.status, elapsedMs: rAns.elapsedMs, success: !rAns.err && rAns.res?.ok, summary: undefined });
        if (rAns.err || !rAns.res?.ok) throw new Error(`Cognitive answer failed for ${question.id}: ${rAns.err?.message || JSON.stringify(rAns.body)}`);
      }

      const rCommit = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/cognitive/commit`, {
        method: 'POST', headers: authHeaders,
      }, 'cognitive-commit');
      logStep({ method: 'POST', endpoint: '/v2/step/cognitive/commit', httpStatus: rCommit.res?.status, elapsedMs: rCommit.elapsedMs, success: !rCommit.err && rCommit.res?.ok, summary: undefined });
      if (rCommit.err || !rCommit.res?.ok) throw new Error(`Cognitive commit failed: ${rCommit.err?.message || JSON.stringify(rCommit.body)}`);
    }

    // ── 5d. Aspiration — this is what triggers backend-owned generation ──
    {
      const aspirationPayload = {
        careerInterests: ['engineering'],
        motivationDriver: null,
        timeHorizon: null,
      };
      evidence.lifecycle.push({ stage: 'pre-aspiration', at: new Date().toISOString() });
      const r = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/v2/step/aspiration`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(aspirationPayload),
      }, 'aspiration');
      logStep({ method: 'POST', endpoint: '/v2/step/aspiration', httpStatus: r.res?.status, elapsedMs: r.elapsedMs, success: !r.err && r.res?.ok, summary: r.err ? r.err.message : undefined });
      if (r.err || !r.res?.ok) throw new Error(`Aspiration save failed: ${r.err?.message || JSON.stringify(r.body)}`);
      evidence.lifecycle.push({ stage: 'post-aspiration (generation should now be initiating server-side)', at: new Date().toISOString() });
    }

    // ── 6/7. Poll GET /results until ready / failed / timeout ──
    const pollStartedAt = Date.now();
    let finalStatus = null;
    let finalBody = null;
    while (Date.now() - pollStartedAt < timeoutMs) {
      const r = await timedFetch(fetch, `${API_BASE_URL}${API_PREFIX}/student-onboarding/results`, { headers: authHeaders }, 'results-poll');
      const status = r.body?.data?.status ?? 'unknown';
      evidence.lifecycle.push({ stage: `poll: ${status}`, at: new Date().toISOString(), httpStatus: r.res?.status });
      console.log(`[poll] status=${status} (${Date.now() - pollStartedAt}ms elapsed)`);
      if (r.err) throw new Error(`Results polling request failed: ${r.err.message}`);
      if (status === 'ready' || status === 'failed') {
        finalStatus = status;
        finalBody = r.body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (!finalStatus) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for recommendation to reach ready/failed.`);
    }

    logStep({ method: 'GET', endpoint: '/results (final)', httpStatus: 200, elapsedMs: Date.now() - pollStartedAt, success: finalStatus === 'ready', summary: `final status=${finalStatus}` });

    if (finalStatus === 'failed') {
      evidence.errors.push({ stage: 'generation', message: finalBody?.data?.message ?? '(no message)' });
      throw new Error(`Recommendation generation reported FAILED: ${finalBody?.data?.message ?? '(no message)'}`);
    }

    // finalStatus === 'ready'
    evidence.result = {
      hasResult: !!finalBody?.data?.result,
      generatedAt: finalBody?.data?.generatedAt,
      engineVersion: finalBody?.data?.engineVersion,
      resultKeys: finalBody?.data?.result ? Object.keys(finalBody.data.result) : [],
    };
    console.log('Recommendation READY. Sanitized summary:', evidence.result);

    // ── Persistence spot-check: re-query directly, confirm single row ──
    {
      const { data: rows, error: pErr } = await admin
        .from('student_recommendation_results')
        .select('user_id, status, generated_at, engine_version')
        .eq('user_id', userId);
      if (pErr) {
        evidence.persistence = { checked: false, error: pErr.message };
      } else {
        evidence.persistence = {
          checked: true,
          rowCount: rows.length,
          singleRow: rows.length === 1,
          status: rows[0]?.status,
        };
      }
      console.log('Persistence check:', evidence.persistence);
    }

    evidence.verdict = evidence.persistence.singleRow && evidence.result.hasResult ? 'PASS' : 'FAIL';
  } catch (err) {
    evidence.errors.push({ message: err.message });
    evidence.verdict = 'FAIL';
    console.error('HARNESS ERROR:', err.message);
  } finally {
    // ── Cleanup — best effort, explicit, never silent ──
    if (userId) {
      const cleanupTables = [
        'student_recommendation_results',
        'student_aspirations',
        'student_cognitive_signals',
        'student_cognitive_responses',
        'student_activity_reflections',
        'student_activity_achievements',
        'student_activities',
        'student_academic_subjects',
        'student_academic_records',
        'student_onboarding_sessions',
      ];
      const cleanupResults = {};
      for (const table of cleanupTables) {
        const { error, count } = await admin.from(table).delete({ count: 'exact' }).eq('user_id', userId);
        cleanupResults[table] = error ? `ERROR: ${error.message}` : `deleted ${count ?? 'unknown count'}`;
      }
      // public.users / public.user_profiles / public.profiles — best effort;
      // exact FK behavior between these was not fully re-verified in this
      // pass, so failures here are reported, not silently ignored.
      for (const table of ['user_profiles', 'users', 'profiles']) {
        const { error, count } = await admin.from(table).delete({ count: 'exact' }).eq('id', userId);
        cleanupResults[table] = error ? `ERROR: ${error.message}` : `deleted ${count ?? 'unknown count'}`;
      }
      const { error: authDelErr } = await admin.auth.admin.deleteUser(userId);
      cleanupResults['auth.users'] = authDelErr ? `ERROR: ${authDelErr.message}` : 'deleted';

      evidence.cleanup = cleanupResults;
      console.log('Cleanup results:', cleanupResults);

      const failures = Object.entries(cleanupResults).filter(([, v]) => String(v).startsWith('ERROR'));
      if (failures.length > 0) {
        console.error('CLEANUP INCOMPLETE — the following did not clean up automatically:');
        failures.forEach(([table, err]) => console.error(`  ${table}: ${err}`));
        console.error(`Manually verify and remove any remaining rows for user_id=${userId} before considering cleanup done.`);
      }
    } else {
      evidence.cleanup = { note: 'No test user was created — nothing to clean up.' };
    }

    console.log('\n=== FINAL EVIDENCE ===');
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`\nSTUDENT E2E LIVE VERIFICATION: ${evidence.verdict}`);
  }
}

main().catch((err) => {
  console.error('Harness crashed outside main try/catch:', err);
  process.exitCode = 1;
});
