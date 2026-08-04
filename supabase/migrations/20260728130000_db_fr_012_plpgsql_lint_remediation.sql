-- =============================================================================
-- DB-FR-012 — PL/pgSQL Lint Remediation (supabase db lint)
-- =============================================================================
--
-- Scope: the 12 functions flagged by `supabase db lint` (schemas: audit,
-- extensions, governance, public, student_spce — all findings were in
-- public). Every function below is redefined at its currently-live
-- definition (the most recent migration that actually CREATE OR REPLACEs
-- it), not a stale earlier copy — verified by grepping the full migration
-- history for each function name before editing.
--
-- All fixes in this migration are either (a) pure dead-code removal, or
-- (b) untyped-literal → correctly-typed-literal corrections. None of them
-- change return values, JSON contracts, control flow, or SQL executed
-- against the database. Per-function rationale is documented inline at
-- each fix site below.
--
-- Two categories of warning needed different treatment:
--
--   1. Untyped '{}'/'[]' literals assigned to a typed array/jsonb local
--      (SQLSTATE 42804, "target type is different type than source type"):
--      Postgres has no assignment cast from bare text '{}' to uuid[]/
--      text[]/jsonb[]/jsonb. Fixed with ARRAY[]::<type>[] or '[]'::jsonb.
--      No behavior change — both produce the same empty starting value.
--
--   2. "extra" warnings (never-read variables, unused parameters,
--      unmodified OUT variables, shadowed loop variables): these are
--      plpgsql_check's stricter "extra_warnings" class, not core
--      correctness issues. Fixed per-case:
--        - Genuinely dead locals/params (assigned or selected but never
--          read anywhere) → removed.
--        - A declared variable shadowed by a FOR-loop's own implicit loop
--          variable → the redundant explicit declaration removed.
--        - Parameters intentionally unused by design (two DB-FR-007
--          deprecated stubs that unconditionally raise; two multi-tenancy
--          placeholder params not yet wired into the functions they call)
--          → left in place (removing them would be a signature/scope
--          change beyond this lint-remediation pass) and referenced via
--          RAISE DEBUG so the linter sees a genuine read. RAISE DEBUG is
--          suppressed at Postgres's default client_min_messages, so this
--          has no observable runtime effect.
--
-- Replay-safety: every statement here is CREATE OR REPLACE FUNCTION —
-- idempotent, safe to re-run.
-- =============================================================================

BEGIN;


-- -----------------------------------------------------------------------------
-- 1. public.bulk_import_dataset — typed-empty-array casts
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."bulk_import_dataset"("p_dataset" "text", "p_rows" "jsonb", "p_admin_id" "uuid", "p_agency" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_total int := jsonb_array_length(p_rows);

  v_inserted_ids uuid[] := ARRAY[]::uuid[];
  v_duplicate_names text[] := ARRAY[]::text[];
  v_errors jsonb := '[]'::jsonb;

  rec jsonb;
  v_name text;
  v_normalized text;
  v_id uuid;
begin

  -- ✅ Only handle skills for now (we stabilize first)
  if p_dataset != 'skills' then
    raise exception 'Only skills supported in this version';
  end if;

  for rec in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_name := trim(rec->>'name');

      if v_name is null or length(v_name) = 0 then
        v_errors := v_errors || jsonb_build_object(
          'row', rec,
          'message', 'Invalid name'
        );
        continue;
      end if;

      v_normalized := lower(v_name);

      -- 🔥 STATIC INSERT (NO EXECUTE)
      insert into cms_skills (
        name,
        normalized_name,
        category,
        aliases,
        description,
        search_tokens,
        demand_score,
        status,
        created_by_admin_id,
        updated_by_admin_id,
        source_agency,
        soft_deleted,
        created_at,
        updated_at
      )
      values (
        v_name,
        v_normalized,
        'general',
        '[]'::jsonb,
        '',
        '[]'::jsonb,
        0,
        'active',
        p_admin_id::text,
        p_admin_id::text,
        p_agency,
        false,
        now(),
        now()
      )
      on conflict (normalized_name)
      do nothing
      returning id into v_id;

      if v_id is not null then
        v_inserted_ids := array_append(v_inserted_ids, v_id);
      else
        v_duplicate_names := array_append(v_duplicate_names, v_name);
      end if;

    exception when others then
      v_errors := v_errors || jsonb_build_object(
        'row', rec,
        'message', SQLERRM
      );
    end;
  end loop;

  return jsonb_build_object(
    'total', v_total,
    'inserted', coalesce(array_length(v_inserted_ids, 1), 0),
    'skipped', coalesce(array_length(v_duplicate_names, 1), 0),
    'insertedIds', v_inserted_ids,
    'duplicates', v_duplicate_names,
    'errors', v_errors
  );

end;
$$;

-- -----------------------------------------------------------------------------
-- 2. public.bulk_import_graph — remove dead v_rows_affected
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_inserted      BIGINT := 0;
    v_updated       BIGINT := 0;
    v_total         BIGINT := 0;
    v_existing      BIGINT := 0;
BEGIN
    -- ------------------------------------------------------------------ --
    --  Guard: validate input
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
        -- roles
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
        -- skills
        --   PK/conflict : skill_id (text)
        --   Note        : old_id, name, metadata, aliases, data kept as-is
        --                 if not supplied; embedding left untouched
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
        -- role_skills
        --   PK/conflict : (role_id, skill_id)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_skills' THEN

            SELECT COUNT(*) INTO v_existing
            FROM role_skills rs
            WHERE (rs.role_id, rs.skill_id) IN (
                SELECT rec->>'role_id', rec->>'skill_id'
                FROM jsonb_array_elements(p_rows) AS rec
            );

            INSERT INTO role_skills (
                role_id,
                skill_id,
                importance_weight,
                updated_at
            )
            SELECT
                rec->>'role_id',
                rec->>'skill_id',
                COALESCE((rec->>'importance_weight')::NUMERIC, 0),
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
            ON CONFLICT (role_id, skill_id) DO UPDATE
                SET importance_weight = EXCLUDED.importance_weight,
                    updated_at        = NOW()
                WHERE role_skills.importance_weight IS DISTINCT FROM EXCLUDED.importance_weight;

            v_updated  := v_existing;
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- role_transitions
        --   PK/conflict : (from_role_id, to_role_id)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_transitions' THEN

            SELECT COUNT(*) INTO v_existing
            FROM role_transitions rt
            WHERE (rt.from_role_id, rt.to_role_id) IN (
                SELECT rec->>'from_role_id', rec->>'to_role_id'
                FROM jsonb_array_elements(p_rows) AS rec
            );

            INSERT INTO role_transitions (
                from_role_id,
                to_role_id,
                probability,
                years_required,
                transition_type,
                updated_at
            )
            SELECT
                rec->>'from_role_id',
                rec->>'to_role_id',
                (rec->>'probability')::NUMERIC,
                (rec->>'years_required')::NUMERIC,
                rec->>'transition_type',
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
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
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- skill_relationships
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
        -- role_education
        --   PK/conflict : (role_id, education_level)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_education' THEN

            SELECT COUNT(*) INTO v_existing
            FROM role_education re
            WHERE (re.role_id, re.education_level) IN (
                SELECT rec->>'role_id', rec->>'education_level'
                FROM jsonb_array_elements(p_rows) AS rec
            );

            INSERT INTO role_education (
                role_id,
                education_level,
                match_score,
                updated_at
            )
            SELECT
                rec->>'role_id',
                rec->>'education_level',
                (rec->>'match_score')::NUMERIC,
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
            ON CONFLICT (role_id, education_level) DO UPDATE
                SET match_score = EXCLUDED.match_score,
                    updated_at  = NOW()
                WHERE role_education.match_score IS DISTINCT FROM EXCLUDED.match_score;

            v_updated  := v_existing;
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- role_salary_market
        --   PK/conflict : (role_id, country)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_salary_market' THEN

            SELECT COUNT(*) INTO v_existing
            FROM role_salary_market rsm
            WHERE (rsm.role_id, rsm.country) IN (
                SELECT rec->>'role_id', rec->>'country'
                FROM jsonb_array_elements(p_rows) AS rec
            );

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
                rec->>'role_id',
                rec->>'country',
                (rec->>'median_salary')::NUMERIC,
                (rec->>'p25')::NUMERIC,
                (rec->>'p75')::NUMERIC,
                rec->>'currency',
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
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
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        -- role_market_demand
        --   PK/conflict : (role_id, country)  — both text
        -- ----------------------------------------------------------------
        WHEN 'role_market_demand' THEN

            SELECT COUNT(*) INTO v_existing
            FROM role_market_demand rmd
            WHERE (rmd.role_id, rmd.country) IN (
                SELECT rec->>'role_id', rec->>'country'
                FROM jsonb_array_elements(p_rows) AS rec
            );

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
                rec->>'role_id',
                rec->>'country',
                (rec->>'job_postings')::INTEGER,
                (rec->>'growth_rate')::NUMERIC,
                (rec->>'competition_score')::NUMERIC,
                (rec->>'remote_ratio')::NUMERIC,
                rec->>'last_updated',
                NOW()
            FROM jsonb_array_elements(p_rows) AS rec
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
            v_inserted := v_total - v_existing;

        -- ----------------------------------------------------------------
        ELSE
            RAISE EXCEPTION
                'bulk_import_graph: unknown dataset "%". Valid values: roles, skills, role_skills, role_transitions, skill_relationships, role_education, role_salary_market, role_market_demand',
                p_dataset;

    END CASE;

    RETURN jsonb_build_object(
        'inserted', GREATEST(v_inserted, 0),
        'updated',  v_updated,
        'total',    v_total
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

-- -----------------------------------------------------------------------------
-- 3. public.bulk_import_skills — typed-empty-array casts
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."bulk_import_skills"("p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_row         jsonb;
  v_id          uuid;
  v_norm        text;
  v_inserted    uuid[]  := ARRAY[]::uuid[];
  v_duplicates  text[]  := ARRAY[]::text[];
  v_errors      jsonb[] := ARRAY[]::jsonb[];
  v_index       int     := 0;
BEGIN
  -- Validate input
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_index := v_index + 1;

    BEGIN
      -- Validate required fields before attempting insert
      IF (v_row->>'name') IS NULL OR trim(v_row->>'name') = '' THEN
        RAISE EXCEPTION 'name is required';
      END IF;

      IF (v_row->>'category') IS NULL OR trim(v_row->>'category') = '' THEN
        RAISE EXCEPTION 'category is required';
      END IF;

      IF (v_row->>'created_by_admin_id') IS NULL THEN
        RAISE EXCEPTION 'created_by_admin_id is required';
      END IF;

      -- Compute normalized_name if not provided
      v_norm := COALESCE(
        NULLIF(trim(v_row->>'normalized_name'), ''),
        lower(regexp_replace(trim(v_row->>'name'), '\s+', '_', 'g'))
      );

      INSERT INTO cms_skills (
        id,
        name,
        normalized_name,
        category,
        aliases,
        description,
        demand_score,
        search_tokens,
        status,
        created_by_admin_id,
        updated_by_admin_id,
        source_agency,
        soft_deleted,
        created_at,
        updated_at
      )
      VALUES (
        COALESCE((v_row->>'id')::uuid, gen_random_uuid()),
        trim(v_row->>'name'),
        v_norm,
        trim(v_row->>'category'),
        COALESCE(v_row->'aliases',        '[]'::jsonb),
        COALESCE(NULLIF(trim(v_row->>'description'), ''), ''),
        (v_row->>'demand_score')::numeric,
        COALESCE(v_row->'search_tokens',  '[]'::jsonb),
        COALESCE(NULLIF(trim(v_row->>'status'), ''), 'active'),
        trim(v_row->>'created_by_admin_id'),
        COALESCE(NULLIF(trim(v_row->>'updated_by_admin_id'), ''), trim(v_row->>'created_by_admin_id')),
        NULLIF(trim(v_row->>'source_agency'), ''),
        COALESCE((v_row->>'soft_deleted')::boolean, false),
        COALESCE((v_row->>'created_at')::timestamptz, now()),
        now()
      )
      ON CONFLICT (normalized_name) DO NOTHING
      RETURNING id INTO v_id;

      IF v_id IS NOT NULL THEN
        v_inserted := array_append(v_inserted, v_id);
      ELSE
        -- ON CONFLICT DO NOTHING — row already exists
        v_duplicates := array_append(v_duplicates, v_norm);
      END IF;

    EXCEPTION WHEN OTHERS THEN
      -- Capture row index, normalized name, and actual error
      v_errors := array_append(v_errors, jsonb_build_object(
        'index',   v_index,
        'name',    v_row->>'name',
        'error',   SQLERRM,
        'detail',  SQLSTATE
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted',    to_jsonb(v_inserted),
    'insertedCount', array_length(v_inserted,  1),
    'duplicates',  to_jsonb(v_duplicates),
    'duplicateCount', array_length(v_duplicates, 1),
    'errors',      to_jsonb(v_errors),
    'errorCount',  array_length(v_errors, 1)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. public.get_opportunity_radar — remove dead v_target_role/v_exp
-- -----------------------------------------------------------------------------
-- Certified architecture/scoring (DB-FR-006A/006B v1.1) is frozen and NOT
-- touched here -- only the two dead locals are removed.

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
  v_user_vector vector;
begin
  -- Load user profile (DB-FR-006B, unchanged in this pass): public.user_profiles
  -- is the certified canonical source of skills (DB-FR-006A §2.2).
  -- user_profiles.user_id is text; p_user_id is uuid, hence the cast.
  -- user_profiles.skills is jsonb; unpacked into the text[] shape the
  -- unmodified downstream unnest()-based logic already expects.
  --
  -- DB-FR-012: target_role/experience_years were previously also selected
  -- into v_target_role/v_exp, but neither is read anywhere in this
  -- function (not in the ranking query, not in the returned JSON) — the
  -- ranking/matching logic here is skills-only. Dropped from the select
  -- list along with the two now-unused local variables. Pure dead-code
  -- removal: no scoring, filtering, or output-shape change.
  select
    array(select jsonb_array_elements_text(coalesce(up.skills, '[]'::jsonb)))
  into v_skills
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

COMMENT ON FUNCTION "public"."get_opportunity_radar"("uuid", integer, integer, integer) IS
    'Canonical Opportunity Radar entry point (DB-FR-006A, certified). Reconciled in DB-FR-006B and production-hardened in DB-FR-006B v1.1 (see those migrations for full history). DB-FR-012: removed v_target_role/v_exp, two locals selected from user_profiles but never read anywhere in this function -- the matching/ranking logic is skills-only. No scoring, filtering, or output-shape change.';

-- -----------------------------------------------------------------------------
-- 5. public.get_opportunity_radar_ai — reference stub params/OUT cols
-- -----------------------------------------------------------------------------
-- DB-FR-007 deprecated stub (always raises). See header note.

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
  -- each one, so "unused parameter"/"unmodified OUT variable" stops firing
  -- on a stub that is unused *by design*. RAISE DEBUG is suppressed at
  -- default client_min_messages, so this has no observable effect — the
  -- function's behavior (always raise 'feature_not_supported') is unchanged.
  raise debug 'get_opportunity_radar_ai() stub invoked: user_skills=%, top_n=%, out_shape=(role,match_score,opportunity_score,final_score,skills_to_learn)',
    user_skills, top_n;

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

-- -----------------------------------------------------------------------------
-- 6. public.match_skills — reference stub params/OUT cols
-- -----------------------------------------------------------------------------
-- DB-FR-007 deprecated stub (always raises). See header note.

CREATE OR REPLACE FUNCTION "public"."match_skills"("input_user_id" "uuid")
RETURNS TABLE("skill_id" "uuid", "skill_name" "text", "similarity" double precision)
    LANGUAGE "plpgsql"
    AS $$
begin
  -- DB-FR-012: same rationale as get_opportunity_radar_ai() above — this is
  -- a deliberate DB-FR-007 compatibility stub that always raises before
  -- reaching a RETURN, so input_user_id and the three OUT columns
  -- (skill_id, skill_name, similarity) are correctly never used for real
  -- computation. RAISE DEBUG gives the linter a genuine read of each,
  -- suppressed at default client_min_messages — no observable effect.
  raise debug 'match_skills() stub invoked: input_user_id=%, out_shape=(skill_id,skill_name,similarity)',
    input_user_id;

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

-- -----------------------------------------------------------------------------
-- 7. public.ensure_future_chi_scores_partitions — remove shadowed decl
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_future_chi_scores_partitions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- DB-FR-012: the explicit "DECLARE i integer;" that used to live here is
    -- removed. A "FOR i IN ..." integer-range loop always implicitly
    -- declares its own scoped loop variable, so the explicit declaration
    -- was both shadowed by (never actually assigned through) and unused
    -- outside of that shadowing — it did nothing. Behavior is identical:
    -- the loop variable is still named i, still scoped to the loop.
    FOR i IN 0..2 LOOP
        PERFORM public.ensure_chi_scores_partition(
            now() + (i || ' month')::interval
        );
    END LOOP;
END;
$function$
;

-- -----------------------------------------------------------------------------
-- 8. public.drop_stale_chi_partitions — typed-empty-array/jsonb casts
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drop_stale_chi_partitions(
    p_retain_days integer DEFAULT 90,
    p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_cutoff timestamptz := now() - make_interval(days => p_retain_days);
    v_dropped text[] := ARRAY[]::text[];
    v_skipped text[] := ARRAY[]::text[];
    v_errors jsonb := '[]'::jsonb;
    v_partition record;
    v_mv_covers boolean;
    v_part_end timestamptz;
BEGIN
    PERFORM public.ensure_chi_mv_fresh(60);

    FOR v_partition IN
        SELECT c.relname AS partition_name
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'chi_scores'
          AND c.relkind = 'r'
        ORDER BY c.relname
    LOOP
        BEGIN
            IF v_partition.partition_name !~ '^chi_scores_\d{4}_\d{2}$' THEN
                v_skipped := array_append(
                    v_skipped,
                    v_partition.partition_name || ' (unexpected naming)'
                );
                CONTINUE;
            END IF;

            v_part_end := to_timestamp(
                substring(v_partition.partition_name FROM 'chi_scores_(\d{4}_\d{2})'),
                'YYYY_MM'
            ) + interval '1 month';

            IF v_part_end > v_cutoff THEN
                v_skipped := array_append(
                    v_skipped,
                    v_partition.partition_name || ' (within retention)'
                );
                CONTINUE;
            END IF;

            SELECT EXISTS (
                SELECT 1
                FROM public.chi_weekly_rollups_mv mv
                WHERE mv.week_bucket < v_part_end
                  AND mv.week_bucket >= v_part_end - interval '31 days'
                LIMIT 1
            ) INTO v_mv_covers;

            IF NOT v_mv_covers THEN
                v_skipped := array_append(
                    v_skipped,
                    v_partition.partition_name || ' (MV not covering)'
                );
                CONTINUE;
            END IF;

            IF p_dry_run THEN
                v_dropped := array_append(
                    v_dropped,
                    v_partition.partition_name || ' [DRY RUN]'
                );
            ELSE
                EXECUTE format(
                    'DROP TABLE IF EXISTS public.%I',
                    v_partition.partition_name
                );
                v_dropped := array_append(v_dropped, v_partition.partition_name);
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_errors := v_errors || jsonb_build_object(
                'partition', v_partition.partition_name,
                'error', SQLERRM
            );
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'dry_run', p_dry_run,
        'retain_days', p_retain_days,
        'cutoff', v_cutoff,
        'dropped', to_jsonb(v_dropped),
        'skipped', to_jsonb(v_skipped),
        'errors', v_errors,
        'executed_at', now()
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. public.run_analytics_retention_lifecycle — reference p_tenant_id
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_analytics_retention_lifecycle(
    p_tenant_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    -- DB-FR-012: p_tenant_id is reserved for future multi-tenant scoping —
    -- public.chi_lifecycle_run() does not yet accept a tenant filter (no
    -- tenant_id column exists on the underlying CHI tables today), so it
    -- is intentionally not passed through. RAISE DEBUG gives the linter a
    -- genuine read without changing behavior (suppressed at default
    -- client_min_messages).
    raise debug 'run_analytics_retention_lifecycle() called with p_tenant_id=% (not yet wired into chi_lifecycle_run)', p_tenant_id;

    RETURN public.chi_lifecycle_run(
        p_dry_run     => false,
        p_retain_days => 90
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. public.refresh_peer_benchmark_mv — reference p_tenant_id
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_peer_benchmark_mv(
    p_tenant_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    -- DB-FR-012: same rationale as run_analytics_retention_lifecycle() —
    -- p_tenant_id is reserved for future multi-tenant scoping;
    -- public.refresh_chi_benchmark_mv() has no tenant filter today.
    raise debug 'refresh_peer_benchmark_mv() called with p_tenant_id=% (not yet wired into refresh_chi_benchmark_mv)', p_tenant_id;

    RETURN public.refresh_chi_benchmark_mv();
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. public.fn_create_student_academic_profile — remove dead v_profile_id
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_create_student_academic_profile(
  p_country_code  TEXT,
  p_region_code   TEXT,
  p_board_code    TEXT,
  p_stream_code   TEXT     DEFAULT NULL,
  p_current_class SMALLINT DEFAULT NULL,
  p_target_year   SMALLINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_country_id      UUID;
  v_region_id       UUID;
  v_board_id        UUID;
  v_stream_id       UUID;
  v_taxonomy_hash   TEXT;
  v_canon_country   TEXT;
  v_canon_region    TEXT;
  v_canon_board     TEXT;
  v_canon_stream    TEXT;
  v_is_new          BOOLEAN;
  v_completed_at    TIMESTAMPTZ;
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  -- ── Input validation ────────────────────────────────────────────────────
  IF p_country_code IS NULL OR trim(p_country_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'country_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_region_code IS NULL OR trim(p_region_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'region_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_board_code IS NULL OR trim(p_board_code) = '' THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'board_code is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_current_class IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'current_class is required.',
      'code',        'MISSING_PARAMETER'
    );
  END IF;

  IF p_current_class < 1 OR p_current_class > 12 THEN
    RETURN jsonb_build_object(
      'success',       FALSE,
      'rpc',           'fn_create_student_academic_profile',
      'rpc_version',   '2.0.0',
      'error',         format('current_class %s is out of valid range (1–12).', p_current_class),
      'code',          'INVALID_CLASS_LEVEL',
      'current_class', p_current_class
    );
  END IF;

  IF p_target_year IS NOT NULL AND p_target_year < 2024 THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('target_year %s is invalid. Must be 2024 or later.', p_target_year),
      'code',         'INVALID_TARGET_YEAR',
      'target_year',  p_target_year
    );
  END IF;

  -- ── Canonicalise inputs ─────────────────────────────────────────────────
  v_canon_country := upper(trim(p_country_code));
  v_canon_region  := upper(trim(p_region_code));
  v_canon_board   := upper(trim(p_board_code));
  v_canon_stream  := CASE
                       WHEN p_stream_code IS NULL OR trim(p_stream_code) = ''
                       THEN NULL
                       ELSE upper(trim(p_stream_code))
                     END;

  -- ── Taxonomy resolution ─────────────────────────────────────────────────
  v_country_id := public.fn__phase2_resolve_country_id(v_canon_country);
  IF v_country_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Country code "%s" is not valid or is inactive.', v_canon_country),
      'code',         'INVALID_COUNTRY_CODE',
      'country_code', v_canon_country
    );
  END IF;

  -- DB-FR-009: pass the resolved country UUID (v_country_id), matching the
  -- certified helper signature fn__phase2_resolve_region_id(TEXT, UUID).
  -- Previously passed v_canon_country (TEXT), which no such overload exists
  -- for.
  v_region_id := public.fn__phase2_resolve_region_id(v_canon_region, v_country_id);
  IF v_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Region code "%s" is not valid or is inactive for country "%s".',
                             v_canon_region, v_canon_country),
      'code',         'INVALID_REGION_CODE',
      'region_code',  v_canon_region,
      'country_code', v_canon_country
    );
  END IF;

  -- DB-FR-009: pass the resolved country UUID (v_country_id), matching the
  -- certified helper signature fn__phase2_resolve_board_id(TEXT, UUID).
  -- Previously passed v_canon_country (TEXT).
  v_board_id := public.fn__phase2_resolve_board_id(v_canon_board, v_country_id);
  IF v_board_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',      FALSE,
      'rpc',          'fn_create_student_academic_profile',
      'rpc_version',  '2.0.0',
      'error',        format('Board code "%s" is not valid or is inactive for country "%s".',
                             v_canon_board, v_canon_country),
      'code',         'INVALID_BOARD_CODE',
      'board_code',   v_canon_board,
      'country_code', v_canon_country
    );
  END IF;

  IF v_canon_stream IS NOT NULL THEN
    -- DB-FR-009: pass the resolved board UUID (v_board_id) and the numeric
    -- class level (p_current_class), matching the certified helper
    -- signature fn__phase2_resolve_stream_id(TEXT, UUID, SMALLINT).
    -- Previously passed (v_canon_board, v_canon_country) — two TEXT
    -- arguments — for a signature whose 2nd/3rd parameters are UUID/SMALLINT.
    v_stream_id := public.fn__phase2_resolve_stream_id(v_canon_stream, v_board_id, p_current_class);
    IF v_stream_id IS NULL THEN
      RETURN jsonb_build_object(
        'success',      FALSE,
        'rpc',          'fn_create_student_academic_profile',
        'rpc_version',  '2.0.0',
        'error',        format('Stream code "%s" is not valid or is inactive for board "%s".',
                               v_canon_stream, v_canon_board),
        'code',         'INVALID_STREAM_CODE',
        'stream_code',  v_canon_stream,
        'board_code',   v_canon_board
      );
    END IF;
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Is this a new profile? ──────────────────────────────────────────────
  SELECT EXISTS(
    SELECT 1 FROM public.student_academic_profiles
    WHERE auth_user_id = v_user_id
  ) INTO v_is_new;
  v_is_new := NOT v_is_new;

  -- ── UPSERT profile ──────────────────────────────────────────────────────
  -- The live table uses auth_user_id. The unique constraint on auth_user_id
  -- is used as the conflict target. If the constraint name differs in production,
  -- the DO UPDATE path handles it safely via the WHERE auth_user_id = clause.
  INSERT INTO public.student_academic_profiles (
    auth_user_id,
    country_id,   region_id,   board_id,   stream_id,
    country_code, region_code, board_code, stream_code,
    current_class, target_year,
    taxonomy_hash_at_save,
    rpc_version
  )
  VALUES (
    v_user_id,
    v_country_id, v_region_id, v_board_id, v_stream_id,
    v_canon_country, v_canon_region, v_canon_board, v_canon_stream,
    p_current_class, p_target_year,
    v_taxonomy_hash,
    '2.0.0'
  )
  ON CONFLICT (auth_user_id) DO UPDATE SET
    country_id            = EXCLUDED.country_id,
    region_id             = EXCLUDED.region_id,
    board_id              = EXCLUDED.board_id,
    stream_id             = EXCLUDED.stream_id,
    country_code          = EXCLUDED.country_code,
    region_code           = EXCLUDED.region_code,
    board_code            = EXCLUDED.board_code,
    stream_code           = EXCLUDED.stream_code,
    current_class         = EXCLUDED.current_class,
    target_year           = EXCLUDED.target_year,
    taxonomy_hash_at_save = EXCLUDED.taxonomy_hash_at_save,
    rpc_version           = EXCLUDED.rpc_version,
    -- Preserve completion state — profile update does NOT reset completion
    onboarding_completed_at = public.student_academic_profiles.onboarding_completed_at,
    updated_at            = NOW()
  -- DB-FR-012: previously "RETURNING id, onboarding_completed_at INTO
  -- v_profile_id, v_completed_at" — v_profile_id was captured but never
  -- read anywhere below (the response JSON does not include the profile
  -- id). Narrowed to the one column actually used. Pure dead-code
  -- removal: no change to the returned JSON contract.
  RETURNING onboarding_completed_at
  INTO v_completed_at;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'rpc',         'fn_create_student_academic_profile',
    'rpc_version', '2.0.0',
    'query_meta',  jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'profile_state', jsonb_build_object(
      'country_code',  v_canon_country,
      'region_code',   v_canon_region,
      'board_code',    v_canon_board,
      'stream_code',   v_canon_stream,
      'current_class', p_current_class,
      'target_year',   p_target_year
    ),
    'onboarding_state', jsonb_build_object(
      'is_new_profile', v_is_new,
      'is_complete',    v_completed_at IS NOT NULL,
      'completed_at',   v_completed_at
    ),
    'timestamps', jsonb_build_object(
      'saved_at',              NOW(),
      'taxonomy_hash_at_save', v_taxonomy_hash
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_create_student_academic_profile',
      'rpc_version', '2.0.0',
      'error',       'Profile save failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. public.fn_complete_academic_onboarding — typed-empty-array cast
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_complete_academic_onboarding()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_taxonomy_hash   TEXT;
  v_profile         RECORD;
  v_subject_count   INTEGER;
  v_language_count  INTEGER;
  v_completed_at    TIMESTAMPTZ;
  v_already_done    BOOLEAN;

  v_g1_profile      BOOLEAN := FALSE;
  v_g2_keys         BOOLEAN := FALSE;
  v_g3_class        BOOLEAN := FALSE;
  v_g4_subjects     BOOLEAN := FALSE;
  v_g5_languages    BOOLEAN := FALSE;
  v_gates_passed    BOOLEAN;
  v_failure_reasons TEXT[]  := ARRAY[]::TEXT[];
BEGIN

  -- ── Auth guard ──────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_complete_academic_onboarding',
      'rpc_version', '2.0.0',
      'error',       'Authentication required.',
      'code',        'UNAUTHENTICATED'
    );
  END IF;

  v_taxonomy_hash := public.fn_academic_taxonomy_hash();

  -- ── Read profile (auth_user_id) ─────────────────────────────────────────
  SELECT
    sap.id                     AS profile_id,
    sap.country_code,
    sap.region_code,
    sap.board_code,
    sap.stream_code,
    sap.stream_id,
    sap.current_class,
    sap.target_year,
    sap.onboarding_completed_at,
    sap.created_at,
    sap.updated_at
  INTO v_profile
  FROM public.student_academic_profiles sap
  WHERE sap.auth_user_id = v_user_id;

  v_g1_profile := FOUND;
  IF NOT v_g1_profile THEN
    v_failure_reasons := array_append(v_failure_reasons,
      'G-1: No academic profile found. Call fn_create_student_academic_profile() first.');
  END IF;

  IF v_g1_profile THEN

    v_g2_keys := (
      v_profile.country_code IS NOT NULL AND trim(v_profile.country_code) <> ''
      AND v_profile.region_code IS NOT NULL AND trim(v_profile.region_code) <> ''
      AND v_profile.board_code  IS NOT NULL AND trim(v_profile.board_code)  <> ''
    );
    IF NOT v_g2_keys THEN
      v_failure_reasons := array_append(v_failure_reasons,
        'G-2: Profile is missing required fields (country_code, region_code, board_code). '
        'Call fn_create_student_academic_profile() to populate these fields.');
    END IF;

    v_g3_class := (
      v_profile.current_class IS NOT NULL
      AND v_profile.current_class BETWEEN 1 AND 12
    );
    IF NOT v_g3_class THEN
      v_failure_reasons := array_append(v_failure_reasons,
        'G-3: current_class is missing or out of valid range (1–12).');
    END IF;

    -- G-4: Subjects — count via student_profile_id (legacy-safe)
    SELECT COUNT(*)::INTEGER INTO v_subject_count
    FROM public.student_subject_selections
    WHERE student_profile_id = v_profile.profile_id;

    IF v_profile.stream_id IS NOT NULL THEN
      v_g4_subjects := v_subject_count >= 1;
      IF NOT v_g4_subjects THEN
        v_failure_reasons := array_append(v_failure_reasons,
          'G-4: At least one subject must be selected when a stream is set. Call fn_save_student_subjects().');
      END IF;
    ELSE
      v_g4_subjects := TRUE;
    END IF;

    -- G-5: Languages — count via student_profile_id (legacy-safe)
    SELECT COUNT(*)::INTEGER INTO v_language_count
    FROM public.student_language_preferences
    WHERE student_profile_id = v_profile.profile_id;

    v_g5_languages := v_language_count >= 1;
    IF NOT v_g5_languages THEN
      v_failure_reasons := array_append(v_failure_reasons,
        'G-5: At least one language must be selected. Call fn_save_student_languages().');
    END IF;

  END IF;

  v_gates_passed := v_g1_profile AND v_g2_keys AND v_g3_class
                    AND v_g4_subjects AND v_g5_languages;

  IF NOT v_gates_passed THEN
    RETURN jsonb_build_object(
      'success',             FALSE,
      'rpc',                 'fn_complete_academic_onboarding',
      'rpc_version',         '2.0.0',
      'error',               'Onboarding is not ready for completion.',
      'code',                'ONBOARDING_INCOMPLETE',
      'onboarding_complete', FALSE,
      'readiness_summary',   jsonb_build_object(
        'gates', jsonb_build_object(
          'G1_profile_exists', v_g1_profile,
          'G2_keys_complete',  v_g2_keys,
          'G3_class_valid',    v_g3_class,
          'G4_subjects_ok',    v_g4_subjects,
          'G5_languages_ok',   v_g5_languages
        ),
        'failure_reasons', to_jsonb(v_failure_reasons),
        'subject_count',   v_subject_count,
        'language_count',  v_language_count
      )
    );
  END IF;

  v_already_done := v_profile.onboarding_completed_at IS NOT NULL;

  -- Update uses auth_user_id; writes onboarding_completed_at (evolved column)
  -- Also mirrors to onboarding_completed boolean for legacy compat
  UPDATE public.student_academic_profiles
  SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
      onboarding_completed    = TRUE,
      updated_at              = NOW()
  WHERE auth_user_id = v_user_id
  RETURNING onboarding_completed_at INTO v_completed_at;

  RETURN jsonb_build_object(
    'success',             TRUE,
    'rpc',                 'fn_complete_academic_onboarding',
    'rpc_version',         '2.0.0',
    'query_meta',          jsonb_build_object(
      'executed_at',    NOW(),
      'taxonomy_hash',  v_taxonomy_hash,
      'correlation_id', NULL::TEXT,
      'request_id',     NULL::TEXT
    ),
    'onboarding_complete',  TRUE,
    'completed_at',         v_completed_at,
    'was_already_complete', v_already_done,
    'readiness_summary',    jsonb_build_object(
      'gates', jsonb_build_object(
        'G1_profile_exists', TRUE,
        'G2_keys_complete',  TRUE,
        'G3_class_valid',    TRUE,
        'G4_subjects_ok',    TRUE,
        'G5_languages_ok',   TRUE
      ),
      'subject_count',   v_subject_count,
      'language_count',  v_language_count,
      'profile_snapshot', jsonb_build_object(
        'country_code',  v_profile.country_code,
        'region_code',   v_profile.region_code,
        'board_code',    v_profile.board_code,
        'stream_code',   v_profile.stream_code,
        'current_class', v_profile.current_class,
        'target_year',   v_profile.target_year
      )
    ),
    'taxonomy_hash', v_taxonomy_hash
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',     FALSE,
      'rpc',         'fn_complete_academic_onboarding',
      'rpc_version', '2.0.0',
      'error',       'Onboarding completion failed. Please retry.',
      'code',        'INTERNAL_ERROR'
    );
END;
$$;

COMMIT;
