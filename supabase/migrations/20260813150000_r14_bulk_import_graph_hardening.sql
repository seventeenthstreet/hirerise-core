-- =============================================================================
-- WP-ADMIN-COMP-08-R14 — Bulk Import Graph Hardening
-- =============================================================================
-- File: supabase/migrations/20260813150000_r14_bulk_import_graph_hardening.sql
-- Sequence position: after the latest migration in this repository snapshot,
-- 20260811070000_wp_admin_comp_06_r3_jobs_upsert_conflict_target_fix.sql —
-- confirmed by a full directory listing of supabase/migrations/ (no
-- migration with a later timestamp exists in this snapshot). Forward-only:
-- this file does not edit any prior migration.
--
-- Governing evidence: WP-ADMIN-COMP-08-R11 (orphan investigation),
-- R12 (stewardship decision), R13 (design validation).
--
-- This migration hardens public.bulk_import_graph(p_dataset text, p_rows jsonb)
-- for the five role_id-bearing dependent-dataset branches identified by R11 as
-- the mechanism most consistent with the 29-canonical-orphan / 317-row
-- condition: role_skills, role_transitions, role_education, role_salary_market,
-- and role_market_demand (in scope per this migration's own R14 Phase 0 check —
-- see the implementation report).
--
-- Design (per R13 §8/§12, correcting R12 §13.2's literal "raise + audit" text):
--   - Each of the five branches is partitioned into rows whose role identity
--     exists in roles.role_id and rows that don't (role_transitions requires
--     BOTH from_role_id and to_role_id to exist).
--   - Only the valid partition is inserted/updated (unchanged upsert behavior
--     for valid rows).
--   - Invalid rows are NOT raised as an exception (doing so would roll back an
--     import_logs audit insert made in the same call — no dblink/postgres_fdw/
--     pg_background extension exists in this schema to work around that).
--     Instead they are collected and returned to the caller in the function's
--     JSONB result under "rejected", and written to public.import_logs in the
--     same successful call, so the call commits and the audit trail survives.
--   - The 'roles', 'skills', and 'skill_relationships' branches are UNCHANGED —
--     they are out of R11/R12/R13's scope ('roles' is the authoritative table
--     itself; 'skills'/'skill_relationships' are a different identity domain,
--     see WP-ADMIN-COMP-08-R2). The function's existing top-level EXCEPTION
--     handler (malformed JSON / unknown dataset) is UNCHANGED.
--
-- Grants: UNCHANGED in this migration. R13 §9/§16 flagged anon/authenticated
-- grant revocation as requiring explicit human sign-off that no caller outside
-- this repository's visibility depends on it — that confirmation has not been
-- given as of this migration. Revocation is deliberately deferred to a
-- follow-up migration once that sign-off is obtained (see the R14 report,
-- §8 Grant Decision).
--
-- No table structure changes. No historical row in role_skills,
-- role_transitions, role_education, role_salary_market, or role_market_demand
-- is read, written, or scanned by this migration — CREATE OR REPLACE FUNCTION
-- only redefines procedural code; it takes effect on the next invocation only.
-- =============================================================================

CREATE OR REPLACE FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_inserted      BIGINT := 0;
    v_updated       BIGINT := 0;
    v_total         BIGINT := 0;
    v_existing      BIGINT := 0;
    v_valid_count   BIGINT := 0;
    v_rejected      JSONB := '[]'::JSONB;
    v_rejected_cnt  BIGINT := 0;
BEGIN
    -- ------------------------------------------------------------------ --
    --  Guard: validate input (UNCHANGED from prior definition)
    -- ------------------------------------------------------------------ --
    IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
        RETURN jsonb_build_object('inserted', 0, 'updated', 0, 'total', 0);
    END IF;

    IF jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'bulk_import_graph: p_rows must be a JSON array, got %', jsonb_typeof(p_rows);
    END IF;

    v_total := jsonb_array_length(p_rows);

    CASE p_dataset

        -- ----------------------------------------------------------------
        -- roles — UNCHANGED (authoritative table itself, not a reference)
        --   PK/conflict : role_id (text)
        --   Excluded    : search_vector, embedding, embedding_updated_at
        --                 (managed by triggers/pipelines, never overwritten)
        -- ----------------------------------------------------------------
        WHEN 'roles' THEN

            SELECT COUNT(*) INTO v_existing
            FROM roles r
            WHERE r.role_id IN (
                SELECT rec->>'role_id'
                FROM jsonb_array_elements(p_rows) AS rec
            );

            INSERT INTO roles (
                role_id,
                role_name,
                normalized_name,
                role_family,
                seniority_level,
                track,
                description,
                alternative_titles,
                agency,
                created_by,
                updated_by,
                soft_deleted,
                created_at,
                updated_at
            )
            SELECT
                rec->>'role_id',
                rec->>'role_name',
                rec->>'normalized_name',
                rec->>'role_family',
                rec->>'seniority_level',
                rec->>'track',
                rec->>'description',
                CASE
                    WHEN rec->'alternative_titles' IS NOT NULL
                    THEN ARRAY(SELECT jsonb_array_elements_text(rec->'alternative_titles'))
                    ELSE ARRAY[]::TEXT[]
                END,
                rec->>'agency',
                rec->>'created_by',
                rec->>'updated_by',
                COALESCE((rec->>'soft_deleted')::BOOLEAN, FALSE),
                COALESCE((rec->>'created_at')::TIMESTAMPTZ, NOW()),
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
            ON CONFLICT (role_id) DO UPDATE
                SET role_name          = EXCLUDED.role_name,
                    normalized_name    = EXCLUDED.normalized_name,
                    role_family        = EXCLUDED.role_family,
                    seniority_level    = EXCLUDED.seniority_level,
                    track              = EXCLUDED.track,
                    description        = EXCLUDED.description,
                    alternative_titles = EXCLUDED.alternative_titles,
                    agency             = EXCLUDED.agency,
                    updated_by         = EXCLUDED.updated_by,
                    soft_deleted       = EXCLUDED.soft_deleted,
                    updated_at         = NOW()
                WHERE (
                    roles.role_name          IS DISTINCT FROM EXCLUDED.role_name          OR
                    roles.normalized_name    IS DISTINCT FROM EXCLUDED.normalized_name    OR
                    roles.role_family        IS DISTINCT FROM EXCLUDED.role_family        OR
                    roles.seniority_level    IS DISTINCT FROM EXCLUDED.seniority_level    OR
                    roles.track              IS DISTINCT FROM EXCLUDED.track              OR
                    roles.description        IS DISTINCT FROM EXCLUDED.description        OR
                    roles.alternative_titles IS DISTINCT FROM EXCLUDED.alternative_titles OR
                    roles.agency             IS DISTINCT FROM EXCLUDED.agency             OR
                    roles.soft_deleted       IS DISTINCT FROM EXCLUDED.soft_deleted
                );

            v_updated  := v_existing;
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- skills — UNCHANGED (separate identity domain, see WP-ADMIN-COMP-08-R2)
        --   PK/conflict : skill_id (text)
        -- ----------------------------------------------------------------
        WHEN 'skills' THEN

            SELECT COUNT(*) INTO v_existing
            FROM skills s
            WHERE s.skill_id IN (
                SELECT rec->>'skill_id'
                FROM jsonb_array_elements(p_rows) AS rec
            );

            INSERT INTO skills (
                skill_id,
                skill_name,
                skill_category,
                category,
                difficulty_level,
                demand_score,
                name,
                old_id,
                aliases,
                metadata,
                data,
                soft_deleted,
                created_at,
                updated_at
            )
            SELECT
                rec->>'skill_id',
                rec->>'skill_name',
                rec->>'skill_category',
                rec->>'category',
                (rec->>'difficulty_level')::NUMERIC,
                (rec->>'demand_score')::NUMERIC,
                rec->>'name',
                rec->>'old_id',
                CASE
                    WHEN rec->'aliases' IS NOT NULL THEN rec->'aliases'
                    ELSE '[]'::JSONB
                END,
                CASE
                    WHEN rec->'metadata' IS NOT NULL THEN rec->'metadata'
                    ELSE '{}'::JSONB
                END,
                CASE
                    WHEN rec->'data' IS NOT NULL THEN rec->'data'
                    ELSE '{}'::JSONB
                END,
                COALESCE((rec->>'soft_deleted')::BOOLEAN, FALSE),
                COALESCE((rec->>'created_at')::TIMESTAMPTZ, NOW()),
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
            ON CONFLICT (skill_id) DO UPDATE
                SET skill_name      = EXCLUDED.skill_name,
                    skill_category  = EXCLUDED.skill_category,
                    category        = EXCLUDED.category,
                    difficulty_level= EXCLUDED.difficulty_level,
                    demand_score    = EXCLUDED.demand_score,
                    name            = EXCLUDED.name,
                    old_id          = EXCLUDED.old_id,
                    aliases         = EXCLUDED.aliases,
                    metadata        = EXCLUDED.metadata,
                    data            = EXCLUDED.data,
                    soft_deleted    = EXCLUDED.soft_deleted,
                    updated_at      = NOW()
                WHERE (
                    skills.skill_name       IS DISTINCT FROM EXCLUDED.skill_name       OR
                    skills.skill_category   IS DISTINCT FROM EXCLUDED.skill_category   OR
                    skills.category         IS DISTINCT FROM EXCLUDED.category         OR
                    skills.difficulty_level IS DISTINCT FROM EXCLUDED.difficulty_level OR
                    skills.demand_score     IS DISTINCT FROM EXCLUDED.demand_score     OR
                    skills.name             IS DISTINCT FROM EXCLUDED.name             OR
                    skills.aliases          IS DISTINCT FROM EXCLUDED.aliases          OR
                    skills.metadata         IS DISTINCT FROM EXCLUDED.metadata         OR
                    skills.data             IS DISTINCT FROM EXCLUDED.data             OR
                    skills.soft_deleted     IS DISTINCT FROM EXCLUDED.soft_deleted
                );

            v_updated  := v_existing;
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- role_skills — HARDENED (R11/R12/R13/R14)
        --   PK/conflict : (role_id, skill_id)  — both text
        --   role_id must exist in roles.role_id; invalid rows are excluded
        --   from the write, collected in v_rejected, and logged — not raised.
        -- ----------------------------------------------------------------
        WHEN 'role_skills' THEN

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id'  AS role_id,
                       rec->>'skill_id' AS skill_id
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT
                COALESCE(jsonb_agg(rec) FILTER (WHERE NOT is_valid), '[]'::JSONB),
                COUNT(*) FILTER (WHERE is_valid)
            INTO v_rejected, v_valid_count
            FROM validated;

            v_rejected_cnt := jsonb_array_length(v_rejected);

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id'  AS role_id,
                       rec->>'skill_id' AS skill_id
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT COUNT(*) INTO v_existing
            FROM role_skills rs
            WHERE (rs.role_id, rs.skill_id) IN (
                SELECT role_id, skill_id FROM validated WHERE is_valid
            );

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id'  AS role_id,
                       rec->>'skill_id' AS skill_id
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            INSERT INTO role_skills (
                role_id,
                skill_id,
                importance_weight,
                updated_at
            )
            SELECT
                role_id,
                skill_id,
                COALESCE((rec->>'importance_weight')::NUMERIC, 0),
                NOW()
            FROM validated
            WHERE is_valid
            ON CONFLICT (role_id, skill_id) DO UPDATE
                SET importance_weight = EXCLUDED.importance_weight,
                    updated_at        = NOW()
                WHERE role_skills.importance_weight IS DISTINCT FROM EXCLUDED.importance_weight;

            v_updated  := v_existing;
            v_inserted := v_valid_count - v_existing;

        -- ----------------------------------------------------------------
        -- role_transitions — HARDENED (R11/R12/R13/R14)
        --   PK/conflict : (from_role_id, to_role_id)  — both text
        --   BOTH from_role_id and to_role_id must exist in roles.role_id.
        -- ----------------------------------------------------------------
        WHEN 'role_transitions' THEN

            WITH incoming AS (
                SELECT rec,
                       rec->>'from_role_id' AS from_role_id,
                       rec->>'to_role_id'   AS to_role_id
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (rf.role_id IS NOT NULL AND rt.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles rf ON rf.role_id = i.from_role_id
                LEFT JOIN roles rt ON rt.role_id = i.to_role_id
            )
            SELECT
                COALESCE(jsonb_agg(rec) FILTER (WHERE NOT is_valid), '[]'::JSONB),
                COUNT(*) FILTER (WHERE is_valid)
            INTO v_rejected, v_valid_count
            FROM validated;

            v_rejected_cnt := jsonb_array_length(v_rejected);

            WITH incoming AS (
                SELECT rec,
                       rec->>'from_role_id' AS from_role_id,
                       rec->>'to_role_id'   AS to_role_id
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (rf.role_id IS NOT NULL AND rt.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles rf ON rf.role_id = i.from_role_id
                LEFT JOIN roles rt ON rt.role_id = i.to_role_id
            )
            SELECT COUNT(*) INTO v_existing
            FROM role_transitions rt2
            WHERE (rt2.from_role_id, rt2.to_role_id) IN (
                SELECT from_role_id, to_role_id FROM validated WHERE is_valid
            );

            WITH incoming AS (
                SELECT rec,
                       rec->>'from_role_id' AS from_role_id,
                       rec->>'to_role_id'   AS to_role_id
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (rf.role_id IS NOT NULL AND rt.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles rf ON rf.role_id = i.from_role_id
                LEFT JOIN roles rt ON rt.role_id = i.to_role_id
            )
            INSERT INTO role_transitions (
                from_role_id,
                to_role_id,
                probability,
                years_required,
                transition_type,
                updated_at
            )
            SELECT
                from_role_id,
                to_role_id,
                (rec->>'probability')::NUMERIC,
                (rec->>'years_required')::NUMERIC,
                rec->>'transition_type',
                NOW()
            FROM validated
            WHERE is_valid
            ON CONFLICT (from_role_id, to_role_id) DO UPDATE
                SET probability      = EXCLUDED.probability,
                    years_required   = EXCLUDED.years_required,
                    transition_type  = EXCLUDED.transition_type,
                    updated_at       = NOW()
                WHERE (
                    role_transitions.probability     IS DISTINCT FROM EXCLUDED.probability     OR
                    role_transitions.years_required  IS DISTINCT FROM EXCLUDED.years_required  OR
                    role_transitions.transition_type IS DISTINCT FROM EXCLUDED.transition_type
                );

            v_updated  := v_existing;
            v_inserted := v_valid_count - v_existing;

        -- ----------------------------------------------------------------
        -- skill_relationships — UNCHANGED (skill_id domain, out of scope)
        --   PK/conflict : (skill_id, related_skill_id)  — both text
        -- ----------------------------------------------------------------
        WHEN 'skill_relationships' THEN

            SELECT COUNT(*) INTO v_existing
            FROM skill_relationships sr
            WHERE (sr.skill_id, sr.related_skill_id) IN (
                SELECT rec->>'skill_id', rec->>'related_skill_id'
                FROM jsonb_array_elements(p_rows) AS rec
            );

            INSERT INTO skill_relationships (
                skill_id,
                related_skill_id,
                relationship_type,
                strength_score,
                updated_at
            )
            SELECT
                rec->>'skill_id',
                rec->>'related_skill_id',
                rec->>'relationship_type',
                (rec->>'strength_score')::NUMERIC,
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
            ON CONFLICT (skill_id, related_skill_id) DO UPDATE
                SET relationship_type = EXCLUDED.relationship_type,
                    strength_score    = EXCLUDED.strength_score,
                    updated_at        = NOW()
                WHERE (
                    skill_relationships.relationship_type IS DISTINCT FROM EXCLUDED.relationship_type OR
                    skill_relationships.strength_score    IS DISTINCT FROM EXCLUDED.strength_score
                );

            v_updated  := v_existing;
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- role_education — HARDENED (R11/R12/R13/R14)
        --   PK/conflict : (role_id, education_level)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_education' THEN

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id'         AS role_id,
                       rec->>'education_level' AS education_level
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT
                COALESCE(jsonb_agg(rec) FILTER (WHERE NOT is_valid), '[]'::JSONB),
                COUNT(*) FILTER (WHERE is_valid)
            INTO v_rejected, v_valid_count
            FROM validated;

            v_rejected_cnt := jsonb_array_length(v_rejected);

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id'         AS role_id,
                       rec->>'education_level' AS education_level
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT COUNT(*) INTO v_existing
            FROM role_education re
            WHERE (re.role_id, re.education_level) IN (
                SELECT role_id, education_level FROM validated WHERE is_valid
            );

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id'         AS role_id,
                       rec->>'education_level' AS education_level
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            INSERT INTO role_education (
                role_id,
                education_level,
                match_score,
                updated_at
            )
            SELECT
                role_id,
                education_level,
                (rec->>'match_score')::NUMERIC,
                NOW()
            FROM validated
            WHERE is_valid
            ON CONFLICT (role_id, education_level) DO UPDATE
                SET match_score = EXCLUDED.match_score,
                    updated_at  = NOW()
                WHERE role_education.match_score IS DISTINCT FROM EXCLUDED.match_score;

            v_updated  := v_existing;
            v_inserted := v_valid_count - v_existing;

        -- ----------------------------------------------------------------
        -- role_salary_market — HARDENED (R11/R12/R13/R14)
        --   PK/conflict : (role_id, country)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_salary_market' THEN

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id' AS role_id,
                       rec->>'country' AS country
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT
                COALESCE(jsonb_agg(rec) FILTER (WHERE NOT is_valid), '[]'::JSONB),
                COUNT(*) FILTER (WHERE is_valid)
            INTO v_rejected, v_valid_count
            FROM validated;

            v_rejected_cnt := jsonb_array_length(v_rejected);

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id' AS role_id,
                       rec->>'country' AS country
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT COUNT(*) INTO v_existing
            FROM role_salary_market rsm
            WHERE (rsm.role_id, rsm.country) IN (
                SELECT role_id, country FROM validated WHERE is_valid
            );

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id' AS role_id,
                       rec->>'country' AS country
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            INSERT INTO role_salary_market (
                role_id,
                country,
                median_salary,
                p25,
                p75,
                currency,
                updated_at
            )
            SELECT
                role_id,
                country,
                (rec->>'median_salary')::NUMERIC,
                (rec->>'p25')::NUMERIC,
                (rec->>'p75')::NUMERIC,
                rec->>'currency',
                NOW()
            FROM validated
            WHERE is_valid
            ON CONFLICT (role_id, country) DO UPDATE
                SET median_salary = EXCLUDED.median_salary,
                    p25           = EXCLUDED.p25,
                    p75           = EXCLUDED.p75,
                    currency      = EXCLUDED.currency,
                    updated_at    = NOW()
                WHERE (
                    role_salary_market.median_salary IS DISTINCT FROM EXCLUDED.median_salary OR
                    role_salary_market.p25           IS DISTINCT FROM EXCLUDED.p25           OR
                    role_salary_market.p75           IS DISTINCT FROM EXCLUDED.p75           OR
                    role_salary_market.currency      IS DISTINCT FROM EXCLUDED.currency
                );

            v_updated  := v_existing;
            v_inserted := v_valid_count - v_existing;

        -- ----------------------------------------------------------------
        -- role_market_demand — HARDENED (R14 Phase 0: same role_id text
        --   NOT NULL contract as the other four dependent tables, no FK,
        --   same unvalidated INSERT ... ON CONFLICT DO UPDATE shape prior to
        --   this migration. Currently empty (R11 §2) but in scope — an empty
        --   table today does not mean it cannot receive the same unvalidated
        --   writes tomorrow through this same RPC.
        --   PK/conflict : (role_id, country)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_market_demand' THEN

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id' AS role_id,
                       rec->>'country' AS country
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT
                COALESCE(jsonb_agg(rec) FILTER (WHERE NOT is_valid), '[]'::JSONB),
                COUNT(*) FILTER (WHERE is_valid)
            INTO v_rejected, v_valid_count
            FROM validated;

            v_rejected_cnt := jsonb_array_length(v_rejected);

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id' AS role_id,
                       rec->>'country' AS country
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            SELECT COUNT(*) INTO v_existing
            FROM role_market_demand rmd
            WHERE (rmd.role_id, rmd.country) IN (
                SELECT role_id, country FROM validated WHERE is_valid
            );

            WITH incoming AS (
                SELECT rec,
                       rec->>'role_id' AS role_id,
                       rec->>'country' AS country
                FROM jsonb_array_elements(p_rows) AS rec
            ),
            validated AS (
                SELECT i.*, (r.role_id IS NOT NULL) AS is_valid
                FROM incoming i
                LEFT JOIN roles r ON r.role_id = i.role_id
            )
            INSERT INTO role_market_demand (
                role_id,
                country,
                job_postings,
                growth_rate,
                competition_score,
                remote_ratio,
                last_updated,
                updated_at
            )
            SELECT
                role_id,
                country,
                (rec->>'job_postings')::INTEGER,
                (rec->>'growth_rate')::NUMERIC,
                (rec->>'competition_score')::NUMERIC,
                (rec->>'remote_ratio')::NUMERIC,
                rec->>'last_updated',
                NOW()
            FROM validated
            WHERE is_valid
            ON CONFLICT (role_id, country) DO UPDATE
                SET job_postings      = EXCLUDED.job_postings,
                    growth_rate       = EXCLUDED.growth_rate,
                    competition_score = EXCLUDED.competition_score,
                    remote_ratio      = EXCLUDED.remote_ratio,
                    last_updated      = EXCLUDED.last_updated,
                    updated_at        = NOW()
                WHERE (
                    role_market_demand.job_postings      IS DISTINCT FROM EXCLUDED.job_postings      OR
                    role_market_demand.growth_rate       IS DISTINCT FROM EXCLUDED.growth_rate       OR
                    role_market_demand.competition_score IS DISTINCT FROM EXCLUDED.competition_score OR
                    role_market_demand.remote_ratio      IS DISTINCT FROM EXCLUDED.remote_ratio      OR
                    role_market_demand.last_updated      IS DISTINCT FROM EXCLUDED.last_updated
                );

            v_updated  := v_existing;
            v_inserted := v_valid_count - v_existing;

        -- ----------------------------------------------------------------
        ELSE
            RAISE EXCEPTION
                'bulk_import_graph: unknown dataset "%". Valid values: roles, skills, role_skills, role_transitions, skill_relationships, role_education, role_salary_market, role_market_demand',
                p_dataset;

    END CASE;

    -- ------------------------------------------------------------------ --
    --  Audit trail for the five hardened branches only (R13 §8/§12:
    --  return-status pattern — the call always completes and commits, so
    --  this insert is never rolled back by a rejection it's recording).
    -- ------------------------------------------------------------------ --
    IF p_dataset IN ('role_skills', 'role_transitions', 'role_education',
                      'role_salary_market', 'role_market_demand') THEN
        INSERT INTO import_logs (
            entity_type,
            row_results,
            imported_at,
            dataset_name,
            rows_processed,
            rows_imported,
            rows_skipped,
            rows_failed,
            import_mode
        ) VALUES (
            p_dataset,
            v_rejected,
            NOW(),
            p_dataset,
            v_total,
            GREATEST(v_inserted, 0) + v_updated,
            0,
            v_rejected_cnt,
            'bulk_import_graph'
        );
    END IF;

    RETURN jsonb_build_object(
        'inserted', GREATEST(v_inserted, 0),
        'updated',  v_updated,
        'total',    v_total,
        'rejected', v_rejected
    );

EXCEPTION
    WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'bulk_import_graph[%]: malformed value in p_rows — %', p_dataset, SQLERRM;
    WHEN not_null_violation THEN
        RAISE EXCEPTION 'bulk_import_graph[%]: missing required field — %', p_dataset, SQLERRM;
    WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'bulk_import_graph[%]: foreign key violation — %', p_dataset, SQLERRM;
    WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION 'bulk_import_graph[%]: numeric value out of range — %', p_dataset, SQLERRM;
END;
$$;

-- =============================================================================
-- Grants: UNCHANGED. anon/authenticated/service_role grants from
-- 000_initial_schema.sql remain exactly as they are. Revocation of anon/
-- authenticated is deliberately NOT included in this migration — see the
-- R14 implementation report §8 for why, and what is required before a
-- follow-up migration may do so.
-- =============================================================================
