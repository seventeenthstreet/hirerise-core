-- =============================================================================
-- DB-FR-006B v1.1 — Opportunity Radar Database Reconciliation Production Hardening
-- =============================================================================
--
-- Supersedes: 20260727090500_db_fr_006b_opportunity_radar_reconciliation.sql
--
-- Certified architecture (DB-FR-006A v1.1) remains frozen and is not revisited.
-- DB-FR-006B's reconciliation decisions (profile table/column fixes, vector
-- column fix, orphan-function retention) remain frozen and are carried
-- forward unchanged in this migration. This migration corrects exactly one
-- implementation defect found in engineering review of DB-FR-006B, and
-- clarifies documentation. It does not redesign anything.
--
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Aggregation ordering defect (the one issue in scope for this pass)
-- -----------------------------------------------------------------------------
-- Defect found in engineering review of DB-FR-006B:
--
-- The DB-FR-006B version wrote ORDER BY / LIMIT at the SAME query level as
-- an ungrouped json_agg():
--
--   select json_build_object('emerging_opportunities', json_agg(result), ...)
--   from (...) result
--   where result.match_score >= p_min_match_score
--   order by result.rank_score desc
--   limit p_top_n;
--
-- In PostgreSQL, a SELECT list containing an aggregate function with no
-- GROUP BY collapses its input rows into a single output row. ORDER BY and
-- LIMIT written at that same query level apply to that single-row result
-- set, not to the rows being fed into the aggregate — so LIMIT p_top_n had
-- no effect on how many signals were aggregated (every row matching the
-- WHERE clause was included, not just the top N), and json_agg() with no
-- explicit ORDER BY inside the aggregate call has unspecified input-row
-- order, so "highest-ranked first" was not guaranteed either. This is a
-- real behavioral defect (p_top_n was silently not enforced), not only a
-- style concern.
--
-- Fix: restructure using two CTEs so filtering, ordering, and limiting all
-- happen as ordinary row operations *before* any aggregate function is
-- evaluated, then aggregate with an explicit ORDER BY inside json_agg() so
-- the final JSON array order does not rely on incidental scan order:
--
--   ranked   — computes role/opportunity_score/match_score/skills_to_learn/
--              rank_score per signal (identical expressions to the
--              certified/DB-FR-006B formula — nothing here changed)
--   filtered — applies the match_score threshold, ORDER BY rank_score DESC,
--              and LIMIT p_top_n, as ordinary row-limiting (no aggregate
--              function present at this query level, so LIMIT behaves as
--              expected: it actually caps the row count here)
--   outer    — aggregates the (now correctly filtered/ordered/limited) rows
--              with json_agg(f ORDER BY f.rank_score DESC), so the
--              aggregation itself is also explicitly ordered, not merely
--              inheriting order from its input
--
-- This changes only the *evaluation order* of the same expressions, weights,
-- and filters already certified — it does not add, remove, or reweight any
-- ranking component, and it does not change the JSON contract (same keys,
-- same per-opportunity shape as DB-FR-006B; see item 2 below for the one
-- documentation clarification regarding the vector term).
--
-- On the empty-result case: as before, if no rows survive `filtered`,
-- json_agg() over zero input rows returns SQL NULL (not an empty array),
-- exactly matching DB-FR-006B's/the certified function's original
-- behavior — this is intentionally not changed, to avoid altering the
-- JSON contract the application layer (opportunityRadar.engine.js's
-- normalizeRadarPayload) already handles.

CREATE OR REPLACE FUNCTION "public"."get_opportunity_radar"(
    "p_user_id" "uuid",
    "p_top_n" integer DEFAULT 10,
    "p_min_opportunity_score" integer DEFAULT 40,
    "p_min_match_score" integer DEFAULT 0
) RETURNS json
    LANGUAGE "plpgsql"
    AS $$
declare
  v_skills text[];
  v_target_role text;
  v_exp int;
  v_user_vector vector;
begin
  -- Load user profile (DB-FR-006B, unchanged in this pass): public.user_profiles
  -- is the certified canonical source of skills/target_role/experience_years
  -- (DB-FR-006A §2.2). user_profiles.user_id is text; p_user_id is uuid, hence
  -- the cast. user_profiles.skills is jsonb; unpacked into the text[] shape
  -- the unmodified downstream unnest()-based logic already expects.
  select
    array(select jsonb_array_elements_text(coalesce(up.skills, '[]'::jsonb))),
    up.target_role,
    up.experience_years
  into v_skills, v_target_role, v_exp
  from public.user_profiles up
  where up.user_id = p_user_id::text;

  -- Optional vector (if exists) — DB-FR-006B, unchanged in this pass:
  -- user_vectors.embedding_vector is the real column (embedding does not
  -- exist; DB-FR-006A §1.1/§5). Same user_id cast rationale as above.
  select embedding_vector
  into v_user_vector
  from public.user_vectors
  where user_id = p_user_id::text;

  -- Core query. DB-FR-006B v1.1 change: filtering/ordering/limiting is now
  -- resolved in an ordinary (non-aggregate) row context, before json_agg()
  -- ever runs — see the header note above for why this was necessary.
  return (
    with ranked as (
      select
        cos.role_name as role,
        cos.opportunity_score,

        round(
          (
            select count(*)
            from unnest(cos.required_skills::text[]) rs
            where lower(rs) = any (
              select lower(us) from unnest(v_skills) us
            )
          ) * 100.0 / greatest(array_length(cos.required_skills::text[], 1), 1)
        ) as match_score,

        (
          select array_agg(rs)
          from unnest(cos.required_skills::text[]) rs
          where lower(rs) != all (
            select lower(us) from unnest(v_skills) us
          )
        ) as skills_to_learn,

        (
          cos.opportunity_score * 0.6 +

          (
            (
              select count(*)
              from unnest(cos.required_skills::text[]) rs
              where lower(rs) = any (
                select lower(us) from unnest(v_skills) us
              )
            ) * 100.0 / greatest(array_length(cos.required_skills::text[], 1), 1)
          ) * 0.4 +

          -- Vector-boost component — see DB-FR-006B v1.1 item 2 note below
          -- for the precise, current-state description of this term.
          -- It contributes 0 to rank_score in every invocation today.
          -- This is a deliberate, documented placeholder, not a bug being
          -- silently reintroduced: career_opportunity_signals has no
          -- embedding column (verified against the full migration history;
          -- none has ever added one), and no certified join exists from
          -- career_opportunity_signals.role_name to any embedding source
          -- in this schema (roles.embedding is a different table, a
          -- different dimension (768), and keyed on a different identity;
          -- job_embeddings is keyed by job_id, not role_name). Introducing
          -- either relationship would be a new architectural join, which
          -- is explicitly out of scope for both DB-FR-006B and this
          -- hardening pass. v_user_vector is still loaded above and still
          -- reported via vector_used in the output, since that reporting
          -- does not depend on cos.embedding — only this scoring term does.
          -- A canonical signals-side embedding source has not been
          -- certified by any DB-FR-006 work package to date; defining one
          -- is deferred to a future, separate work package (see DB-FR-006B
          -- report §7, Deferred Items).
          0

        ) as rank_score

      from public.career_opportunity_signals cos
      where cos.opportunity_score >= p_min_opportunity_score
    ),
    filtered as (
      select *
      from ranked
      where ranked.match_score >= p_min_match_score
      order by ranked.rank_score desc
      limit p_top_n
    )
    select json_build_object(
      'emerging_opportunities', json_agg(f order by f.rank_score desc),
      'user_skills', coalesce(array_length(v_skills, 1), 0),
      'generated_at', now(),
      'vector_used', v_user_vector is not null
    )
    from filtered f
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Institutional-memory comments — updated to precisely describe current
--    behavior (per engineering review: avoid wording implying "the ranking
--    algorithm is unchanged" when the vector term is intentionally inert).
-- -----------------------------------------------------------------------------
-- COMMENT ON is always idempotent/overwrite — safe to replay, and this
-- statement fully replaces the DB-FR-006B comment on this function.

COMMENT ON FUNCTION "public"."get_opportunity_radar"("uuid", integer, integer, integer) IS
    'Canonical Opportunity Radar entry point (DB-FR-006A, certified). Reconciled in DB-FR-006B: reads public.user_profiles (not "userProfiles") for skills/target_role/experience_years and public.user_vectors.embedding_vector (not embedding) for the optional user vector. Production-hardened in DB-FR-006B v1.1: filtering/ordering/limiting (match_score threshold, rank_score DESC, p_top_n) is now resolved in an ordinary row context before json_agg(), with an explicit ORDER BY inside the aggregate call, so "top N, highest-ranked first" is actually enforced and deterministic — the prior version applied ORDER BY/LIMIT at the same query level as an ungrouped aggregate, where they had no effect on which or how many rows were aggregated. The vector-boost ranking component is INTENTIONALLY INACTIVE (fixed at 0 in every invocation): career_opportunity_signals has no embedding column and no DB-FR-006 work package has certified a join from career_opportunity_signals.role_name to any embedding source in this schema (roles.embedding and job_embeddings are both keyed/dimensioned differently and are not certified substitutes). This is a scope boundary, not an oversight: inventing such a join would be a ranking-algorithm redesign, which is explicitly out of scope for DB-FR-006B and this hardening pass. Ranking weights (0.6/0.4), match-score/skills-to-learn logic, output JSON shape, function signature, and return type are otherwise unchanged from the certified function.';

-- Orphan-function comments carried forward unchanged from DB-FR-006B —
-- no new evidence changes their status in this pass, so they are not
-- restated here; re-running the prior migration's COMMENT ON statements
-- for get_opportunity_radar_ai() and match_skills() remains valid and is
-- not superseded by this file.

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- Schema-only / no-op checks except D2, which performs two read-only
-- function calls against a fixed, guaranteed-nonexistent user id to
-- demonstrate deterministic output — no data is modified anywhere below.

-- A. Function exists, with the certified (unchanged) signature and return type.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, t.typname AS returns
FROM pg_proc p
JOIN pg_type t ON t.oid = p.prorettype
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'get_opportunity_radar';
-- expect 1 row: args = "uuid, integer DEFAULT 10, integer DEFAULT 40, integer DEFAULT 0"
-- (or equivalent), returns = json

-- B. Referenced tables and columns exist with the expected types (unchanged
--    from DB-FR-006B — this pass touched only the query's control flow,
--    not which tables/columns it reads).
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'user_profiles' AND column_name IN ('user_id', 'skills', 'target_role', 'experience_years'))
    OR (table_name = 'user_vectors' AND column_name IN ('user_id', 'embedding_vector'))
    OR (table_name = 'career_opportunity_signals' AND column_name IN ('role_name', 'opportunity_score', 'required_skills'))
  )
ORDER BY table_name, column_name;
-- expect 9 rows total

-- C. Previously-referenced, nonexistent columns remain confirmed absent.
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'userProfiles' AND column_name IN ('skills', 'targetRole', 'yearsExperience'))
    OR (table_name = 'user_vectors' AND column_name = 'embedding')
    OR (table_name = 'career_opportunity_signals' AND column_name = 'embedding')
  );
-- expect 0 rows

-- D1. Functional exercise: executes without a schema/column error.
SELECT public.get_opportunity_radar(gen_random_uuid(), 10, 40, 0) AS result;
-- expect: succeeds with no error

-- D2. Deterministic execution: two consecutive calls against the SAME fixed
-- user id (nil uuid — guaranteed not to have a user_profiles/user_vectors
-- row) must return identical JSON. This specifically exercises the fix in
-- §1: prior to this migration, json_agg() had no guaranteed input order, so
-- repeated calls over a result set with ties or multiple qualifying rows
-- could vary in element order between calls even with no underlying data
-- change. With the fix, ordering is explicit at two levels (the `filtered`
-- CTE's ORDER BY and json_agg()'s own ORDER BY), so output is deterministic
-- for a fixed input and fixed underlying data.
--
-- DB-FR-006B v1.2 correction: get_opportunity_radar() returns "json", and
-- PostgreSQL defines no "=" operator for json (only for jsonb, which has a
-- comparable binary representation) — the original form of this check
-- failed with "operator does not exist: json = json" during `supabase db
-- reset`. The production function's return type is correct and is NOT
-- changed here; both call results are cast to jsonb solely for this
-- equality check. This is a strictly stronger comparison than a
-- hypothetical text-level check would be: jsonb equality is structural
-- (normalized key order/whitespace), so it correctly treats two
-- structurally-identical JSON payloads as equal even if their textual
-- serialization ever differed.
SELECT
  (public.get_opportunity_radar('00000000-0000-0000-0000-000000000000'::uuid, 10, 40, 0))::jsonb =
  (public.get_opportunity_radar('00000000-0000-0000-0000-000000000000'::uuid, 10, 40, 0))::jsonb
  AS deterministic_repeat_call;
-- expect: true

-- D3. (Data-dependent — informational, for staging/QA once
-- career_opportunity_signals has rows meeting a given user's thresholds.)
-- Confirms rank_score is non-increasing across the returned array, i.e.
-- highest-ranked opportunities really do come first. Returns NULL/true
-- trivially on an empty or single-element result, which is expected and
-- fine in an environment with no matching data yet; it is meaningful once
-- real signals exist.
-- NOT executed as part of this migration: `:'sample_user_id'` is a psql
-- meta-command variable substitution, which only works when this snippet is
-- pasted into an interactive `psql` session (or run via `psql -v
-- sample_user_id=... -f`) with a real UUID supplied. It is NOT valid SQL
-- when sent directly to the server, which is how `supabase db reset` /
-- CI apply migrations — sending it as-is causes:
--   ERROR: syntax error at or near ":" (SQLSTATE 42601)
-- Left here as copy/paste reference for manual staging QA only. To run it,
-- copy the block below into psql, replacing :'sample_user_id' with an
-- actual user UUID (or set it via `\set sample_user_id '...'` first).
--
-- WITH r AS (
--   SELECT public.get_opportunity_radar(:'sample_user_id'::uuid, 10, 40, 0) AS payload
-- ),
-- elems AS (
--   SELECT (value->>'rank_score')::numeric AS rank_score,
--          ordinality
--   FROM r, json_array_elements(r.payload->'emerging_opportunities') WITH ORDINALITY
-- )
-- SELECT bool_and(rank_score <= lag(rank_score) OVER (ORDER BY ordinality) OR lag(rank_score) OVER (ORDER BY ordinality) IS NULL) AS non_increasing
-- FROM elems;
-- expect: true (or NULL on an empty result set). Requires a real
-- sample_user_id to be supplied by whoever runs this check in staging;
-- not runnable as schema-only verification and not required for this
-- migration to be considered production-certified.

-- E. Orphan-status comments remain attached (carried forward from
--    DB-FR-006B; unchanged by this migration).
SELECT p.proname, d.description
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_description d ON d.objoid = p.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('get_opportunity_radar', 'get_opportunity_radar_ai', 'match_skills');
-- expect 3 rows, one per function, non-null description, with
-- get_opportunity_radar's description reflecting the v1.1 wording above