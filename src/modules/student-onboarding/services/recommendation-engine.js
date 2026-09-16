/**
 * @file src/modules/student-onboarding/services/recommendation-engine.js
 *
 * PHASE 1 — STUDENT RECOMMENDATION ENGINE
 * ════════════════════════════════════════════════════════════════════════
 * Primary entry point: initiateGeneration(userId) — the single guarded
 * dispatch point for starting Recommendation generation. Called from
 * recommendation-lifecycle.service.js (backend-owned aspiration→processing
 * transition) and, for backward compatibility, from the legacy
 * POST /api/v1/student-onboarding/generate-recommendations route.
 *
 * PHASE 1 PASS 1 (context/validation refactor):
 *   Per Phase 1 spec §8, this module no longer independently queries the
 *   five canonical Student source tables or the forbidden legacy tables
 *   (student_academics_profiles, student_interests_profiles,
 *   student_learning_styles, student_exposure_profiles,
 *   student_financial_profiles). It:
 *     1. Consumes the assembled Canonical Recommendation Context from
 *        canonical-context.service.js#assembleCanonicalStudentContext
 *        (which itself owns all canonical reads + Intelligence
 *        consumption — this module has no responsibility for assembling
 *        raw Student context).
 *     2. Builds the prompt from that context only.
 *     3. Calls the AI provider.
 *     4. Runs real structural/schema validation
 *        (recommendation-output.validator.js) BEFORE persistence.
 *     5. Persists only a structurally valid result, tagging it with
 *        `context_version` and the validated, governed `career_area_key`.
 *
 * PHASE 1 PASS 2 (this pass — recommendation lifecycle / trigger wiring):
 *   - `initiateGeneration()` added: atomically writes a `pending` row
 *     (duplicate-guarded via the existing UNIQUE(user_id) constraint +
 *     `ignoreDuplicates` upsert, matching this repo's existing pattern —
 *     see salary.repository.js) and launches generation fire-and-forget.
 *   - `generateRecommendations()` now persists `status: 'failed'` with a
 *     safe, secret-free `error_detail` on any generation-time failure
 *     (provider error, structural validation failure, storage failure),
 *     rather than silently leaving the row at whatever state it was in.
 *     A failure write only ever flips `pending` → `failed`; it never
 *     touches a `ready` row.
 *   - Session advance to `result` on success remains best-effort and
 *     isolated: its failure is logged, never allowed to downgrade an
 *     already-persisted `ready` status.
 *   - The backend-owned transition into `processing` itself (session
 *     advance + calling `initiateGeneration`) lives in
 *     recommendation-lifecycle.service.js, invoked from
 *     aspiration.controller.js — NOT here, and NOT in aspiration.service.js
 *     (which has a regression test asserting it never imports
 *     session.service — see aspiration.service.test.js).
 *   - Explicit regeneration (re-launching after `failed`/`ready`) remained
 *     out of scope for Pass 2 — deferred to a dedicated retry pass.
 *
 * PHASE 1 PASS 3 (this pass — explicit retry / regeneration):
 *   - `initiateRetry()` added: the explicit, authenticated recovery entry
 *     point (`failed`/`ready` → `pending`), atomically guarded by a
 *     conditional UPDATE (see its JSDoc for the full concurrency
 *     argument). Distinct from `initiateGeneration()`, which remains the
 *     sole entry point for the backend-owned *initial* trigger and never
 *     transitions an existing `failed`/`ready` row.
 *
 * AI-ERA GUIDANCE RULES (enforced in prompt — unchanged from Phase 0):
 *   - NEVER say "this career is dead"
 *   - ALWAYS use: "evolving rapidly, requires continuous upskilling"
 *   - Avoid fear-based language; use opportunity-based framing
 *   - All recommendations must include human-edge and AI disruption scores
 *
 * NOTE ON FINANCIAL GUIDANCE RULES (Phase 0/legacy prompt):
 *   The previous prompt's "financial awareness" rules (affordabilityFit,
 *   scholarship suggestions keyed to a stated budget) depended entirely on
 *   student_financial_profiles, which is now forbidden context (§5). This
 *   pass removes those rules and the corresponding output fields rather
 *   than inventing a replacement financial signal — reintroducing
 *   financial guidance is explicitly prohibited this pass (§19: "add
 *   financial context").
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { assembleCanonicalStudentContext } = require('./canonical-context.service');
const { fetchGovernedCareerAreaKeys } = require('../repositories/career-area.repository');
const {
  parseRecommendationOutput,
  validateRecommendationOutput,
} = require('../validators/recommendation-output.validator');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RESULTS_TABLE  = 'student_recommendation_results';
const SESSIONS_TABLE = 'student_onboarding_sessions';

// ─────────────────────────────────────────────────────────────────────────────
// SAFE ERROR DETAIL
// Maps a generation-time error to a short, secret-free string suitable for
// persistence in `error_detail` (Phase 1 lifecycle spec §9). Never includes
// stack traces, raw provider payloads/headers, prompts, or credentials.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Error} err
 * @returns {string}
 */
function safeErrorDetail(err) {
  // Errors raised by our own parser/validator are already short, structural,
  // and explicitly documented as safe to surface into error_detail — see
  // recommendation-output.validator.js's file header. Pass them through
  // directly rather than re-wrapping.
  if (typeof err?.message === 'string' && err.message.startsWith('Recommendation output rejected:')) {
    return err.message.slice(0, 500);
  }

  if (typeof err?.message === 'string' && err.message.startsWith('Failed to store recommendation result')) {
    return 'Recommendation could not be saved due to an internal storage error.';
  }

  // Anthropic SDK errors (APIError and subclasses) expose a numeric HTTP-like
  // `status` — safe to surface (no headers/body/prompt), useful for triage.
  if (typeof err?.status === 'number') {
    return `Recommendation provider request failed (status ${err.status}).`;
  }

  if (err?.name === 'AbortError' || /timeout/i.test(err?.message ?? '')) {
    return 'Recommendation provider request timed out.';
  }

  return 'Recommendation generation failed due to an unexpected internal error.';
}

/**
 * Flips a `pending` result row to `failed` with a safe error_detail.
 * Only ever transitions status FROM 'pending' — never touches a 'ready'
 * row, so a stray/late failure write can never clobber a valid previous
 * result (Phase 1 lifecycle spec §5/§8).
 *
 * Best-effort: logs and swallows its own failure rather than throwing,
 * because it is always called from within an already-failed path — the
 * caller has nothing more useful to do than rethrow the original error.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {string} userId
 * @param {Error} err
 */
async function persistFailure(supabaseClient, userId, err) {
  const errorDetail = safeErrorDetail(err);

  const { error } = await supabaseClient
    .from(RESULTS_TABLE)
    .update({ status: 'failed', error_detail: errorDetail })
    .eq('user_id', userId)
    .eq('status', 'pending');

  if (error) {
    logger.error(
      `[recommendation-engine] Failed to persist failure state for user ${userId}: ${error.message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the assessment prompt from the assembled Canonical Recommendation
 * Context only. No legacy/forbidden field is referenced here.
 *
 * @param {Object} context - see canonical-context.service.js's JSDoc for shape
 * @returns {string}
 */
function buildAssessmentPrompt(context) {
  const { education, academics, activities, cognitive, aspiration, intelligence } = context;

  const subjectLines = (academics?.subjects ?? [])
    .map((s) => `- ${s.subject ?? 'unknown'}: ${s.performance_band ?? s.grade ?? 'not specified'}`)
    .join('\n') || 'Not provided';

  const activityLines = (activities?.activities ?? [])
    .map((a) => `- ${a.activity_key ?? a.activity_category ?? 'activity'}`)
    .join('\n') || 'None specified';

  const achievementLines = (activities?.achievements ?? [])
    .map((a) => `- ${a.title ?? a.description ?? 'achievement'}`)
    .join('\n') || 'None specified';

  const careerInterests = aspiration?.career_interests?.join(', ') || 'Not provided';

  const intelligenceSummary = intelligence?.vector
    ? JSON.stringify(intelligence.vector)
    : 'Not yet available for this student — base recommendations on the profile data below only.';

  return `You are HireRise's career intelligence AI, helping a student in India plan their future career path.

You must generate a comprehensive, personalised career recommendation report based on the student's canonical assessment profile below.

## STUDENT PROFILE

### Education Context
- Class: ${education?.education_level ?? 'unknown'}
- Board: ${education?.board_type ?? 'not specified'}
- School Type: ${education?.school_type ?? 'not specified'}

### Academic Snapshot
${subjectLines}

### Activities & Achievements
Activities:
${activityLines}
Achievements:
${achievementLines}

### Cognitive Signals
${cognitive?.signals ? JSON.stringify(cognitive.signals) : 'Not yet available for this student.'}

### Aspiration (sole career-interest source)
Stated career interests: ${careerInterests}
Motivation driver: ${aspiration?.motivation_driver ?? 'not specified'}
Time horizon: ${aspiration?.time_horizon ?? 'not specified'}

### Cross-Domain Intelligence Signal Vector
${intelligenceSummary}

---

## YOUR TASK

Generate a structured JSON career recommendation report. Return ONLY valid JSON, no markdown, no preamble.

The JSON must exactly match this TypeScript type structure:

\`\`\`
{
  strengthSummary: {
    traits: string[],           // 3-5 traits (e.g. "analytical thinker", "creative problem solver")
    academicInsights: string[], // 2-3 observations about academic pattern
    exposureHighlights: string[] // 2-3 observations about activities
  },
  streamScores: [
    { stream: "science"|"commerce"|"humanities", score: number(0-100), label: string, rationale: string }
  ],
  recommendedDomains: [          // 3-5 domains, ranked by fit
    {
      id: string,                // slug like "ai-engineering"
      title: string,
      description: string,
      whyItFitsYou: string,      // personalised explanation using their actual profile data
      futureScore: number(0-100),
      aiRiskScore: number(0-100),
      humanEdgeScore: number(0-100),
      employabilityScore: number(0-100),
      roiPotential: "low"|"medium"|"high"|"very_high",
      globalOpportunity: "local"|"national"|"global",
      exampleRoles: string[],
      entryPaths: string[],
      aiEraGuidance: string      // MUST be encouraging, NOT fear-based
    }
  ],
  careerAreaKey: string|null,   // ONE of: technology, engineering, natural_sciences, business,
                                 // creative_industries, social_sciences, health_sciences, education
                                 // — use null if the profile is too ambiguous to classify confidently.
                                 // Do NOT invent any other value.
  futureCareerNote: string      // 2-3 sentences on AI era, must be encouraging not scary
}
\`\`\`

## CRITICAL RULES

1. NEVER say any career is "dying" or "dead". Use: "evolving rapidly and requiring continuous upskilling and AI collaboration."
2. whyItFitsYou MUST reference actual data from THIS student's profile — not generic text.
3. streamScores must include all three streams (science, commerce, humanities), summing to a reasonable distribution.
4. careerAreaKey must be exactly one of the 8 listed values, or null — never a new/invented value.
5. Return ONLY the JSON object. No markdown fences. No explanation.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {Object} [deps] - injectable dependencies (tests only)
 * @returns {Promise<Object>} the persisted, validated recommendation result
 */
async function generateRecommendations(userId, deps = {}) {
  const {
    supabaseClient = supabase,
    anthropicClient = anthropic,
    assembleContext = assembleCanonicalStudentContext,
    fetchGovernedKeys = fetchGovernedCareerAreaKeys,
  } = deps;

  console.log(`[recommendation-engine] Starting for user: ${userId}`);

  // Steps 1–4 (context assembly through structural validation) are wrapped
  // together: ANY failure here — provider/network failure, malformed or
  // invalid output — is an "expected generation error" per Phase 1
  // lifecycle spec §5 and results in a single, safe `status: 'failed'`
  // write (persistFailure), never a partial/duplicate failure write.
  let result;
  let context;

  try {
    // 1. Assemble the Canonical Recommendation Context (owns all canonical
    //    reads + Intelligence consumption; this module does none of that).
    context = await assembleContext(userId, supabaseClient);

    // 2. Build prompt from the assembled context only.
    const prompt = buildAssessmentPrompt(context);

    // 3. Call the AI provider.
    console.log(`[recommendation-engine] Calling Claude for user: ${userId}`);
    const response = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // 4. Parse, then run real structural/schema validation BEFORE persistence.
    const parsed = parseRecommendationOutput(rawText);
    if (!parsed.ok) {
      console.error(`[recommendation-engine] ${parsed.error} for user ${userId}`);
      throw new Error(`Recommendation output rejected: ${parsed.error}`);
    }

    // Governed Career Area vocabulary — best-effort read. If it cannot be
    // fetched, fail closed on any non-null careerAreaKey (safer than
    // silently accepting an unverifiable value against a frozen,
    // governance-restricted vocabulary) while still allowing a null one.
    let governedCareerAreaKeys = [];
    try {
      governedCareerAreaKeys = await fetchGovernedKeys(supabaseClient);
    } catch (err) {
      console.error(
        `[recommendation-engine] Failed to load governed Career Area keys for user ${userId}: ${err.message}`,
      );
      governedCareerAreaKeys = [];
    }

    const validated = validateRecommendationOutput(parsed.data, { governedCareerAreaKeys });
    if (!validated.ok) {
      console.error(`[recommendation-engine] ${validated.error} for user ${userId}`);
      throw new Error(`Recommendation output rejected: ${validated.error}`);
    }

    result = validated.data;
  } catch (err) {
    console.error(`[recommendation-engine] Generation failed for user ${userId}: ${err.message}`);
    await persistFailure(supabaseClient, userId, err);
    throw err;
  }

  // 5. Persist only the validated result.
  const fullResult = {
    userId,
    generatedAt: new Date().toISOString(),
    ...result,
  };

  const topDomain = result.recommendedDomains[0];
  const topStream = result.streamScores.reduce((best, s) => (s.score > best.score ? s : best), result.streamScores[0]);

  const { error: insertError } = await supabaseClient
    .from(RESULTS_TABLE)
    .upsert(
      {
        user_id:          userId,
        result_json:      JSON.stringify(fullResult),
        engine_version:   'v1',
        top_domain_id:    topDomain?.id ?? null,
        top_stream:       topStream?.stream ?? null,
        career_area_key:  result.careerAreaKey,
        context_version:  context.contextVersion,
        status:           'ready',
        error_detail:     null,
        generated_at:     new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (insertError) {
    // The recommendation itself is valid but could not be saved. A
    // valid-but-unpersisted result is indistinguishable from "no result"
    // to the student, so this is surfaced as a failure (status: 'failed')
    // rather than silently leaving the row stuck at 'pending' forever.
    const persistErr = new Error(`Failed to store recommendation result: ${insertError.message}`);
    await persistFailure(supabaseClient, userId, persistErr);
    throw persistErr;
  }

  // 6. Advance session to 'result' — pre-existing behavior, unchanged in
  // intent. Best-effort: a failure here must NOT downgrade the
  // just-persisted 'ready' status (the Recommendation is valid and saved;
  // only the navigation-state bookkeeping failed), so it is logged and
  // swallowed rather than thrown.
  const { error: sessionError } = await supabaseClient
    .from(SESSIONS_TABLE)
    .update({
      current_step: 'result',
      updated_at:   new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (sessionError) {
    logger.error(
      `[recommendation-engine] Failed to advance session to result for user ${userId}: ${sessionError.message}`,
    );
  }

  console.log(`[recommendation-engine] Complete for user: ${userId}`);
  return fullResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARDED INITIATION — the single entry point for starting generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically starts Recommendation generation for `userId`, guarding
 * against duplicate/concurrent initial triggers (Phase 1 lifecycle spec
 * §6/§7).
 *
 * CONCURRENCY MODEL:
 *   Uses the existing UNIQUE(user_id) constraint on
 *   student_recommendation_results via
 *   `upsert(..., { onConflict: 'user_id', ignoreDuplicates: true })` — the
 *   same duplicate-guard pattern already used elsewhere in this repository
 *   (see salary.repository.js#insertSalaryRecord,
 *   conversionEvent.repository.js). No new database primitive is
 *   introduced.
 *
 *   If a row already exists for this user — 'pending', 'ready', or
 *   'failed' — the insert is silently ignored (no row returned) and no new
 *   generation is started. This is what makes repeated calls (duplicate
 *   onboarding-completion requests, a resubmitted aspiration form) safe:
 *   the very first caller to successfully insert the 'pending' row is the
 *   only one that launches generation.
 *
 *   This function only handles the INITIAL generation. Explicit
 *   regeneration (re-launching after a 'failed' or 'ready' row already
 *   exists) is out of scope for this pass and is deferred to the
 *   dedicated retry/regeneration pass (Phase 1 lifecycle spec §10/§19).
 *
 * NON-BLOCKING:
 *   generateRecommendations() is launched fire-and-forget — never awaited
 *   by the caller — so this function resolves as soon as the pending row
 *   is (or is not) created, never blocking on AI provider latency.
 *
 * @param {string} userId
 * @param {Object} [deps] - forwarded to generateRecommendations; also used
 *   to inject supabaseClient for the atomic guard itself (tests only).
 * @returns {Promise<{ started: boolean }>}
 */
async function initiateGeneration(userId, deps = {}) {
  const { supabaseClient = supabase } = deps;

  const { data, error } = await supabaseClient
    .from(RESULTS_TABLE)
    .upsert(
      {
        user_id:        userId,
        status:         'pending',
        result_json:    {},
        engine_version: 'v1',
      },
      { onConflict: 'user_id', ignoreDuplicates: true },
    )
    .select('user_id');

  if (error) {
    logger.error(`[recommendation-engine] Failed to start generation for user ${userId}: ${error.message}`);
    throw new Error(`Failed to initiate recommendation generation: ${error.message}`);
  }

  const started = Array.isArray(data) && data.length > 0;

  if (!started) {
    logger.info(
      `[recommendation-engine] Generation already initiated for user ${userId} — skipping duplicate trigger.`,
    );
    return { started: false };
  }

  // Fire-and-forget — never block the caller on AI provider latency.
  // generateRecommendations() persists its own success/failure state, so
  // there is nothing further to do with the outcome here beyond logging.
  generateRecommendations(userId, deps).catch((err) => {
    logger.error(`[recommendation-engine] Async generation failed for user ${userId}: ${err.message}`);
  });

  return { started: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS ROUTE HANDLER (legacy)
// Register as: POST /api/student-onboarding/generate-recommendations
//
// NOTE: this route is legacy/orphaned — no current frontend code calls it
// (confirmed by repository search; see implementation report). It is kept
// only in case an untraced external caller depends on it, and is now
// routed through the same guarded initiateGeneration() used by the
// backend-owned trigger, so — even though it remains technically
// frontend-callable — it can no longer create a duplicate/racing
// generation. See src/routes/student-onboarding.routes.js for the
// corresponding route-level change.
// ─────────────────────────────────────────────────────────────────────────────

async function handleGenerateRecommendations(req, res) {
  try {
    const { userId } = req.body;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { started } = await initiateGeneration(userId);
    return res.status(202).json({ success: true, started });
  } catch (err) {
    console.error('[recommendation-engine] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARDED RETRY / REGENERATION — explicit, authenticated recovery entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically starts an explicit Recommendation retry (after `failed`) or
 * regeneration (after `ready`) for `userId` (Phase 1 lifecycle spec §5–§9).
 *
 * CONCURRENCY MODEL:
 *   A single conditional UPDATE is both the eligibility check and the state
 *   transition:
 *
 *     UPDATE student_recommendation_results
 *     SET status = 'pending', error_detail = NULL
 *     WHERE user_id = :userId AND status IN ('failed', 'ready')
 *
 *   This reuses the exact compare-and-swap idiom already established in
 *   this file's own persistFailure() (`.eq('status', 'pending')` guarding a
 *   status-only UPDATE) — no new database primitive is introduced. Postgres
 *   serializes concurrent UPDATEs to the same row via the row lock: the
 *   first writer's transition is visible to the second writer's WHERE
 *   evaluation, so at most one of any number of simultaneous retry requests
 *   ever matches and transitions the row. This is a single atomic
 *   statement, not a JS-level read-then-write, so it does not have the
 *   TOCTOU gap the spec warns against (§8).
 *
 *   Crucially, this UPDATE never touches `result_json` — the previous valid
 *   Recommendation (if any) remains completely undisturbed while the row is
 *   `pending` (Phase 1 lifecycle spec §6). It is only ever replaced once a
 *   NEW valid result is persisted by generateRecommendations()'s existing
 *   success-path upsert; a failed retry instead hits persistFailure(), which
 *   (as already covered by this file's existing test suite) only ever
 *   updates `status` and `error_detail` while guarded on `status = 'pending'`
 *   — so the prior valid `result_json` survives a failed retry too.
 *
 *   STALE-GENERATION SAFETY (§9): a new generation can only be launched from
 *   this function once the row's status is 'failed' or 'ready' — and both
 *   of those states are themselves only ever reached AFTER a previous
 *   generateRecommendations() invocation has already fully completed (its
 *   own success upsert or its own persistFailure() call is what produces
 *   'ready'/'failed' in the first place). There is therefore no state in
 *   which this function can launch a new generation while a previous one
 *   for the same user is still in flight (status would still be 'pending',
 *   which this UPDATE's WHERE clause excludes) — the overlapping-generation
 *   race described in §9 is structurally impossible under this model, not
 *   merely guarded against.
 *
 *   Initial generation (no row yet, or status = 'not_started') is out of
 *   scope here by design — that is initiateGeneration()'s responsibility.
 *   This function only ever transitions FROM 'failed' or 'ready'.
 *
 * NON-BLOCKING:
 *   Like initiateGeneration(), generateRecommendations() is launched
 *   fire-and-forget — this function resolves as soon as the conditional
 *   UPDATE completes, never blocking on AI provider latency.
 *
 * @param {string} userId
 * @param {Object} [deps] - forwarded to generateRecommendations; also used
 *   to inject supabaseClient for the atomic guard itself (tests only).
 * @returns {Promise<{ started: boolean, status: string|null }>}
 *   status is 'pending' when started, otherwise the row's current status
 *   ('pending' if a retry/generation is already in flight, or null if no
 *   result row exists yet / it is still 'not_started' — i.e. nothing to
 *   retry).
 */
async function initiateRetry(userId, deps = {}) {
  const { supabaseClient = supabase } = deps;

  const { data, error } = await supabaseClient
    .from(RESULTS_TABLE)
    .update({ status: 'pending', error_detail: null })
    .eq('user_id', userId)
    .in('status', ['failed', 'ready'])
    .select('user_id');

  if (error) {
    logger.error(`[recommendation-engine] Failed to initiate retry for user ${userId}: ${error.message}`);
    throw new Error(`Failed to initiate recommendation retry: ${error.message}`);
  }

  const started = Array.isArray(data) && data.length > 0;

  if (!started) {
    // The atomic guard above already decided the outcome; this read is
    // purely to report a friendlier reason (already in progress vs.
    // nothing to retry yet) and plays no part in the concurrency safety
    // property, which rests entirely on the single conditional UPDATE.
    let currentStatus = null;
    const { data: existing, error: readErr } = await supabaseClient
      .from(RESULTS_TABLE)
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();

    if (readErr) {
      logger.error(
        `[recommendation-engine] Failed to read current status for user ${userId} after a no-op retry: ${readErr.message}`,
      );
    } else {
      currentStatus = existing?.status ?? null;
    }

    logger.info(
      `[recommendation-engine] Retry not started for user ${userId} — current status: ${currentStatus ?? 'none'}.`,
    );
    return { started: false, status: currentStatus };
  }

  // Fire-and-forget — never block the caller on AI provider latency.
  // generateRecommendations() persists its own success/failure state, so
  // there is nothing further to do with the outcome here beyond logging.
  generateRecommendations(userId, deps).catch((err) => {
    logger.error(`[recommendation-engine] Async retry generation failed for user ${userId}: ${err.message}`);
  });

  return { started: true, status: 'pending' };
}

module.exports = {
  buildAssessmentPrompt,
  generateRecommendations,
  initiateGeneration,
  initiateRetry,
  handleGenerateRecommendations,
};
