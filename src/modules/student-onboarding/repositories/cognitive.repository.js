'use strict';

/**
 * src/modules/student-onboarding/repositories/cognitive.repository.js
 *
 * DATABASE ACCESS LAYER — Cognitive & Processing Intelligence (Phase 3C)
 *
 * PATTERN:
 *   Every function accepts a supabase service-role client and a userId.
 *   Zero business logic. Zero validation. Only Supabase queries.
 *
 * UPSERT STRATEGY:
 *   • student_cognitive_responses → upsert on (user_id, question_id)
 *   • student_cognitive_signals   → upsert on (user_id)
 *
 * READ STRATEGY:
 *   • cognitive_taxonomy, cognitive_questions, cognitive_options → public reads
 *   • student_* tables → always filtered by user_id
 */

// ─────────────────────────────────────────────────────────────────────────────
// TAXONOMY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the full active cognitive taxonomy with questions and options.
 * Returns: taxonomy rows → questions → options, all ordered for display.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Object[]>}
 */
async function fetchCognitiveTaxonomy(supabase) {
  const { data, error } = await supabase
    .from('cognitive_taxonomy')
    .select(`
      id,
      domain,
      display_name,
      description,
      display_order,
      cognitive_questions (
        id,
        question_key,
        question_text,
        hint_text,
        allows_multi,
        is_required,
        display_order,
        cognitive_options (
          id,
          option_key,
          option_text,
          signal_weights,
          display_order
        )
      )
    `)
    .eq('is_active', true)
    .eq('cognitive_questions.is_active', true)
    .eq('cognitive_questions.cognitive_options.is_active', true)
    .order('display_order', { ascending: true })
    .order('display_order', { referencedTable: 'cognitive_questions', ascending: true })
    .order('display_order', {
      referencedTable: 'cognitive_questions.cognitive_options',
      ascending: true,
    });

  if (error) throw error;
  return data ?? [];
}

/**
 * Fetches a single question by UUID, with its active options.
 * Used by the service for option ownership validation.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} questionId
 * @returns {Promise<Object|null>}
 */
async function fetchQuestionWithOptions(supabase, questionId) {
  const { data, error } = await supabase
    .from('cognitive_questions')
    .select(`
      id,
      question_key,
      allows_multi,
      is_required,
      cognitive_options (
        id,
        option_key,
        signal_weights
      )
    `)
    .eq('id', questionId)
    .eq('is_active', true)
    .eq('cognitive_options.is_active', true)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Fetches all active required questions by question_key list.
 * Used by commit to verify coverage.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ id: string, question_key: string }[]>}
 */
async function fetchRequiredQuestions(supabase) {
  const { data, error } = await supabase
    .from('cognitive_questions')
    .select('id, question_key')
    .eq('is_required', true)
    .eq('is_active', true);

  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// READ — STUDENT COGNITIVE DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all cognitive responses for a student.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Object[]>}
 */
async function fetchStudentCognitiveResponses(supabase, userId) {
  const { data, error } = await supabase
    .from('student_cognitive_responses')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Fetches the derived cognitive signal row for a student (if exists).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function fetchStudentCognitiveSignals(supabase, userId) {
  const { data, error } = await supabase
    .from('student_cognitive_signals')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Convenience: fetches responses + signals together.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ responses: Object[], signals: Object|null }>}
 */
async function fetchStudentCognitiveData(supabase, userId) {
  const [responsesResult, signalsResult] = await Promise.all([
    fetchStudentCognitiveResponses(supabase, userId),
    fetchStudentCognitiveSignals(supabase, userId),
  ]);

  return {
    responses: responsesResult,
    signals:   signalsResult,
  };
}

/**
 * Returns a count of how many required questions the student has answered.
 * Used to compute signal_quality.is_sufficient.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ total_responses: number, required_answered: number }>}
 */
async function fetchCognitiveSignalQuality(supabase, userId) {
  // Fetch all required question IDs
  const requiredQuestions = await fetchRequiredQuestions(supabase);
  const requiredIds = new Set(requiredQuestions.map((q) => q.id));

  // Fetch student responses
  const responses = await fetchStudentCognitiveResponses(supabase, userId);

  const answeredRequiredCount = responses.filter((r) =>
    requiredIds.has(r.question_id) && r.selected_option_keys.length > 0,
  ).length;

  return {
    total_responses:   responses.length,
    required_answered: answeredRequiredCount,
    required_total:    requiredIds.size,
    is_sufficient:     answeredRequiredCount >= requiredIds.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE — STUDENT COGNITIVE RESPONSES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts a single cognitive response (one question → one response row).
 * Upsert key: (user_id, question_id)
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   user_id:               string,
 *   question_id:           string,
 *   selected_option_keys:  string[],
 *   is_partial:            boolean,
 *   response_metadata?:    object
 * }} payload
 * @returns {Promise<Object>}
 */
async function upsertCognitiveResponse(supabase, payload) {
  const { data, error } = await supabase
    .from('student_cognitive_responses')
    .upsert(
      {
        user_id:              payload.user_id,
        question_id:          payload.question_id,
        selected_option_keys: payload.selected_option_keys,
        is_partial:           payload.is_partial,
        response_metadata:    payload.response_metadata ?? {},
      },
      {
        onConflict:          'user_id,question_id',
        ignoreDuplicates:    false,
      },
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Batch-upserts multiple cognitive responses in a single DB call.
 * Used when the frontend commits all responses together.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {{ question_id: string, selected_option_keys: string[], is_partial: boolean }[]} responses
 * @returns {Promise<Object[]>}
 */
async function batchUpsertCognitiveResponses(supabase, userId, responses) {
  const rows = responses.map((r) => ({
    user_id:              userId,
    question_id:          r.question_id,
    selected_option_keys: r.selected_option_keys,
    is_partial:           r.is_partial,
    response_metadata:    {},
  }));

  const { data, error } = await supabase
    .from('student_cognitive_responses')
    .upsert(rows, { onConflict: 'user_id,question_id', ignoreDuplicates: false })
    .select();

  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE — STUDENT COGNITIVE SIGNALS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts the derived cognitive signal row for a student.
 * Called by the signal extractor after processing responses.
 * Upsert key: (user_id)
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   user_id:         string,
 *   signal_tags:     string[],
 *   signal_weights:  object,
 *   domain_vectors:  object,
 *   response_count:  number,
 *   is_partial:      boolean,
 *   engine_version?: string,
 *   extracted_at?:   string,
 *   metadata?:       object
 * }} payload
 * @returns {Promise<Object>}
 */
async function upsertCognitiveSignals(supabase, payload) {
  const { data, error } = await supabase
    .from('student_cognitive_signals')
    .upsert(
      {
        user_id:        payload.user_id,
        signal_tags:    payload.signal_tags,
        signal_weights: payload.signal_weights,
        domain_vectors: payload.domain_vectors,
        response_count: payload.response_count,
        is_partial:     payload.is_partial,
        engine_version: payload.engine_version ?? null,
        extracted_at:   payload.extracted_at   ?? null,
        metadata:       payload.metadata        ?? {},
      },
      { onConflict: 'user_id', ignoreDuplicates: false },
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  fetchCognitiveTaxonomy,
  fetchQuestionWithOptions,
  fetchRequiredQuestions,
  fetchStudentCognitiveResponses,
  fetchStudentCognitiveSignals,
  fetchStudentCognitiveData,
  fetchCognitiveSignalQuality,
  upsertCognitiveResponse,
  batchUpsertCognitiveResponses,
  upsertCognitiveSignals,
};
