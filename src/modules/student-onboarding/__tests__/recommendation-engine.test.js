'use strict';

/**
 * modules/student-onboarding/__tests__/recommendation-engine.test.js
 *
 * Covers Phase 1 spec §16 acceptance criteria for the Recommendation
 * Engine:
 *   - receives assembled context rather than raw-table context;
 *   - successful structured output persists;
 *   - malformed JSON rejected / not persisted;
 *   - wrong types rejected / not persisted;
 *   - missing required fields rejected / not persisted;
 *   - invalid careerAreaKey rejected / not persisted;
 *   - valid nullable careerAreaKey accepted;
 *   - one row per user (upsert onConflict: user_id);
 *   - safe failure information only (no payload/prompt leakage).
 *
 * config/supabase.js is not imported for real here — generateRecommendations
 * accepts injectable deps (supabaseClient, anthropicClient, assembleContext,
 * fetchGovernedKeys), which this suite uses exclusively, so no real network
 * client is ever constructed.
 */

const { generateRecommendations, initiateGeneration, initiateRetry } = require('../services/recommendation-engine');

const USER_ID = 'user-123';

const GOVERNED_KEYS = [
  'technology', 'engineering', 'natural_sciences', 'business',
  'creative_industries', 'social_sciences', 'health_sciences', 'education',
];

const FAKE_CONTEXT = {
  userId: USER_ID,
  education: { education_level: 'class_12' },
  academics: { records: [{ academic_year: '2024' }], subjects: [{ subject: 'Math', performance_band: 'strong' }] },
  activities: { activities: [{ activity_key: 'coding' }], achievements: [{ title: 'Hackathon winner' }], reflection: null },
  achievements: [{ title: 'Hackathon winner' }],
  cognitive: { responses: [], signals: { analytical_score: 80 } },
  aspiration: { career_interests: ['engineer'], motivation_driver: 'impact', time_horizon: '5_years' },
  intelligence: { vector: { technical_aptitude: 0.8 }, confidence: [] },
  readiness: {
    education: true, academics: true, activities: true,
    cognitive: true, aspiration: true, intelligenceAvailable: true,
  },
  contextVersion: 'student-recommendation-context-v2',
};

function buildValidAiOutput(overrides = {}) {
  return {
    strengthSummary: {
      traits: ['analytical thinker'],
      academicInsights: ['strong in math'],
      exposureHighlights: ['won a hackathon'],
    },
    streamScores: [
      { stream: 'science', score: 80, label: 'Strong fit', rationale: 'strong STEM signals' },
      { stream: 'commerce', score: 40, label: 'Moderate fit', rationale: 'some business interest' },
      { stream: 'humanities', score: 20, label: 'Lower fit', rationale: 'limited humanities signal' },
    ],
    recommendedDomains: [
      {
        id: 'ai-engineering',
        title: 'AI Engineering & Data Science',
        description: 'Builds intelligent systems.',
        whyItFitsYou: 'Your strong math and coding activities point here.',
        futureScore: 90,
        aiRiskScore: 20,
        humanEdgeScore: 60,
        employabilityScore: 85,
        roiPotential: 'high',
        globalOpportunity: 'global',
        exampleRoles: ['ML Engineer'],
        entryPaths: ['B.Tech CSE'],
        aiEraGuidance: 'This field is evolving rapidly and requires continuous upskilling.',
      },
    ],
    careerAreaKey: 'technology',
    futureCareerNote: 'The future favors adaptable, AI-collaborative skillsets.',
    ...overrides,
  };
}

function buildFakeAnthropicClient(outputObjectOrRawText) {
  const text = typeof outputObjectOrRawText === 'string'
    ? outputObjectOrRawText
    : JSON.stringify(outputObjectOrRawText);

  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
      }),
    },
  };
}

/**
 * Fake Supabase client supporting every chain this engine uses:
 *   .from('student_recommendation_results').upsert(...)                          — ready-path persist / initiateGeneration's pending insert
 *   .from('student_recommendation_results').update(...).eq(...).eq(...)          — persistFailure
 *   .from('student_recommendation_results').update(...).eq(...).in(...).select() — initiateRetry's atomic guard
 *   .from('student_recommendation_results').select(...).eq(...).maybeSingle()    — initiateRetry's no-op status read
 *   .from('student_onboarding_sessions').update(...).eq(...)                     — session advance to 'result'
 */
function buildFakeSupabase({
  upsertError = null,
  sessionError = null,
  resultsUpdateError = null,
  // Controls initiateGeneration's duplicate-guard upsert: what .select()
  // resolves to. Defaults to "row was inserted" (started: true).
  pendingUpsertSelectData = [{ user_id: USER_ID }],
  pendingUpsertError = null,
  // Controls initiateRetry's atomic conditional-UPDATE: what the trailing
  // .select() resolves to. Defaults to "row was eligible and transitioned"
  // (started: true).
  retryUpdateSelectData = [{ user_id: USER_ID }],
  retryUpdateError = null,
  // Controls initiateRetry's fallback status read, used only when the
  // conditional UPDATE above matched no row.
  existingStatusData = null,
  existingStatusError = null,
} = {}) {
  // .upsert(...) — ready-path persist (awaited directly, no .select()).
  // .upsert(...).select(...) — initiateGeneration's duplicate-guarded pending insert.
  const pendingSelect = jest.fn().mockResolvedValue({ data: pendingUpsertSelectData, error: pendingUpsertError });
  const upsert = jest.fn((..._args) => {
    const thenable = Promise.resolve({ error: upsertError });
    thenable.select = pendingSelect;
    return thenable;
  });

  // .update(...).eq('user_id', ...).eq('status', 'pending')              — persistFailure
  // .update(...).eq('user_id', ...).in('status', [...]).select('user_id') — initiateRetry
  const retrySelect = jest.fn().mockResolvedValue({ data: retryUpdateSelectData, error: retryUpdateError });
  const retryIn = jest.fn().mockReturnValue({ select: retrySelect });
  const resultsEq2 = jest.fn().mockResolvedValue({ error: resultsUpdateError });
  const resultsEq1 = jest.fn().mockReturnValue({ eq: resultsEq2, in: retryIn });
  const resultsUpdate = jest.fn().mockReturnValue({ eq: resultsEq1 });

  // .select('status').eq('user_id', ...).maybeSingle() — initiateRetry's
  // fallback read (only reached when the conditional UPDATE above no-ops).
  const maybeSingle = jest.fn().mockResolvedValue({ data: existingStatusData, error: existingStatusError });
  const selectEq = jest.fn().mockReturnValue({ maybeSingle });
  const resultsSelect = jest.fn().mockReturnValue({ eq: selectEq });

  const sessionEq = jest.fn().mockResolvedValue({ error: sessionError });
  const sessionUpdate = jest.fn().mockReturnValue({ eq: sessionEq });

  const from = jest.fn((table) => {
    if (table === 'student_recommendation_results') {
      return { upsert, update: resultsUpdate, select: resultsSelect };
    }
    if (table === 'student_onboarding_sessions') return { update: sessionUpdate };
    throw new Error(`Unexpected table in test: ${table}`);
  });

  return {
    from, upsert, pendingSelect,
    resultsUpdate, resultsEq1, resultsEq2,
    retryIn, retrySelect,
    resultsSelect, selectEq, maybeSingle,
    sessionUpdate, sessionEq,
  };
}

describe('recommendation-engine', () => {
  describe('generateRecommendations', () => {
    it('receives the assembled context rather than querying raw tables itself', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());
      const supabaseClient = buildFakeSupabase();

      await generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(assembleContext).toHaveBeenCalledWith(USER_ID, supabaseClient);
      // The only tables this engine itself queries are the two persistence
      // targets — never any of the five canonical/legacy source tables.
      expect(supabaseClient.from).toHaveBeenCalledWith('student_recommendation_results');
      expect(supabaseClient.from).toHaveBeenCalledWith('student_onboarding_sessions');
      expect(supabaseClient.from).not.toHaveBeenCalledWith('student_academics_profiles');
      expect(supabaseClient.from).not.toHaveBeenCalledWith('student_financial_profiles');
    });

    it('persists a successful, structurally valid output with context_version and career_area_key', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());
      const supabaseClient = buildFakeSupabase();

      await generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(supabaseClient.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: USER_ID,
          career_area_key: 'technology',
          context_version: 'student-recommendation-context-v2',
          status: 'ready',
        }),
        { onConflict: 'user_id' },
      );
    });

    it('one row per user: upsert always targets onConflict: user_id (overwrite on regeneration)', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());
      const supabaseClient = buildFakeSupabase();

      await generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });
      await generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(supabaseClient.upsert).toHaveBeenCalledTimes(2);
      supabaseClient.upsert.mock.calls.forEach(([, options]) => {
        expect(options).toEqual({ onConflict: 'user_id' });
      });
    });

    it('rejects malformed JSON, does not persist a ready result, and writes status: failed with a safe error_detail', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient('{not valid json');
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(/Recommendation output rejected/);

      expect(supabaseClient.upsert).not.toHaveBeenCalled();
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', error_detail: expect.stringMatching(/Recommendation output rejected/) }),
      );
      // Failure writes only ever flip pending → failed.
      expect(supabaseClient.resultsEq1).toHaveBeenCalledWith('user_id', USER_ID);
      expect(supabaseClient.resultsEq2).toHaveBeenCalledWith('status', 'pending');
    });

    it('rejects wrong field types, does not persist a ready result, and writes status: failed', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const badOutput = buildValidAiOutput();
      badOutput.recommendedDomains[0].futureScore = 'ninety';
      const anthropicClient = buildFakeAnthropicClient(badOutput);
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(/Recommendation output rejected/);

      expect(supabaseClient.upsert).not.toHaveBeenCalled();
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('rejects output missing required fields, does not persist a ready result, and writes status: failed', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const badOutput = buildValidAiOutput();
      delete badOutput.streamScores;
      const anthropicClient = buildFakeAnthropicClient(badOutput);
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(/Recommendation output rejected/);

      expect(supabaseClient.upsert).not.toHaveBeenCalled();
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('rejects an invalid (non-governed) careerAreaKey, does not persist a ready result, and writes status: failed', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput({ careerAreaKey: 'made-up-value' }));
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(/Recommendation output rejected/);

      expect(supabaseClient.upsert).not.toHaveBeenCalled();
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('a failure write never clobbers an existing ready row (status-guarded update only)', async () => {
      // The failure-write chain guards on .eq('status', 'pending') — this
      // asserts that guard is present on every failure path, so a failed
      // regeneration attempt (future pass) can never downgrade a prior
      // valid 'ready' result out from under a student.
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient('{not valid json');
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow();

      expect(supabaseClient.resultsEq2).toHaveBeenCalledWith('status', 'pending');
    });

    it('accepts a valid nullable careerAreaKey and persists null', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput({ careerAreaKey: null }));
      const supabaseClient = buildFakeSupabase();

      await generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(supabaseClient.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ career_area_key: null }),
        { onConflict: 'user_id' },
      );
    });

    it('fails closed on a non-null careerAreaKey when the governed list cannot be loaded', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockRejectedValue(new Error('db unavailable'));
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput({ careerAreaKey: 'technology' }));
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(/Recommendation output rejected/);

      expect(supabaseClient.upsert).not.toHaveBeenCalled();
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('never leaks the raw AI payload/prompt into the thrown error message or the persisted error_detail', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const badOutput = buildValidAiOutput();
      badOutput.futureCareerNote = 'SECRET_MARKER_VALUE_998877';
      badOutput.recommendedDomains[0].futureScore = 'not-a-number'; // trigger rejection
      const anthropicClient = buildFakeAnthropicClient(badOutput);
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(expect.not.stringContaining('SECRET_MARKER_VALUE_998877'));

      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ error_detail: expect.not.stringContaining('SECRET_MARKER_VALUE_998877') }),
      );
    });

    it('never surfaces a raw provider error message into the persisted error_detail (only its safe status code)', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const providerErr = new Error('Authorization header: Bearer sk-ant-SECRET_KEY_998877 rejected');
      providerErr.status = 401;
      const anthropicClient = { messages: { create: jest.fn().mockRejectedValue(providerErr) } };
      const supabaseClient = buildFakeSupabase();

      await expect(
        generateRecommendations(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow();

      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_detail: 'Recommendation provider request failed (status 401).',
        }),
      );
    });
  });

  describe('initiateGeneration', () => {
    it('starts generation exactly once when no result row exists yet for this user', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());
      const supabaseClient = buildFakeSupabase({ pendingUpsertSelectData: [{ user_id: USER_ID }] });

      const result = await initiateGeneration(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: true });
      expect(supabaseClient.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, status: 'pending' }),
        { onConflict: 'user_id', ignoreDuplicates: true },
      );
    });

    it('does not start a duplicate generation when a result row already exists (any status)', async () => {
      const assembleContext = jest.fn();
      const fetchGovernedKeys = jest.fn();
      const anthropicClient = { messages: { create: jest.fn() } };
      // Empty select() result simulates ignoreDuplicates skipping the insert
      // because a row already exists for this user.
      const supabaseClient = buildFakeSupabase({ pendingUpsertSelectData: [] });

      const result = await initiateGeneration(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: false });
      // The actual generation work (context assembly, AI call) must never
      // run on a duplicate/repeated trigger.
      expect(assembleContext).not.toHaveBeenCalled();
      expect(anthropicClient.messages.create).not.toHaveBeenCalled();
    });

    it('never blocks the caller on AI provider latency (fire-and-forget)', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      let resolveAiCall;
      const aiCallPromise = new Promise((resolve) => { resolveAiCall = resolve; });
      const anthropicClient = { messages: { create: jest.fn().mockReturnValue(aiCallPromise) } };
      const supabaseClient = buildFakeSupabase();

      const result = await initiateGeneration(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      // initiateGeneration already resolved — proves it never awaits the
      // AI call itself. Give the fire-and-forget chain a tick to actually
      // reach the (still-unresolved) provider call before asserting.
      expect(result).toEqual({ started: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(anthropicClient.messages.create).toHaveBeenCalled();

      // Clean up the still-pending internal call so it doesn't leak into
      // another test as an unhandled rejection.
      resolveAiCall({ content: [{ type: 'text', text: JSON.stringify(buildValidAiOutput()) }] });
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('initiateRetry', () => {
    it('Test A — starts a retry when the current row is failed (failed → pending), exactly one generation launch', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());
      const supabaseClient = buildFakeSupabase({ retryUpdateSelectData: [{ user_id: USER_ID }] });

      const result = await initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: true, status: 'pending' });
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith({ status: 'pending', error_detail: null });
      expect(supabaseClient.resultsEq1).toHaveBeenCalledWith('user_id', USER_ID);
      expect(supabaseClient.retryIn).toHaveBeenCalledWith('status', ['failed', 'ready']);

      // Give the fire-and-forget generation a tick to actually start.
      await new Promise((resolve) => setImmediate(resolve));
      expect(anthropicClient.messages.create).toHaveBeenCalledTimes(1);
    });

    it('Test D — starts regeneration when the current row is ready (ready → pending) without deleting the previous result_json', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());
      const supabaseClient = buildFakeSupabase({ retryUpdateSelectData: [{ user_id: USER_ID }] });

      const result = await initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: true, status: 'pending' });
      // The atomic guard's UPDATE payload only ever contains status/error_detail
      // — result_json is never referenced by initiateRetry at all, so the
      // previous valid result_json is left completely untouched while pending.
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.not.objectContaining({ result_json: expect.anything() }),
      );
    });

    it('Test B — does not start a second generation when the current row is already pending', async () => {
      const assembleContext = jest.fn();
      const fetchGovernedKeys = jest.fn();
      const anthropicClient = { messages: { create: jest.fn() } };
      // Empty select() result simulates the conditional UPDATE matching no
      // row, because status is already 'pending' (not in ('failed','ready')).
      const supabaseClient = buildFakeSupabase({
        retryUpdateSelectData: [],
        existingStatusData: { status: 'pending' },
      });

      const result = await initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: false, status: 'pending' });
      expect(assembleContext).not.toHaveBeenCalled();
      expect(anthropicClient.messages.create).not.toHaveBeenCalled();
    });

    it('Test C — concurrent retry protection: two attempts against the same failed row result in only one generation launch', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient(buildValidAiOutput());

      // Simulates Postgres's row-level-lock serialization of two concurrent
      // conditional UPDATEs against the same row: the first call's UPDATE
      // matches (row transitions failed → pending); by the time the second
      // call's UPDATE is evaluated the row is already 'pending', so it
      // matches nothing. This is exactly the guarantee a real conditional
      // UPDATE ... WHERE status IN (...) provides — the two invocations of
      // .select() below model its two sequential outcomes.
      const retrySelect = jest.fn()
        .mockResolvedValueOnce({ data: [{ user_id: USER_ID }], error: null })
        .mockResolvedValueOnce({ data: [], error: null });
      const retryIn = jest.fn().mockReturnValue({ select: retrySelect });
      const resultsEq2 = jest.fn().mockResolvedValue({ error: null });
      const resultsEq1 = jest.fn().mockReturnValue({ eq: resultsEq2, in: retryIn });
      const resultsUpdate = jest.fn().mockReturnValue({ eq: resultsEq1 });
      const maybeSingle = jest.fn().mockResolvedValue({ data: { status: 'pending' }, error: null });
      const selectEq = jest.fn().mockReturnValue({ maybeSingle });
      const resultsSelect = jest.fn().mockReturnValue({ eq: selectEq });
      const sessionEq = jest.fn().mockResolvedValue({ error: null });
      const sessionUpdate = jest.fn().mockReturnValue({ eq: sessionEq });
      const upsert = jest.fn((..._args) => {
        const thenable = Promise.resolve({ error: null });
        thenable.select = jest.fn().mockResolvedValue({ data: [{ user_id: USER_ID }], error: null });
        return thenable;
      });
      const from = jest.fn((table) => {
        if (table === 'student_recommendation_results') return { upsert, update: resultsUpdate, select: resultsSelect };
        if (table === 'student_onboarding_sessions') return { update: sessionUpdate };
        throw new Error(`Unexpected table in test: ${table}`);
      });
      const supabaseClient = { from };

      const deps = { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys };
      const [first, second] = await Promise.all([
        initiateRetry(USER_ID, deps),
        initiateRetry(USER_ID, deps),
      ]);

      const outcomes = [first, second];
      expect(outcomes).toContainEqual({ started: true, status: 'pending' });
      expect(outcomes).toContainEqual({ started: false, status: 'pending' });

      // Give the one fire-and-forget generation a tick to actually launch,
      // then assert exactly one generation ran.
      await new Promise((resolve) => setImmediate(resolve));
      expect(anthropicClient.messages.create).toHaveBeenCalledTimes(1);
    });

    it('Test I / not-eligible — does not start a retry, and reports no status, when no result row exists (not_started)', async () => {
      const assembleContext = jest.fn();
      const fetchGovernedKeys = jest.fn();
      const anthropicClient = { messages: { create: jest.fn() } };
      const supabaseClient = buildFakeSupabase({
        retryUpdateSelectData: [],
        existingStatusData: null,
      });

      const result = await initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: false, status: null });
      expect(assembleContext).not.toHaveBeenCalled();
      expect(anthropicClient.messages.create).not.toHaveBeenCalled();
    });

    it('never blocks the caller on AI provider latency (fire-and-forget), matching initiateGeneration', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      let resolveAiCall;
      const aiCallPromise = new Promise((resolve) => { resolveAiCall = resolve; });
      const anthropicClient = { messages: { create: jest.fn().mockReturnValue(aiCallPromise) } };
      const supabaseClient = buildFakeSupabase({ retryUpdateSelectData: [{ user_id: USER_ID }] });

      const result = await initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      expect(result).toEqual({ started: true, status: 'pending' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(anthropicClient.messages.create).toHaveBeenCalled();

      resolveAiCall({ content: [{ type: 'text', text: JSON.stringify(buildValidAiOutput()) }] });
      await new Promise((resolve) => setImmediate(resolve));
    });

    it('Test G — a retry generation failure results in pending → failed with a safe error_detail, guarded on status = pending', async () => {
      const assembleContext = jest.fn().mockResolvedValue(FAKE_CONTEXT);
      const fetchGovernedKeys = jest.fn().mockResolvedValue(GOVERNED_KEYS);
      const anthropicClient = buildFakeAnthropicClient('{not valid json');
      const supabaseClient = buildFakeSupabase({ retryUpdateSelectData: [{ user_id: USER_ID }] });

      await initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys });

      // The retry-generation failure runs through the exact same
      // generateRecommendations()/persistFailure() path as any other
      // generation, guarded on status = 'pending' — never touching
      // result_json, so a previous valid result survives a failed retry.
      await new Promise((resolve) => setImmediate(resolve));
      expect(supabaseClient.resultsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', error_detail: expect.stringMatching(/Recommendation output rejected/) }),
      );
      expect(supabaseClient.resultsEq2).toHaveBeenCalledWith('status', 'pending');
    });

    it('propagates a database error from the conditional UPDATE itself, without starting generation', async () => {
      const assembleContext = jest.fn();
      const fetchGovernedKeys = jest.fn();
      const anthropicClient = { messages: { create: jest.fn() } };
      const supabaseClient = buildFakeSupabase({ retryUpdateError: { message: 'connection reset' } });

      await expect(
        initiateRetry(USER_ID, { supabaseClient, anthropicClient, assembleContext, fetchGovernedKeys }),
      ).rejects.toThrow(/Failed to initiate recommendation retry/);

      expect(anthropicClient.messages.create).not.toHaveBeenCalled();
    });
  });
});
