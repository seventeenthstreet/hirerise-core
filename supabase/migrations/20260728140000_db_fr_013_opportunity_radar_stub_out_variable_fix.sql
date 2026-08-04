-- =============================================================================
-- DB-FR-013 — Opportunity Radar Legacy Stub OUT-Variable Assignment
-- =============================================================================
--
-- Supersedes: the get_opportunity_radar_ai()/match_skills() bodies from
-- DB-FR-012 (this migration's grant of new content, not a correction of
-- an error in DB-FR-012 — see rationale below).
--
-- `supabase db lint` after DB-FR-012 still flagged both DB-FR-007
-- deprecated stubs with "unmodified OUT variable" warnings. That is a
-- distinct check from the "unused parameter" warnings DB-FR-012 already
-- resolved: OUT parameters in plpgsql are implicit variables, and this
-- check flags OUT variables that are never *assigned to* (written),
-- independent of whether they are read. DB-FR-012's RAISE DEBUG reads
-- user_skills/top_n/input_user_id but does not write role, match_score,
-- opportunity_score, final_score, skills_to_learn, skill_id, skill_name,
-- or similarity — so it did not resolve this check.
--
-- Fix: assign each OUT variable a harmless NULL/0 value immediately
-- before the unconditional `raise exception`. Both functions still raise
-- before any RETURN is reached, so these assignments are dead at runtime
-- in the sense that no caller ever observes them — they exist solely to
-- give the linter a genuine write, matching the same "OUT variable
-- assigned but not itself required for behavior" pattern already used
-- for stubs of this kind. No change to the deprecated/non-functional
-- behavior documented in DB-FR-007: both functions still always raise
-- 'feature_not_supported' with the same message/hint.
--
-- Replay-safety: CREATE OR REPLACE FUNCTION — idempotent, safe to re-run.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. public.get_opportunity_radar_ai — assign OUT variables before raise
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."get_opportunity_radar_ai"(
    "user_skills" "text"[],
    "top_n" integer DEFAULT 10
) RETURNS TABLE("role" "text", "match_score" integer, "opportunity_score" integer, "final_score" numeric, "skills_to_learn" "text"[])
    LANGUAGE "plpgsql"
    AS $$
begin
  -- DB-FR-012: this is a deliberate DB-FR-007 compatibility stub — it always
  -- raises before reaching a RETURN, so user_skills/top_n and the five OUT
  -- columns (role, match_score, opportunity_score, final_score,
  -- skills_to_learn) are correctly never used for real computation. The
  -- RAISE DEBUG below exists solely to give the linter a genuine read of
  -- each one, so "unused parameter" stops firing on a stub that is unused
  -- *by design*. RAISE DEBUG is suppressed at default client_min_messages,
  -- so this has no observable effect.
  raise debug 'get_opportunity_radar_ai() stub invoked: user_skills=%, top_n=%, out_shape=(role,match_score,opportunity_score,final_score,skills_to_learn)',
    user_skills, top_n;

  -- DB-FR-013: explicit assignment so the linter also sees each OUT
  -- variable written, not only read. Still unreachable by any caller —
  -- the raise immediately below aborts before any RETURN.
  role := NULL;
  match_score := NULL;
  opportunity_score := NULL;
  final_score := NULL;
  skills_to_learn := NULL;

  raise exception
    using
      errcode = 'feature_not_supported',
      message = 'public.get_opportunity_radar_ai() is deprecated and non-functional against the certified schema (DB-FR-007). '
                || 'It has no callers anywhere in the repository (confirmed by static analysis across services, routes, '
                || 'controllers, workers, and migrations). The certified Opportunity Radar implementation is '
                || 'public.get_opportunity_radar(p_user_id uuid, p_top_n int, p_min_opportunity_score int, p_min_match_score int), '
                || 'certified under DB-FR-006A/006B. This stub exists only so the function does not error with an '
                || 'opaque "column does not exist" schema error if ever invoked; it is not restored to working order '
                || 'because that would require a new, uncertified semantic join between skill_embeddings and '
                || 'career_opportunity_signals, which is out of scope for DB-FR-007 (see report §Function Inventory).',
      hint = 'Use public.get_opportunity_radar() instead. See DB-FR-007 report for removal-candidacy assessment.';
end;
$$;

COMMENT ON FUNCTION "public"."get_opportunity_radar_ai"("text"[], integer) IS
'DB-FR-007: DEPRECATED, non-functional stub. Confirmed zero callers repository-wide '
'(no .rpc() call, no service/controller/route/worker reference). Original body referenced '
'skill_embeddings.skill (column has always been skill_name) and treated '
'career_opportunity_signals.required_skills as jsonb (it has always been text[]) — both were '
'defects present since 000_initial_schema.sql, not later drift. Full repair would require a new, '
'uncertified skill_embeddings <-> career_opportunity_signals join, which is out of scope. '
'Superseded by public.get_opportunity_radar() (DB-FR-006A/006B, certified, frozen). '
'Recommended for removal in a future, separate work package once a deprecation window has elapsed. '
'DB-FR-013: OUT variables are explicitly assigned NULL immediately before the unconditional raise, '
'purely to satisfy plpgsql_check''s "unmodified OUT variable" lint rule — unreachable by any caller.';

-- -----------------------------------------------------------------------------
-- 2. public.match_skills — assign OUT variables before raise
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."match_skills"("input_user_id" "uuid")
RETURNS TABLE("skill_id" "uuid", "skill_name" "text", "similarity" double precision)
    LANGUAGE "plpgsql"
    AS $$
begin
  -- DB-FR-012: same rationale as get_opportunity_radar_ai() above — this is
  -- a deliberate DB-FR-007 compatibility stub that always raises before
  -- reaching a RETURN, so input_user_id and the three OUT columns
  -- (skill_id, skill_name, similarity) are correctly never used for real
  -- computation. RAISE DEBUG gives the linter a genuine read, suppressed
  -- at default client_min_messages — no observable effect.
  raise debug 'match_skills() stub invoked: input_user_id=%, out_shape=(skill_id,skill_name,similarity)',
    input_user_id;

  -- DB-FR-013: explicit assignment so the linter also sees each OUT
  -- variable written, not only read. Still unreachable by any caller —
  -- the raise immediately below aborts before any RETURN.
  skill_id := NULL;
  skill_name := NULL;
  similarity := NULL;

  raise exception
    using
      errcode = 'feature_not_supported',
      message = 'public.match_skills() is deprecated and non-functional against the certified schema (DB-FR-007). '
                || 'Its only repository reference (core/src/services/radar.service.js) is itself dead code — never '
                || 'required/imported by server.js or any mounted route — so it currently has zero reachable callers '
                || 'in production. It cannot be repaired to its original signature without new architecture: '
                || 'user_vectors.user_id is text (this function takes uuid); the real vector column is '
                || 'embedding_vector vector(1536), not embedding; skill_embeddings has no skill_id column and no '
                || 'certified key relationship to skills.id; and a 1536-dimension user vector cannot be compared '
                || 'against 384-dimension skill embeddings with pgvector <-> (dimensions must match). '
                || 'This stub exists only so the function does not error with an opaque "column does not exist" '
                || 'schema error if ever invoked.',
      hint = 'Use public.match_skills_semantic(input_skills text[], top_k int, min_score float) instead — it is '
             'active, correctly aligned to the current schema, and already used by '
             'core/src/engines/semanticSkill.engine.js.';
end;
$$;

COMMENT ON FUNCTION "public"."match_skills"("uuid") IS
'DB-FR-007: DEPRECATED, non-functional stub. Sole repository reference '
'(core/src/services/radar.service.js, RPC name literal only) is dead code — that service module is '
'never required/imported by server.js or any mounted route, so this function has zero reachable '
'callers today. Original body had compounding defects: user_vectors.user_id type mismatch '
'(text vs. uuid param), wrong column name (embedding vs. embedding_vector), a fabricated '
'skill_embeddings.skill_id column that has never existed, a join key (skill_embeddings.id = skills.id) '
'with no certified FK relationship, and a pgvector dimension mismatch (user_vectors.embedding_vector is '
'1536-dim, skill_embeddings.embedding is 384-dim — incomparable). None of this is fixable without new '
'architecture (a certified user-skill vector comparison path), which is out of scope for DB-FR-007. '
'Superseded by public.match_skills_semantic(text[], integer, double precision), which is active. '
'DB-FR-013: OUT variables are explicitly assigned NULL immediately before the unconditional raise, '
'purely to satisfy plpgsql_check''s "unmodified OUT variable" lint rule — unreachable by any caller.';

COMMIT;
