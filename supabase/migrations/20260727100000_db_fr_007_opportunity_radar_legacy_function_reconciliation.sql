-- =============================================================================
-- DB-FR-007 — Opportunity Radar Legacy Function Reconciliation
-- =============================================================================
--
-- Scope: public.get_opportunity_radar_ai() and public.match_skills() only.
--
-- Certified architecture (DB-FR-006A/006B v1.1) is frozen and NOT touched by
-- this migration. public.get_opportunity_radar() is not modified, redefined,
-- or replayed here.
--
-- Full engineering analysis, evidence, and rationale:
--   documents/DB-FR-007_Opportunity_Radar_Legacy_Function_Reconciliation.md
--
-- Summary of findings (see report for full evidence):
--   • get_opportunity_radar_ai(): ORPHANED (zero callers anywhere in the
--     repository). Broken by two independent schema-drift defects
--     (skill_embeddings.skill does not exist — column has always been
--     skill_name; and required_skills has always been TEXT[], never JSONB,
--     so the jsonb_array_elements_text()/jsonb_array_length() calls are
--     invalid regardless of the column-name fix). Repairing it fully would
--     additionally require inventing a certified skill_embeddings ↔
--     career_opportunity_signals join — the same vector-boost capability
--     DB-FR-006B v1.1 explicitly deferred to a future, separate work
--     package. That is new architecture, out of scope here.
--   • match_skills(): schema drift PLUS a real architectural incompatibility
--     (user_vectors.user_id is text, function takes uuid; the real column is
--     embedding_vector vector(1536), not embedding; skill_embeddings has no
--     skill_id column and has no certified key relationship to skills.id;
--     and comparing a 1536-dim user vector against 384-dim skill embeddings
--     is not a valid pgvector operation — <-> requires matching dimensions).
--     Its one repository reference (core/src/services/radar.service.js) is
--     itself dead code — never required/imported by server.js or any route
--     — so it currently has zero reachable callers in production, though it
--     is not deleted in case that service is wired up later.
--
-- Decision for both functions: Category C — replace body with a
-- compatibility-preserving stub. Same name, same signature, same return
-- shape, so any existing/future caller (including a `.rpc()` call reaching
-- radar.service.js, if it is ever wired in) gets an immediate, explicit,
-- catchable "deprecated" exception instead of an opaque
-- "column does not exist" schema error. This resolves the lint failures
-- without dropping either function (destructive/irreversible, and not
-- authorized by this work package) and without introducing any new scoring
-- logic, vector join, or architecture.
--
-- Replay-safety: CREATE OR REPLACE FUNCTION and COMMENT ON are both
-- idempotent; this migration can be re-run safely.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. public.get_opportunity_radar_ai — compatibility stub
-- -----------------------------------------------------------------------------
-- Signature preserved exactly: (user_skills text[], top_n integer DEFAULT 10)
-- RETURNS TABLE(role text, match_score integer, opportunity_score integer,
--               final_score numeric, skills_to_learn text[])

CREATE OR REPLACE FUNCTION "public"."get_opportunity_radar_ai"(
    "user_skills" "text"[],
    "top_n" integer DEFAULT 10
) RETURNS TABLE("role" "text", "match_score" integer, "opportunity_score" integer, "final_score" numeric, "skills_to_learn" "text"[])
    LANGUAGE "plpgsql"
    AS $$
begin
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

ALTER FUNCTION "public"."get_opportunity_radar_ai"("user_skills" "text"[], "top_n" integer) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_opportunity_radar_ai"("text"[], integer) IS
'DB-FR-007: DEPRECATED, non-functional stub. Confirmed zero callers repository-wide '
'(no .rpc() call, no service/controller/route/worker reference). Original body referenced '
'skill_embeddings.skill (column has always been skill_name) and treated '
'career_opportunity_signals.required_skills as jsonb (it has always been text[]) — both were '
'defects present since 000_initial_schema.sql, not later drift. Full repair would require a new, '
'uncertified skill_embeddings <-> career_opportunity_signals join, which is out of scope. '
'Superseded by public.get_opportunity_radar() (DB-FR-006A/006B, certified, frozen). '
'Recommended for removal in a future, separate work package once a deprecation window has elapsed.';

-- -----------------------------------------------------------------------------
-- 2. public.match_skills — compatibility stub
-- -----------------------------------------------------------------------------
-- Signature preserved exactly: (input_user_id uuid)
-- RETURNS TABLE(skill_id uuid, skill_name text, similarity double precision)

CREATE OR REPLACE FUNCTION "public"."match_skills"("input_user_id" "uuid")
RETURNS TABLE("skill_id" "uuid", "skill_name" "text", "similarity" double precision)
    LANGUAGE "plpgsql"
    AS $$
begin
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

ALTER FUNCTION "public"."match_skills"("input_user_id" "uuid") OWNER TO "postgres";

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
'Superseded by public.match_skills_semantic(text[], integer, double precision), which is active, '
'schema-correct, and in production use by semanticSkill.engine.js. '
'Recommended for removal, together with the dead radar.service.js caller, in a future, separate '
'work package once confirmed no external/third-party integration relies on the "match_skills" RPC name.';

COMMIT;
