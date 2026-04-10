


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;





ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."alert_severity" AS ENUM (
    'WARNING',
    'CRITICAL'
);


ALTER TYPE "public"."alert_severity" OWNER TO "postgres";


CREATE TYPE "public"."approve_pending_result" AS (
	"success" boolean,
	"live_id" "uuid",
	"live_table" "text",
	"pending_id" "uuid"
);


ALTER TYPE "public"."approve_pending_result" OWNER TO "postgres";


CREATE TYPE "public"."proficiency_level" AS ENUM (
    'beginner',
    'intermediate',
    'advanced',
    'expert'
);


ALTER TYPE "public"."proficiency_level" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."acquire_sync_lock"("p_lock_key" "text", "p_instance_id" "text", "p_stale_cutoff" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_row      sync_locks%ROWTYPE;
  v_acquired sync_locks%ROWTYPE;
BEGIN

  -- Ensure a row exists for this lock_key so we always have
  -- something to SELECT FOR UPDATE against.
  INSERT INTO sync_locks (lock_id, status, locked_by, locked_at, released_at, expires_at, updated_at)
  VALUES (p_lock_key, 'idle', NULL, NULL, NULL, NULL, now())
  ON CONFLICT (lock_id) DO NOTHING;

  -- Grab an exclusive row-level lock — blocks concurrent transactions
  -- attempting to acquire the same lock_key simultaneously.
  SELECT * INTO v_row
  FROM sync_locks
  WHERE lock_id = p_lock_key
  FOR UPDATE;

  -- Case 1: idle — available for acquisition
  IF v_row.status = 'idle' THEN
    UPDATE sync_locks SET
      status      = 'running',
      locked_by   = p_instance_id,
      locked_at   = now(),
      released_at = NULL,
      expires_at  = now() + INTERVAL '15 minutes',
      updated_at  = now()
    WHERE lock_id = p_lock_key
    RETURNING * INTO v_acquired;

    RETURN to_jsonb(v_acquired);
  END IF;

  -- Case 2: running but stale — previous holder crashed or timed out
  IF v_row.status = 'running' AND v_row.locked_at < p_stale_cutoff THEN
    UPDATE sync_locks SET
      status      = 'running',
      locked_by   = p_instance_id,
      locked_at   = now(),
      released_at = NULL,
      expires_at  = now() + INTERVAL '15 minutes',
      updated_at  = now()
    WHERE lock_id = p_lock_key
    RETURNING * INTO v_acquired;

    RETURN to_jsonb(v_acquired);
  END IF;

  -- Case 3: running and NOT stale — active lock held by another instance
  RETURN NULL;

END;
$$;


ALTER FUNCTION "public"."acquire_sync_lock"("p_lock_key" "text", "p_instance_id" "text", "p_stale_cutoff" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."activate_subscription_tx"("p_user_id" "text", "p_tier" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_credits" integer, "p_subscription_id" "text", "p_provider" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone, "p_expires_at" timestamp with time zone) RETURNS TABLE("out_success" boolean, "out_user_id" "text", "out_tier" "text", "out_expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id       UUID;
  v_subscription_row_id TEXT;
BEGIN

  v_user_id             := p_user_id::UUID;
  v_subscription_row_id := gen_random_uuid()::TEXT;

  -- --------------------------------------------------------
  -- GUARD: Idempotency
  -- --------------------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM public.subscription_events
    WHERE idempotency_key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'DUPLICATE_EVENT: idempotency_key already processed: %',
      p_idempotency_key
      USING ERRCODE = 'unique_violation';
  END IF;

  -- --------------------------------------------------------
  -- WRITE A: Update users
  -- --------------------------------------------------------
  UPDATE public.users
  SET
    tier                  = p_tier,
    plan_amount           = p_plan_amount,
    subscription_id       = p_subscription_id,
    subscription_provider = p_provider,
    subscription_status   = 'active',
    ai_credits_remaining  = p_credits,
    updated_at            = p_now
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'USER_NOT_FOUND: No user exists with id: %',
      p_user_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- --------------------------------------------------------
  -- WRITE B: Upsert subscriptions
  -- id supplied explicitly — no default exists on this column
  -- ON CONFLICT preserves existing id, only updates fields
  -- --------------------------------------------------------
  INSERT INTO public.subscriptions (
    id,
    user_id,
    tier,
    status,
    plan_amount,
    plan_currency,
    ai_credits_allocated,
    ai_credits_remaining,
    subscription_id,
    provider,
    activated_at,
    expires_at,
    cancelled_at,
    current_period_start,
    current_period_end,
    auto_renew,
    trial_ends_at,
    updated_at
  )
  VALUES (
    v_subscription_row_id,
    p_user_id,
    p_tier,
    'active',
    p_plan_amount,
    p_plan_currency,
    p_credits,
    p_credits,
    p_subscription_id,
    p_provider,
    p_now,
    p_expires_at,
    NULL,
    p_now,
    p_expires_at,
    FALSE,
    NULL,
    p_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    tier                 = EXCLUDED.tier,
    status               = 'active',
    plan_amount          = EXCLUDED.plan_amount,
    plan_currency        = EXCLUDED.plan_currency,
    ai_credits_allocated = EXCLUDED.ai_credits_allocated,
    ai_credits_remaining = EXCLUDED.ai_credits_remaining,
    subscription_id      = EXCLUDED.subscription_id,
    provider             = EXCLUDED.provider,
    activated_at         = EXCLUDED.activated_at,
    expires_at           = EXCLUDED.expires_at,
    cancelled_at         = NULL,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end   = EXCLUDED.current_period_end,
    auto_renew           = FALSE,
    trial_ends_at        = NULL,
    updated_at           = EXCLUDED.updated_at;
  -- NOTE: id is intentionally excluded from DO UPDATE SET
  -- to preserve the original row id on re-activation

  -- --------------------------------------------------------
  -- WRITE C: Insert subscription_events
  -- --------------------------------------------------------
  INSERT INTO public.subscription_events (
    user_id,
    event_type,
    provider,
    external_event_id,
    plan_amount,
    plan_currency,
    credits_granted,
    previous_tier,
    new_tier,
    metadata,
    idempotency_key,
    created_at
  )
  VALUES (
    p_user_id,
    'activated',
    p_provider,
    p_external_event_id,
    p_plan_amount,
    p_plan_currency,
    p_credits,
    p_previous_tier,
    p_tier,
    jsonb_build_object('subscription_id', p_subscription_id),
    p_idempotency_key,
    p_now
  );

  -- --------------------------------------------------------
  -- RETURN
  -- --------------------------------------------------------
  RETURN QUERY
  SELECT TRUE, p_user_id, p_tier, p_expires_at;

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION
      'DUPLICATE_EVENT: idempotency_key already processed: %',
      p_idempotency_key
      USING ERRCODE = 'unique_violation';

  WHEN no_data_found THEN
    RAISE EXCEPTION
      'USER_NOT_FOUND: No user exists with id: %',
      p_user_id
      USING ERRCODE = 'no_data_found';

  WHEN OTHERS THEN
    RAISE EXCEPTION
      'BILLING_TX_ERROR [%]: %',
      SQLSTATE, SQLERRM
      USING ERRCODE = SQLSTATE;

END;
$$;


ALTER FUNCTION "public"."activate_subscription_tx"("p_user_id" "text", "p_tier" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_credits" integer, "p_subscription_id" "text", "p_provider" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_skills_to_profile"("p_user_id" "text", "p_skills" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_now                  TIMESTAMPTZ := now();
  v_existing_user_skills JSONB;
  v_existing_set         TEXT[];
  v_to_add               TEXT[];
  v_merged_user_skills   JSONB;
  v_existing_prof_skills JSONB;
  v_new_skill_objects    JSONB;
  v_merged_prof_skills   JSONB;
  v_new_skill_count      INT;
  v_new_id               TEXT := gen_random_uuid()::text;
BEGIN

  IF p_skills IS NULL OR array_length(p_skills, 1) IS NULL THEN
    RETURN jsonb_build_object('added', 0, 'skills', '[]'::jsonb);
  END IF;

  SELECT skills INTO v_existing_user_skills
  FROM public.users
  WHERE id = p_user_id::uuid
  FOR UPDATE;

  v_existing_user_skills := COALESCE(v_existing_user_skills, '[]'::jsonb);

  SELECT array_agg(lower(trim(
    CASE jsonb_typeof(elem)
      WHEN 'string' THEN elem #>> '{}'
      ELSE elem ->> 'name'
    END
  )))
  INTO v_existing_set
  FROM jsonb_array_elements(v_existing_user_skills) AS elem
  WHERE (
    CASE jsonb_typeof(elem)
      WHEN 'string' THEN elem #>> '{}'
      ELSE elem ->> 'name'
    END
  ) IS NOT NULL;

  v_existing_set := COALESCE(v_existing_set, ARRAY[]::TEXT[]);

  SELECT array_agg(DISTINCT lower(trim(s)) ORDER BY lower(trim(s)))
  INTO v_to_add
  FROM unnest(p_skills) AS s
  WHERE trim(s) <> ''
    AND lower(trim(s)) <> ALL(v_existing_set);

  IF v_to_add IS NULL OR array_length(v_to_add, 1) IS NULL THEN
    RETURN jsonb_build_object('added', 0, 'skills', '[]'::jsonb);
  END IF;

  SELECT v_existing_user_skills || jsonb_agg(to_jsonb(s))
  INTO v_merged_user_skills
  FROM unnest(v_to_add) AS s;

  UPDATE public.users
  SET skills = v_merged_user_skills, updated_at = v_now
  WHERE id = p_user_id::uuid;

  SELECT skills INTO v_existing_prof_skills
  FROM public.user_profiles
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_existing_prof_skills := COALESCE(v_existing_prof_skills, '[]'::jsonb);

  SELECT jsonb_agg(jsonb_build_object(
    'name', s, 'proficiency', 'beginner', 'addedAt', v_now
  ))
  INTO v_new_skill_objects
  FROM unnest(v_to_add) AS s;

  v_merged_prof_skills := v_existing_prof_skills || COALESCE(v_new_skill_objects, '[]'::jsonb);
  v_new_skill_count    := jsonb_array_length(v_merged_prof_skills);

  INSERT INTO public.user_profiles (id, user_id, skills, skill_count, updated_at)
  VALUES (v_new_id, p_user_id, v_merged_prof_skills, v_new_skill_count, v_now)
  ON CONFLICT (user_id) DO UPDATE
    SET skills      = EXCLUDED.skills,
        skill_count = EXCLUDED.skill_count,
        updated_at  = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'added',  array_length(v_to_add, 1),
    'skills', to_jsonb(v_to_add)
  );

END;
$$;


ALTER FUNCTION "public"."add_skills_to_profile"("p_user_id" "text", "p_skills" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."aggregate_daily_metrics"("start_date" timestamp with time zone, "end_date" timestamp with time zone) RETURNS TABLE("total_requests" bigint, "total_tokens" bigint, "total_cost_usd" numeric, "total_revenue_usd" numeric, "active_users" bigint, "paid_user_count" bigint, "free_tier_cost_usd" numeric, "paid_tier_cost_usd" numeric, "gross_margin_usd" numeric, "gross_margin_percent" numeric, "feature_counts" "jsonb")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
SELECT
  COUNT(*) AS total_requests,
  COALESCE(SUM(total_tokens), 0),
  COALESCE(SUM(cost_usd), 0),
  COALESCE(SUM(revenue_usd), 0),
  COUNT(DISTINCT user_id) AS active_users,
  COUNT(DISTINCT CASE WHEN tier != 'free' THEN user_id END) AS paid_user_count,
  COALESCE(SUM(CASE WHEN tier = 'free' THEN cost_usd ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN tier != 'free' THEN cost_usd ELSE 0 END), 0),
  COALESCE(SUM(revenue_usd) - SUM(cost_usd), 0) AS gross_margin_usd,
  CASE
    WHEN SUM(revenue_usd) > 0
    THEN (SUM(revenue_usd) - SUM(cost_usd)) / SUM(revenue_usd) * 100
    ELSE 0
  END AS gross_margin_percent,
  (
    SELECT jsonb_object_agg(feature, count)
    FROM (
      SELECT feature, COUNT(*) as count
      FROM usage_logs
      WHERE created_at BETWEEN start_date AND end_date
      GROUP BY feature
    ) f
  ) AS feature_counts
FROM usage_logs
WHERE created_at BETWEEN start_date AND end_date;
$$;


ALTER FUNCTION "public"."aggregate_daily_metrics"("start_date" timestamp with time zone, "end_date" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_pending_entry_transaction"("p_pending_id" "uuid", "p_admin_uid" "text") RETURNS "public"."approve_pending_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_entry         public.pending_entries%ROWTYPE;
  v_live_table    TEXT;
  v_live_id       UUID;
  v_payload       JSONB;
  v_now           TIMESTAMPTZ := now();
  v_result        public.approve_pending_result;
BEGIN

  -- ── 3a. Lock the pending row (concurrency protection) ─────
  --   NOWAIT raises 55P03 immediately if another transaction holds
  --   the lock, preventing silent queuing and double-approvals.
  SELECT *
    INTO v_entry
    FROM public.pending_entries
   WHERE id = p_pending_id
     FOR UPDATE NOWAIT;

  -- ── 3b. Existence check ───────────────────────────────────
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PENDING_NOT_FOUND: No pending entry with id %', p_pending_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── 3c. Idempotency / double-approval guard ───────────────
  IF v_entry.status <> 'pending' THEN
    RAISE EXCEPTION 'ALREADY_REVIEWED: Entry % has status "%"', p_pending_id, v_entry.status
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 3d. Entity-type → live table mapping ─────────────────
  v_live_table := CASE v_entry.entity_type
    WHEN 'skill'            THEN 'cms_skills'
    WHEN 'role'             THEN 'cms_roles'
    WHEN 'jobFamily'        THEN 'cms_job_families'
    WHEN 'educationLevel'   THEN 'cms_education_levels'
    WHEN 'salaryBenchmark'  THEN 'cms_salary_benchmarks'
    ELSE NULL
  END;

  IF v_live_table IS NULL THEN
    RAISE EXCEPTION 'INVALID_ENTITY_TYPE: Unsupported entity_type "%"', v_entry.entity_type
      USING ERRCODE = 'P0003';
  END IF;

  -- ── 3e. Build enriched payload ────────────────────────────
  --   Strip any caller-supplied server-controlled fields first,
  --   then layer on the correct server-set values. This prevents
  --   payload smuggling via the submitted JSON.
  v_payload := v_entry.payload
    - 'id'
    - 'created_by_admin_id'
    - 'updated_by_admin_id'
    - 'approved_from_pending_id'
    - 'soft_deleted'
    - 'status'
    - 'normalized_name'
    || jsonb_build_object(
         'normalized_name',          public.normalize_text(v_entry.payload->>'name'),
         'created_by_admin_id',      p_admin_uid,
         'updated_by_admin_id',      p_admin_uid,
         'approved_from_pending_id', p_pending_id,
         'soft_deleted',             false,
         'status',                   'active'
       );

  -- ── 3f. Dynamic INSERT into the correct live table ────────
  --   %I quotes the table name safely. USING passes the payload
  --   as a parameter — no string interpolation of user data.
  EXECUTE format(
    'INSERT INTO public.%I
       SELECT (jsonb_populate_record(null::public.%I, $1)).*
       RETURNING id',
    v_live_table,
    v_live_table
  )
  USING v_payload
  INTO v_live_id;

  IF v_live_id IS NULL THEN
    RAISE EXCEPTION 'LIVE_INSERT_FAILED: INSERT into % returned no id', v_live_table
      USING ERRCODE = 'P0004';
  END IF;

  -- ── 3g. Mark pending row as approved ─────────────────────
  UPDATE public.pending_entries
     SET status      = 'approved',
         reviewed_by = p_admin_uid,
         reviewed_at = v_now,
         live_id     = v_live_id
   WHERE id = p_pending_id;

  -- ── 3h. Return result ─────────────────────────────────────
  v_result.success    := true;
  v_result.live_id    := v_live_id;
  v_result.live_table := v_live_table;
  v_result.pending_id := p_pending_id;

  RETURN v_result;

  -- Any unhandled exception propagates up; Postgres rolls back
  -- the entire transaction automatically.
END;
$_$;


ALTER FUNCTION "public"."approve_pending_entry_transaction"("p_pending_id" "uuid", "p_admin_uid" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."autocomplete_roles"("p_query" "text", "p_agency" "text", "p_limit" integer DEFAULT 10) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  v_query     text;
  v_limit     int;
  v_roles     jsonb;
  v_threshold constant numeric := 0.2;
BEGIN

  v_query := immutable_unaccent(lower(trim(p_query)));

  IF p_agency IS NULL OR trim(p_agency) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: agency is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_query IS NULL OR length(v_query) < 2 THEN
    RETURN jsonb_build_object(
      'success', true,
      'data',    '[]'::jsonb
    );
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 20);

  PERFORM set_limit(v_threshold);

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
  INTO v_roles
  FROM (
    SELECT
      role_id,
      role_name,
      role_family,
      composite_key,
      agency,
      ROUND(
        (
          similarity(immutable_unaccent(lower(role_name)), v_query) * 0.7 +
          similarity(immutable_unaccent(lower(composite_key)), v_query) * 0.3
        )::numeric, 4
      ) AS similarity_score,
      CASE
        WHEN immutable_unaccent(lower(role_name)) LIKE v_query || '%' THEN 1
        ELSE 0
      END AS is_prefix

    FROM roles
    WHERE soft_deleted = false
      AND agency       = p_agency
      AND (
        -- Strict prefix match (starts with query) — always included
        immutable_unaccent(lower(role_name)) LIKE v_query || '%'

        OR

        -- Fuzzy match — only if similarity exceeds threshold
        (
          immutable_unaccent(lower(role_name)) % v_query
          AND similarity(immutable_unaccent(lower(role_name)), v_query) > v_threshold
        )

        OR

        -- Composite key fuzzy — only if similarity exceeds threshold
        (
          immutable_unaccent(lower(composite_key)) % v_query
          AND similarity(immutable_unaccent(lower(composite_key)), v_query) > v_threshold
        )
      )

    ORDER BY
      is_prefix         DESC,
      similarity_score  DESC,
      length(role_name) ASC

    LIMIT v_limit
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'data',    v_roles
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'autocomplete_roles failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."autocomplete_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bulk_import_dataset"("p_dataset" "text", "p_rows" "jsonb", "p_admin_id" "uuid", "p_agency" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_total int := jsonb_array_length(p_rows);

  v_inserted_ids uuid[] := '{}';
  v_duplicate_names text[] := '{}';
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


ALTER FUNCTION "public"."bulk_import_dataset"("p_dataset" "text", "p_rows" "jsonb", "p_admin_id" "uuid", "p_agency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_inserted      BIGINT := 0;
    v_updated       BIGINT := 0;
    v_total         BIGINT := 0;
    v_existing      BIGINT := 0;
    v_rows_affected BIGINT := 0;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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

            GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
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


ALTER FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bulk_import_skills"("p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_row         jsonb;
  v_id          uuid;
  v_norm        text;
  v_inserted    uuid[]  := '{}';
  v_duplicates  text[]  := '{}';
  v_errors      jsonb[] := '{}';
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


ALTER FUNCTION "public"."bulk_import_skills"("p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_subscription_tx"("p_user_id" "text", "p_provider" "text", "p_subscription_id" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_reason" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone) RETURNS TABLE("out_success" boolean, "out_user_id" "text", "out_new_tier" "text", "out_cancelled_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id   UUID;
  v_event_type TEXT;
BEGIN

  -- Cast once, reuse everywhere — avoids uuid = text ambiguity
  v_user_id := p_user_id::UUID;

  -- Derive event_type from reason
  v_event_type := CASE p_reason
    WHEN 'refund'  THEN 'refunded'
    WHEN 'expired' THEN 'expired'
    ELSE                'cancelled'
  END;

  -- --------------------------------------------------------
  -- GUARD: Idempotency — fast path before any writes
  -- --------------------------------------------------------
  IF EXISTS (
    SELECT 1
    FROM public.subscription_events
    WHERE idempotency_key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'DUPLICATE_EVENT: idempotency_key already processed: %',
      p_idempotency_key
      USING ERRCODE = 'unique_violation';
  END IF;

  -- --------------------------------------------------------
  -- WRITE A: Update users
  -- --------------------------------------------------------
  UPDATE public.users
  SET
    tier                 = 'free',
    subscription_status  = 'cancelled',
    ai_credits_remaining = 0,
    updated_at           = p_now
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'USER_NOT_FOUND: No user exists with id: %',
      p_user_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- --------------------------------------------------------
  -- WRITE B: Update subscriptions
  -- No NOT FOUND guard here — a user may have been downgraded
  -- already without a subscriptions row existing (edge case).
  -- The users write above is the authoritative state change.
  -- --------------------------------------------------------
  UPDATE public.subscriptions
  SET
    status       = 'cancelled',
    tier         = 'free',
    cancelled_at = p_now,
    updated_at   = p_now
  WHERE user_id = p_user_id;

  -- --------------------------------------------------------
  -- WRITE C: Insert subscription_events (immutable audit log)
  -- --------------------------------------------------------
  INSERT INTO public.subscription_events (
    user_id,
    event_type,
    provider,
    external_event_id,
    plan_amount,
    plan_currency,
    credits_granted,
    previous_tier,
    new_tier,
    metadata,
    idempotency_key,
    created_at
  )
  VALUES (
    p_user_id,
    v_event_type,
    p_provider,
    p_external_event_id,
    p_plan_amount,
    p_plan_currency,
    0,
    p_previous_tier,
    'free',
    jsonb_build_object(
      'subscriptionId', p_subscription_id,
      'reason',         p_reason
    ),
    p_idempotency_key,
    p_now
  );

  -- --------------------------------------------------------
  -- RETURN
  -- --------------------------------------------------------
  RETURN QUERY
  SELECT TRUE, p_user_id, 'free'::TEXT, p_now;

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION
      'DUPLICATE_EVENT: idempotency_key already processed: %',
      p_idempotency_key
      USING ERRCODE = 'unique_violation';

  WHEN no_data_found THEN
    RAISE EXCEPTION
      'USER_NOT_FOUND: No user exists with id: %',
      p_user_id
      USING ERRCODE = 'no_data_found';

  WHEN OTHERS THEN
    RAISE EXCEPTION
      'BILLING_TX_ERROR [%]: %',
      SQLSTATE, SQLERRM
      USING ERRCODE = SQLSTATE;

END;
$$;


ALTER FUNCTION "public"."cancel_subscription_tx"("p_user_id" "text", "p_provider" "text", "p_subscription_id" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_reason" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_and_increment_ai_usage"("p_user_id" "uuid", "p_limit" integer, "p_now" timestamp with time zone, "p_next_reset" timestamp with time zone) RETURNS json
    LANGUAGE "plpgsql"
    AS $$
declare
  current_count int;
  reset_date timestamptz;
  new_count int;
begin
  -- lock row
  select monthly_ai_usage_count, ai_usage_reset_date
  into current_count, reset_date
  from user_profiles
  where id = p_user_id
  for update;

  if not found then
    current_count := 0;
    reset_date := p_next_reset;

    insert into user_profiles (id, monthly_ai_usage_count, ai_usage_reset_date)
    values (p_user_id, 0, p_next_reset);
  end if;

  if reset_date is null or p_now >= reset_date then
    current_count := 0;
    reset_date := p_next_reset;
  end if;

  if current_count >= p_limit then
    return json_build_object(
      'allowed', false,
      'current_count', current_count,
      'resets_at', reset_date
    );
  end if;

  new_count := current_count + 1;

  update user_profiles
  set monthly_ai_usage_count = new_count,
      ai_usage_reset_date = reset_date,
      updated_at = now()
  where id = p_user_id;

  return json_build_object(
    'allowed', true,
    'current_count', new_count,
    'resets_at', reset_date
  );
end;
$$;


ALTER FUNCTION "public"."check_and_increment_ai_usage"("p_user_id" "uuid", "p_limit" integer, "p_now" timestamp with time zone, "p_next_reset" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_rate_limit"("p_key" "text", "p_limit" integer, "p_window_seconds" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  current_count int;
  window_time timestamptz;
begin
  select count, window_start
  into current_count, window_time
  from rate_limits
  where key = p_key;

  if not found then
    insert into rate_limits(key, count, window_start)
    values (p_key, 1, now());
    return true;
  end if;

  if window_time < now() - (p_window_seconds || ' seconds')::interval then
    update rate_limits
    set count = 1,
        window_start = now()
    where key = p_key;
    return true;
  end if;

  if current_count >= p_limit then
    return false;
  end if;

  update rate_limits
  set count = count + 1
  where key = p_key;

  return true;
end;
$$;


ALTER FUNCTION "public"."check_rate_limit"("p_key" "text", "p_limit" integer, "p_window_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_ai_job_for_processing"("p_job_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_job public.ai_jobs%ROWTYPE;
BEGIN

  -- ── 1. Lock row; skip if another worker already holds it ──────────
  SELECT * INTO v_job
    FROM public.ai_jobs
   WHERE id          = p_job_id
     AND soft_deleted IS NOT TRUE       -- never process soft-deleted jobs
     FOR UPDATE SKIP LOCKED;

  -- ── 2. Not found or locked by a peer ─────────────────────────────
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.ai_jobs
       WHERE id = p_job_id
         AND soft_deleted IS NOT TRUE
    ) THEN
      RETURN '{"success":false,"reason":"already_processing"}'::JSONB;
    END IF;
    RETURN '{"success":false,"reason":"job_not_found"}'::JSONB;
  END IF;

  -- ── 3. Idempotency guards ─────────────────────────────────────────
  IF v_job.status = 'completed' THEN
    RETURN '{"success":false,"reason":"already_completed"}'::JSONB;
  END IF;

  IF v_job.status = 'processing' THEN
    RETURN '{"success":false,"reason":"already_processing"}'::JSONB;
  END IF;

  IF v_job.status = 'failed' THEN
    RETURN '{"success":false,"reason":"already_failed"}'::JSONB;
  END IF;

  IF v_job.status <> 'pending' THEN
    RETURN '{"success":false,"reason":"invalid_status"}'::JSONB;
  END IF;

  -- ── 4. Atomic claim ───────────────────────────────────────────────
  UPDATE public.ai_jobs
     SET status     = 'processing',
         started_at = NOW(),
         updated_at = NOW()
   WHERE id     = p_job_id
     AND status  = 'pending'
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RETURN '{"success":false,"reason":"claim_conflict"}'::JSONB;
  END IF;

  -- ── 5. Return claimed row ─────────────────────────────────────────
  RETURN jsonb_build_object(
    'success',        TRUE,
    'id',             v_job.id,
    'job_id',         v_job.job_id,
    'user_id',        v_job.user_id,
    'operation_type', v_job.operation_type,
    'payload',        v_job.payload,
    'status',         v_job.status,
    'started_at',     v_job.started_at,
    'expires_at',     v_job.expires_at,
    'version',        v_job.version
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING '[claim_ai_job] job=% sqlstate=% msg=%',
                  p_job_id, SQLSTATE, SQLERRM;
    RETURN jsonb_build_object(
      'success',  FALSE,
      'reason',   'internal_error',
      'sqlstate', SQLSTATE
    );
END;
$$;


ALTER FUNCTION "public"."claim_ai_job_for_processing"("p_job_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_automation_job"("p_job_id" "text", "p_worker_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_row automation_jobs%ROWTYPE;
BEGIN

  -- Lock the row and claim it atomically.
  -- FOR UPDATE SKIP LOCKED prevents two concurrent workers
  -- from racing on the same job — second caller gets nothing.
  SELECT * INTO v_row
  FROM automation_jobs
  WHERE id         = p_job_id
    AND status     IN ('pending', 'failed')
    AND deleted_at IS NULL
  FOR UPDATE SKIP LOCKED;

  -- Job missing, already claimed, or locked by another worker
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason',  'job not available for claiming'
    );
  END IF;

  -- Atomically claim: flip status, stamp worker, increment attempts
  UPDATE automation_jobs SET
    status     = 'processing',
    worker_id  = p_worker_id,
    attempts   = v_row.attempts + 1,
    claimed_at = now(),
    updated_at = now()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'claimed',     true,
    'job_id',      v_row.id,
    'user_id',     v_row.user_id,
    'attempts',    v_row.attempts + 1,
    'max_attempts', v_row.max_attempts,
    'idempotency_key', v_row.idempotency_key
  );

END;
$$;


ALTER FUNCTION "public"."claim_automation_job"("p_job_id" "text", "p_worker_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_job"("p_job_id" "uuid", "p_worker_id" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  job_record automation_jobs;
begin
  select * into job_record
  from automation_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'Job not found';
  end if;

  if job_record.status in ('processing', 'complete') then
    return json_build_object(
      'claimed', false,
      'status', job_record.status
    );
  end if;

  update automation_jobs
  set status = 'processing',
      worker_id = p_worker_id,
      claimed_at = now(),
      updated_at = now(),
      attempts = attempts + 1
  where id = p_job_id;

  return json_build_object(
    'claimed', true,
    'data', job_record
  );
end;
$$;


ALTER FUNCTION "public"."claim_job"("p_job_id" "uuid", "p_worker_id" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."event_outbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "schema_version" "text" DEFAULT '1.0'::"text" NOT NULL,
    "route" "text" NOT NULL,
    "source" "text" NOT NULL,
    "correlation_id" "uuid",
    "causation_id" "uuid",
    "payload" "jsonb" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "published_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text"
);


ALTER TABLE "public"."event_outbox" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_outbox_events"("p_route" "text", "p_batch_size" integer DEFAULT 10) RETURNS SETOF "public"."event_outbox"
    LANGUAGE "sql"
    AS $$
  UPDATE public.event_outbox
  SET    processed_at = 'infinity'   -- sentinel: claimed but not yet done
  WHERE  id IN (
    SELECT id
    FROM   public.event_outbox
    WHERE  route        = p_route
      AND  processed_at IS NULL
      AND  retry_count  < 5
    ORDER  BY published_at ASC
    LIMIT  p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;


ALTER FUNCTION "public"."claim_outbox_events"("p_route" "text", "p_batch_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_search_events"("p_days" integer DEFAULT 90) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM search_events
  WHERE created_at < now() - (p_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted', v_deleted,
    'cutoff',  (now() - (p_days || ' days')::interval)
  );
END;
$$;


ALTER FUNCTION "public"."cleanup_old_search_events"("p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_professional_onboarding"("p_user_id" "text", "p_job_title" "text", "p_years_experience" double precision, "p_industry" "text", "p_education_level" "text", "p_country" "text", "p_city" "text", "p_salary_range" "text" DEFAULT NULL::"text", "p_career_goals" "jsonb" DEFAULT '[]'::"jsonb", "p_skills" "jsonb" DEFAULT '[]'::"jsonb", "p_cv_uploaded" boolean DEFAULT false) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_now         TIMESTAMPTZ := NOW();
  v_extra_data  JSONB;
BEGIN
  -- ── Validate required inputs ──────────────────────────────────────
  IF p_user_id IS NULL OR TRIM(p_user_id) = '' THEN
    RAISE EXCEPTION 'p_user_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_job_title IS NULL OR TRIM(p_job_title) = '' THEN
    RAISE EXCEPTION 'p_job_title is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_industry IS NULL OR TRIM(p_industry) = '' THEN
    RAISE EXCEPTION 'p_industry is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ── Build extra data blob for columns that don't exist natively ───
  -- education_level, salary_range, career_goals stored in data jsonb
  v_extra_data := jsonb_build_object(
    'education_level', p_education_level,
    'salary_range',    p_salary_range,
    'career_goals',    COALESCE(p_career_goals, '[]'::JSONB)
  );

  -- ── Write 1: onboarding_progress ─────────────────────────────────
  -- Conflict target: user_id (UNIQUE constraint confirmed)
  -- id has no default — generate on INSERT, preserve on UPDATE
  INSERT INTO public.onboarding_progress (
    id,
    user_id,
    job_title,
    years_experience,
    industry,
    city,
    country,
    skills,
    resume_uploaded,
    onboarding_completed,
    onboarding_completed_at,
    data,
    step,
    completed,
    updated_at,
    created_at
  )
  VALUES (
    gen_random_uuid()::TEXT,  -- id: generated on first insert only
    p_user_id,
    p_job_title,
    p_years_experience::INTEGER,
    p_industry,
    p_city,
    p_country,
    COALESCE(p_skills, '[]'::JSONB),
    p_cv_uploaded,
    TRUE,
    v_now,
    v_extra_data,
    'completed',
    TRUE,
    v_now,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    job_title               = EXCLUDED.job_title,
    years_experience        = EXCLUDED.years_experience,
    industry                = EXCLUDED.industry,
    city                    = EXCLUDED.city,
    country                 = EXCLUDED.country,
    skills                  = EXCLUDED.skills,
    resume_uploaded         = EXCLUDED.resume_uploaded,
    onboarding_completed    = TRUE,
    onboarding_completed_at = COALESCE(
                                public.onboarding_progress.onboarding_completed_at,
                                v_now
                              ),
    data                    = COALESCE(
                                public.onboarding_progress.data, '{}'::JSONB
                              ) || v_extra_data,
    step                    = 'completed',
    completed               = TRUE,
    updated_at              = v_now;

  -- ── Write 2: user_profiles ────────────────────────────────────────
  -- Conflict target: user_id (UNIQUE constraint confirmed)
  -- experience_years used here (different name from onboarding_progress)
  -- country stored in data jsonb (no country column on user_profiles)
  INSERT INTO public.user_profiles (
    id,
    user_id,
    job_title,
    experience_years,
    industry,
    current_city,
    skills,
    resume_uploaded,
    data,
    updated_at,
    created_at
  )
  VALUES (
    gen_random_uuid()::TEXT,  -- id: generated on first insert only
    p_user_id,
    p_job_title,
    p_years_experience::INTEGER,
    p_industry,
    p_city,
    COALESCE(p_skills, '[]'::JSONB),
    p_cv_uploaded,
    v_extra_data,
    v_now,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    job_title        = EXCLUDED.job_title,
    experience_years = EXCLUDED.experience_years,
    industry         = EXCLUDED.industry,
    current_city     = EXCLUDED.current_city,
    skills           = EXCLUDED.skills,
    resume_uploaded  = EXCLUDED.resume_uploaded,
    data             = COALESCE(
                         public.user_profiles.data, '{}'::JSONB
                       ) || v_extra_data,
    updated_at       = v_now;

  -- Both writes succeeded — function returns void, transaction commits

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING '[complete_professional_onboarding] user=% sqlstate=% msg=%',
                  p_user_id, SQLSTATE, SQLERRM;
    RAISE; -- re-raise so the transaction rolls back and caller gets the error
END;
$$;


ALTER FUNCTION "public"."complete_professional_onboarding"("p_user_id" "text", "p_job_title" "text", "p_years_experience" double precision, "p_industry" "text", "p_education_level" "text", "p_country" "text", "p_city" "text", "p_salary_range" "text", "p_career_goals" "jsonb", "p_skills" "jsonb", "p_cv_uploaded" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_resume_onboarding"("p_user_id" "uuid", "p_resume_data" "jsonb", "p_profile_strength" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_user        public.users%ROWTYPE;
  v_now         TIMESTAMPTZ := NOW();
BEGIN
  -- ── Validate inputs ───────────────────────────────────────────────
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_resume_data IS NULL THEN
    RAISE EXCEPTION 'p_resume_data is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ── Lock and read the user row atomically ─────────────────────────
  -- FOR UPDATE ensures parallel duplicate requests serialize here.
  -- One wins and updates, the second sees onboarding_completed = true
  -- and returns already_complete without double-writing.
  SELECT * INTO v_user
    FROM public.users
   WHERE id = p_user_id
     FOR UPDATE;

  -- ── No row found ──────────────────────────────────────────────────
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found: %', p_user_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ── Already complete — idempotent early return ────────────────────
  IF v_user.onboarding_completed = TRUE THEN
    RETURN '{"already_complete":true,"updated":false}'::JSONB;
  END IF;

  -- ── Atomic update ─────────────────────────────────────────────────
  UPDATE public.users
     SET onboarding_completed = TRUE,
         onboarding_step      = 'complete',
         resume_data          = p_resume_data,
         profile_strength     = p_profile_strength::SMALLINT,
         updated_at           = v_now
   WHERE id = p_user_id
     AND onboarding_completed = FALSE;  -- extra guard: prevents
                                        -- double-write if two
                                        -- transactions race past
                                        -- the FOR UPDATE somehow

  RETURN '{"already_complete":false,"updated":true}'::JSONB;

EXCEPTION
  WHEN no_data_found THEN
    RAISE; -- re-raise with original message
  WHEN invalid_parameter_value THEN
    RAISE; -- re-raise with original message
  WHEN OTHERS THEN
    RAISE WARNING '[complete_resume_onboarding] user=% sqlstate=% msg=%',
                  p_user_id, SQLSTATE, SQLERRM;
    RAISE;
END;
$$;


ALTER FUNCTION "public"."complete_resume_onboarding"("p_user_id" "uuid", "p_resume_data" "jsonb", "p_profile_strength" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_student_onboarding"("p_user_id" "text", "p_profile" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_now                TIMESTAMPTZ := now();
  v_user_uuid          UUID        := p_user_id::uuid;
  v_age                INTEGER     := (p_profile->>'age')::integer;
  v_grade              TEXT        := p_profile->>'grade';
  v_country            TEXT        := p_profile->>'country';
  v_preferred_subjects JSONB       := COALESCE(p_profile->'preferred_subjects', '[]'::jsonb);
  v_interests          JSONB       := COALESCE(p_profile->'interests', '[]'::jsonb);
  v_strengths          JSONB       := COALESCE(p_profile->'strengths', '{}'::jsonb);
  v_career_curiosities JSONB       := COALESCE(p_profile->'career_curiosities', '[]'::jsonb);
  v_learning_styles    JSONB       := COALESCE(p_profile->'learning_styles', '[]'::jsonb);
  v_academic_marks     JSONB       := p_profile->'academic_marks';
BEGIN

  -- 1. UPDATE users only — email is NOT NULL so INSERT is not safe
  UPDATE public.users
  SET
    student_onboarding_complete = true,
    user_type                   = 'student'
  WHERE id = v_user_uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '[complete_student_onboarding] user % not found in users table',
      p_user_id;
  END IF;

  -- 2. UPSERT user_profiles
  INSERT INTO public.user_profiles (
    id,
    user_id,
    student_onboarding_complete,
    student_profile
  )
  VALUES (
    gen_random_uuid()::text,
    p_user_id,
    true,
    p_profile
  )
  ON CONFLICT (user_id) DO UPDATE
    SET
      student_onboarding_complete = true,
      student_profile             = EXCLUDED.student_profile;

  -- 3. UPSERT student_career_profiles
  INSERT INTO public.student_career_profiles (
    id,
    user_id,
    age,
    grade,
    country,
    preferred_subjects,
    interests,
    strengths,
    career_curiosities,
    learning_styles,
    academic_marks,
    profile_version
  )
  VALUES (
    gen_random_uuid()::text,
    p_user_id,
    v_age,
    v_grade,
    v_country,
    v_preferred_subjects,
    v_interests,
    v_strengths,
    v_career_curiosities,
    v_learning_styles,
    v_academic_marks,
    1
  )
  ON CONFLICT (user_id) DO UPDATE
    SET
      age                  = EXCLUDED.age,
      grade                = EXCLUDED.grade,
      country              = EXCLUDED.country,
      preferred_subjects   = EXCLUDED.preferred_subjects,
      interests            = EXCLUDED.interests,
      strengths            = EXCLUDED.strengths,
      career_curiosities   = EXCLUDED.career_curiosities,
      learning_styles      = EXCLUDED.learning_styles,
      academic_marks       = EXCLUDED.academic_marks,
      profile_version      = student_career_profiles.profile_version + 1;

  -- 4. DELETE student_onboarding_drafts
  DELETE FROM public.student_onboarding_drafts
  WHERE user_id = p_user_id;

  -- 5. Return confirmation
  RETURN jsonb_build_object(
    'success',      true,
    'user_id',      p_user_id,
    'completed_at', v_now
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION
      '[complete_student_onboarding] failed for user %: % (%)',
      p_user_id, SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."complete_student_onboarding"("p_user_id" "text", "p_profile" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_current   integer;
    v_remaining integer;
BEGIN
    SELECT ai_credits_remaining
    INTO   v_current
    FROM   public.users
    WHERE  id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', p_user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_current < p_amount THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS: required=%, available=%',
                        p_amount, v_current
            USING ERRCODE = 'insufficient_resources';
    END IF;

    UPDATE public.users
    SET
        ai_credits_remaining = ai_credits_remaining - p_amount,
        updated_at           = now()
    WHERE id = p_user_id
    RETURNING ai_credits_remaining INTO v_remaining;

    RETURN v_remaining;

EXCEPTION
    WHEN insufficient_resources OR no_data_found THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'consume_ai_credits failed for user %: % (%)',
                        p_user_id, SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_cms_role"("p_name" "text", "p_job_family_id" "text", "p_level" "text" DEFAULT NULL::"text", "p_track" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_alternative_titles" "jsonb" DEFAULT '[]'::"jsonb", "p_admin_id" "uuid" DEFAULT NULL::"uuid", "p_agency" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_normalized_name          text;
  v_normalized_composite_key text;
  v_existing                 jsonb;
  v_result                   jsonb;
BEGIN

  -- Validate required fields
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: name is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_job_family_id IS NULL OR trim(p_job_family_id) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: job_family_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Normalize inputs
  v_normalized_name          := lower(trim(p_name));
  v_normalized_composite_key := v_normalized_name || '_' || lower(trim(p_job_family_id));

  -- Check for existing active role with same composite key
  SELECT to_jsonb(r) INTO v_existing
  FROM cms_roles r
  WHERE normalized_composite_key = v_normalized_composite_key
    AND soft_deleted              = false
  LIMIT 1;

  -- Return existing row without inserting duplicate
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success',   true,
      'inserted',  false,
      'data',      v_existing
    );
  END IF;

  -- Insert new role.
  -- ON CONFLICT handles the rare race condition where two concurrent
  -- requests pass the existence check simultaneously — the loser
  -- returns the winner's inserted row instead of erroring.
  INSERT INTO cms_roles (
    name,
    normalized_name,
    normalized_composite_key,
    job_family_id,
    level,
    track,
    description,
    alternative_titles,
    created_by_admin_id,
    updated_by_admin_id,
    source_agency,
    status,
    soft_deleted,
    created_at,
    updated_at
  )
  VALUES (
    trim(p_name),
    v_normalized_name,
    v_normalized_composite_key,
    trim(p_job_family_id),
    NULLIF(trim(COALESCE(p_level, '')),       ''),
    NULLIF(trim(COALESCE(p_track, '')),       ''),
    COALESCE(trim(p_description), ''),
    COALESCE(p_alternative_titles, '[]'::jsonb),
    p_admin_id,
    p_admin_id,
    COALESCE(trim(p_agency), ''),
    'draft',
    false,
    now(),
    now()
  )
  ON CONFLICT (normalized_composite_key)
  WHERE soft_deleted = false
  DO NOTHING
  RETURNING to_jsonb(cms_roles.*) INTO v_result;

  -- If ON CONFLICT DO NOTHING fired, fetch the existing row
  IF v_result IS NULL THEN
    SELECT to_jsonb(r) INTO v_result
    FROM cms_roles r
    WHERE normalized_composite_key = v_normalized_composite_key
      AND soft_deleted              = false
    LIMIT 1;

    RETURN jsonb_build_object(
      'success',  true,
      'inserted', false,
      'data',     v_result
    );
  END IF;

  RETURN jsonb_build_object(
    'success',  true,
    'inserted', true,
    'data',     v_result
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   format('DUPLICATE_ROLE: Role "%s" already exists', trim(p_name)),
      'code',    'DUPLICATE_ROLE'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'create_cms_role failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."create_cms_role"("p_name" "text", "p_job_family_id" "text", "p_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "jsonb", "p_admin_id" "uuid", "p_agency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_employer_with_admin"("p_user_id" "text", "p_company_name" "text", "p_industry" "text" DEFAULT NULL::"text", "p_website" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_employer emp_employers%ROWTYPE;
BEGIN
  IF p_company_name IS NULL OR btrim(p_company_name) = '' THEN
    RAISE EXCEPTION 'company_name is required'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO emp_employers (company_name, industry, website, created_by)
  VALUES (
    btrim(p_company_name),
    NULLIF(btrim(p_industry), ''),
    NULLIF(btrim(p_website), ''),
    p_user_id
  )
  RETURNING * INTO v_employer;

  INSERT INTO emp_employer_users (employer_id, user_id, role)
  VALUES (v_employer.id, p_user_id, 'employer_admin');

  RETURN to_jsonb(v_employer);
END;
$$;


ALTER FUNCTION "public"."create_employer_with_admin"("p_user_id" "text", "p_company_name" "text", "p_industry" "text", "p_website" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_next_quarterly_partition"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_quarter_start DATE;
  next_quarter_end   DATE;
  partition_name     TEXT;
BEGIN
  -- Calculate start of next quarter
  next_quarter_start := DATE_TRUNC('quarter', NOW() + INTERVAL '3 months')::DATE;
  next_quarter_end   := (next_quarter_start + INTERVAL '3 months')::DATE;
  partition_name     := 'ai_observability_logs_' || TO_CHAR(next_quarter_start, 'YYYY') 
                        || '_q' || TO_CHAR(next_quarter_start, 'Q');

  -- Only create if it doesn't already exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename = partition_name
  ) THEN
    EXECUTE FORMAT(
      'CREATE TABLE public.%I PARTITION OF public.ai_observability_logs
       FOR VALUES FROM (%L) TO (%L)',
      partition_name, next_quarter_start, next_quarter_end
    );
    RAISE NOTICE 'Created partition: %', partition_name;
  ELSE
    RAISE NOTICE 'Partition already exists: %', partition_name;
  END IF;
END;
$$;


ALTER FUNCTION "public"."create_next_quarterly_partition"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_role"("p_role_name" "text", "p_role_family" "text" DEFAULT NULL::"text", "p_seniority_level" "text" DEFAULT NULL::"text", "p_track" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_alternative_titles" "text"[] DEFAULT '{}'::"text"[], "p_created_by" "text" DEFAULT NULL::"text", "p_agency" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_normalized  text;
  v_agency      text;
  v_result      jsonb;
BEGIN

  IF p_role_name IS NULL OR trim(p_role_name) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: role_name is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_created_by IS NULL OR trim(p_created_by) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: created_by is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_normalized := lower(trim(p_role_name));
  v_agency     := COALESCE(trim(p_agency), '');

  INSERT INTO roles (
    role_name,
    normalized_name,
    role_family,
    seniority_level,
    track,
    description,
    alternative_titles,
    created_by,
    updated_by,
    agency,
    soft_deleted,
    created_at,
    updated_at
  )
  VALUES (
    trim(p_role_name),
    v_normalized,
    NULLIF(trim(COALESCE(p_role_family,     '')), ''),
    NULLIF(trim(COALESCE(p_seniority_level, '')), ''),
    NULLIF(trim(COALESCE(p_track,           '')), ''),
    COALESCE(trim(p_description), ''),
    COALESCE(p_alternative_titles, '{}'),
    trim(p_created_by),
    trim(p_created_by),
    v_agency,
    false,
    now(),
    now()
  )
  RETURNING to_jsonb(roles.*) INTO v_result;

  RETURN jsonb_build_object('success', true, 'data', v_result);

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   format('DUPLICATE_ROLE: Role "%s" already exists in agency "%s"', trim(p_role_name), v_agency),
      'code',    'DUPLICATE_ROLE'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'create_role failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."create_role"("p_role_name" "text", "p_role_family" "text", "p_seniority_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "text"[], "p_created_by" "text", "p_agency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deduct_credits"("user_id" "uuid", "amount" integer) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  update users
  set ai_credits_remaining = ai_credits_remaining - amount
  where id = user_id
  and ai_credits_remaining >= amount;

  if not found then
    raise exception 'Insufficient credits';
  end if;
end;
$$;


ALTER FUNCTION "public"."deduct_credits"("user_id" "uuid", "amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_role"("p_role_id" "text", "p_deleted_by" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_result jsonb;
BEGIN

  IF p_role_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: role_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE roles
  SET soft_deleted = true,
      updated_by   = p_deleted_by,
      updated_at   = now()
  WHERE role_id      = p_role_id
    AND soft_deleted = false
  RETURNING to_jsonb(roles.*) INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: Role "%" does not exist or already deleted', p_role_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object('success', true, 'data', v_result);

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'code', 'VALIDATION_ERROR');
  WHEN no_data_found THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'code', 'NOT_FOUND');
  WHEN OTHERS THEN
    RAISE EXCEPTION 'delete_role failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."delete_role"("p_role_id" "text", "p_deleted_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_user_data"("p_user_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Guard: reject null or empty user_id
  IF p_user_id IS NULL OR trim(p_user_id) = '' THEN
    RAISE EXCEPTION 'delete_user_data: p_user_id must not be null or empty';
  END IF;

  -- Step 1: Remove draft onboarding data (user_id is text)
  DELETE FROM public.student_onboarding_drafts
  WHERE user_id = p_user_id;

  -- Step 2: Remove student career profile (user_id is text)
  DELETE FROM public.student_career_profiles
  WHERE user_id = p_user_id;

  -- Step 3: Remove professional career profile (user_id is text)
  DELETE FROM public.professional_career_profiles
  WHERE user_id = p_user_id;

  -- Step 4: Remove from public.users
  -- public.users PK is `id` uuid — cast p_user_id to uuid.
  -- RAISE a clean error if the caller passes a non-uuid string.
  BEGIN
    DELETE FROM public.users
    WHERE id = p_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'delete_user_data: p_user_id is not a valid UUID: %', p_user_id;
  END;

END;
$$;


ALTER FUNCTION "public"."delete_user_data"("p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_automation_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_row        automation_jobs%ROWTYPE;
  v_next_status text;
  v_safe_message text;
BEGIN

  -- Lock the row exclusively to prevent concurrent failure writes
  SELECT * INTO v_row
  FROM automation_jobs
  WHERE id         = p_job_id
    AND deleted_at IS NULL
  FOR UPDATE;

  -- Raise if job doesn't exist at all
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation_job not found: %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Trim error message to 500 chars
  v_safe_message := left(coalesce(p_error_message, ''), 500);

  -- Determine next status:
  -- attempts already incremented by claim_automation_job,
  -- so compare current attempts against max_attempts
  IF v_row.attempts >= v_row.max_attempts THEN
    v_next_status := 'dead';
  ELSE
    v_next_status := 'failed';
  END IF;

  UPDATE automation_jobs SET
    status             = v_next_status,
    last_error_code    = p_error_code,
    last_error_message = v_safe_message,
    failed_at          = now(),
    updated_at         = now(),
    worker_id          = NULL     -- release worker lock on failure
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'job_id',      p_job_id,
    'status',      v_next_status,
    'attempts',    v_row.attempts,
    'max_attempts', v_row.max_attempts,
    'dead',        v_next_status = 'dead'
  );

END;
$$;


ALTER FUNCTION "public"."fail_automation_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") RETURNS TABLE("status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  UPDATE automation_jobs
  SET
    attempts = attempts + 1,
    status = CASE
      WHEN attempts + 1 >= max_attempts THEN 'dead'
      ELSE 'failed'
    END,
    last_error_code = p_error_code,
    last_error_message = LEFT(p_error_message, 500),
    failed_at = NOW(),
    updated_at = NOW()
  WHERE id = p_job_id
  RETURNING automation_jobs.status;
END;
$$;


ALTER FUNCTION "public"."fail_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_similar_skills"("query_vector" "public"."vector", "top_k" integer DEFAULT 5, "min_score" double precision DEFAULT 0.6) RETURNS TABLE("skill_name" "text", "similarity" double precision)
    LANGUAGE "sql"
    AS $$
  SELECT
    skill_name,
    1 - (embedding_vector <=> query_vector) AS similarity
  FROM skill_embeddings
  WHERE 1 - (embedding_vector <=> query_vector) > min_score
  ORDER BY embedding_vector <=> query_vector
  LIMIT top_k;
$$;


ALTER FUNCTION "public"."find_similar_skills"("query_vector" "public"."vector", "top_k" integer, "min_score" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_set_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fn_set_updated_at"() IS 'Generic trigger function: sets updated_at = NOW() on every UPDATE.';



CREATE OR REPLACE FUNCTION "public"."get_adaptive_weights"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  rec RECORD;
BEGIN
  SELECT *
  INTO rec
  FROM adaptive_weights
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag
  LIMIT 1;

  -- No record → return default
  IF rec IS NULL THEN
    RETURN jsonb_build_object(
      'weights', jsonb_build_object(
        'skills', 0.40,
        'experience', 0.25,
        'education', 0.15,
        'projects', 0.20
      ),
      'source', 'default',
      'meta', jsonb_build_object('reason', 'no_record')
    );
  END IF;

  -- Manual override
  IF rec.manual_override = TRUE THEN
    RETURN jsonb_build_object(
      'weights', jsonb_build_object(
        'skills', rec.skills,
        'experience', rec.experience,
        'education', rec.education,
        'projects', rec.projects
      ),
      'source', 'adaptive',
      'meta', jsonb_build_object(
        'manualOverride', true,
        'freezeLearning', true,
        'confidenceScore', rec.confidence_score,
        'performanceScore', rec.performance_score
      )
    );
  END IF;

  -- Confidence gate
  IF rec.confidence_score < 0.60 THEN
    RETURN jsonb_build_object(
      'weights', jsonb_build_object(
        'skills', 0.40,
        'experience', 0.25,
        'education', 0.15,
        'projects', 0.20
      ),
      'source', 'default',
      'meta', jsonb_build_object('reason', 'low_confidence')
    );
  END IF;

  -- Return adaptive
  RETURN jsonb_build_object(
    'weights', jsonb_build_object(
      'skills', rec.skills,
      'experience', rec.experience,
      'education', rec.education,
      'projects', rec.projects
    ),
    'source', 'adaptive',
    'meta', jsonb_build_object(
      'confidenceScore', rec.confidence_score,
      'performanceScore', rec.performance_score,
      'freezeLearning', rec.freeze_learning,
      'manualOverride', false
    )
  );
END;
$$;


ALTER FUNCTION "public"."get_adaptive_weights"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ai_daily_cost"("p_user_id" "text") RETURNS numeric
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(SUM(cost_usd), 0)
  FROM usage_logs
  WHERE user_id = p_user_id
    AND DATE(created_at) = CURRENT_DATE;
$$;


ALTER FUNCTION "public"."get_ai_daily_cost"("p_user_id" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ava_memory" (
    "user_id" "text" NOT NULL,
    "last_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "current_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "skills_added" integer DEFAULT 0 NOT NULL,
    "jobs_applied" integer DEFAULT 0 NOT NULL,
    "resume_improved" boolean DEFAULT false NOT NULL,
    "last_active_date" timestamp with time zone,
    "last_skill_added_at" timestamp with time zone,
    "last_resume_update" timestamp with time zone,
    "weekly_progress" numeric(5,2) DEFAULT 0 NOT NULL,
    "weekly_skills_added" integer DEFAULT 0 NOT NULL,
    "weekly_jobs_applied" integer DEFAULT 0 NOT NULL,
    "week_start_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."ava_memory" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ava_memory" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ava_memory_users_due"("limit_count" integer DEFAULT 500) RETURNS SETOF "public"."ava_memory"
    LANGUAGE "sql" STABLE
    AS $$
  SELECT *
  FROM ava_memory
  WHERE week_start_date IS NULL
     OR week_start_date < now() - interval '7 days'
  ORDER BY week_start_date ASC NULLS FIRST
  LIMIT limit_count;
$$;


ALTER FUNCTION "public"."get_ava_memory_users_due"("limit_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_onboarding_funnel_analytics"("p_limit" integer DEFAULT 500, "p_from" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_to" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS json
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT json_build_object(
    'total', COUNT(*),
    'steps', json_build_object(
      'completed',
        COUNT(*) FILTER (WHERE completed = true),
      'career_report_generated',
        COUNT(*) FILTER (WHERE chi_status IS NOT NULL
                           AND chi_status <> ''
                           AND chi_status <> 'pending')
    )
  )
  FROM (
    SELECT completed, chi_status
    FROM   public.onboarding_progress
    WHERE  soft_deleted IS NOT TRUE
      AND  (p_from IS NULL OR updated_at >= p_from)
      AND  (p_to   IS NULL OR updated_at <= p_to)
    ORDER BY updated_at DESC
    LIMIT  p_limit
  ) sub;
$$;


ALTER FUNCTION "public"."get_onboarding_funnel_analytics"("p_limit" integer, "p_from" timestamp with time zone, "p_to" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_opportunity_radar"("p_user_id" "uuid", "p_top_n" integer DEFAULT 10, "p_min_opportunity_score" integer DEFAULT 40, "p_min_match_score" integer DEFAULT 0) RETURNS json
    LANGUAGE "plpgsql"
    AS $$
declare
  v_skills text[];
  v_target_role text;
  v_exp int;
  v_user_vector vector;
begin
  -- 🔹 Load user profile
  select skills, "targetRole", "yearsExperience"
  into v_skills, v_target_role, v_exp
  from "userProfiles"
  where id = p_user_id;

  -- 🔹 Optional vector (if exists)
  select embedding
  into v_user_vector
  from user_vectors
  where user_id = p_user_id;

  -- 🔹 Core query
  return (
    select json_build_object(
      'emerging_opportunities', json_agg(result),
      'user_skills', coalesce(array_length(v_skills, 1), 0),
      'generated_at', now(),
      'vector_used', v_user_vector is not null
    )
    from (
      select
        cos.role_name as role,
        cos.opportunity_score,

        -- 🔥 MATCH SCORE
        round(
          (
            select count(*)
            from unnest(cos.required_skills::text[]) rs
            where lower(rs) = any (
              select lower(us) from unnest(v_skills) us
            )
          ) * 100.0 / greatest(array_length(cos.required_skills::text[], 1), 1)
        ) as match_score,

        -- 🔥 SKILLS TO LEARN
        (
          select array_agg(rs)
          from unnest(cos.required_skills::text[]) rs
          where lower(rs) != all (
            select lower(us) from unnest(v_skills) us
          )
        ) as skills_to_learn,

        -- 🔥 FINAL RANK
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

          -- 🔥 VECTOR BOOST
          case
            when v_user_vector is not null and cos.embedding is not null
            then (1 - (cos.embedding <=> v_user_vector)) * 5
            else 0
          end
        ) as rank_score

      from career_opportunity_signals cos
      where cos.opportunity_score >= p_min_opportunity_score

    ) result
    where result.match_score >= p_min_match_score
    order by result.rank_score desc
    limit p_top_n
  );
end;
$$;


ALTER FUNCTION "public"."get_opportunity_radar"("p_user_id" "uuid", "p_top_n" integer, "p_min_opportunity_score" integer, "p_min_match_score" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_opportunity_radar_ai"("user_skills" "text"[], "top_n" integer DEFAULT 10) RETURNS TABLE("role" "text", "match_score" integer, "opportunity_score" integer, "final_score" numeric, "skills_to_learn" "text"[])
    LANGUAGE "plpgsql"
    AS $$
begin
  return query

  with user_skill_embeddings as (
    select se.embedding
    from skill_embeddings se
    where se.skill = any(user_skills)
  ),

  role_skills as (
    select
      cos.role_name,
      cos.opportunity_score,
      jsonb_array_elements_text(cos.required_skills) as skill
    from career_opportunity_signals cos
  ),

  role_skill_embeddings as (
    select
      rs.role_name,
      rs.opportunity_score,
      rs.skill,
      se.embedding
    from role_skills rs
    join skill_embeddings se
      on se.skill = rs.skill
  ),

  similarity_calc as (
    select
      rse.role_name,
      rse.opportunity_score,
      avg(1 - (rse.embedding <=> use.embedding)) as similarity
    from role_skill_embeddings rse
    cross join user_skill_embeddings use
    group by rse.role_name, rse.opportunity_score
  ),

  match_calc as (
    select
      cos.role_name,
      cos.opportunity_score,
      (
        select count(*)
        from jsonb_array_elements_text(cos.required_skills) s
        where s = any(user_skills)
      )::float /
      jsonb_array_length(cos.required_skills) * 100 as match_score,

      array(
        select s
        from jsonb_array_elements_text(cos.required_skills) s
        where not (s = any(user_skills))
      ) as skills_to_learn
    from career_opportunity_signals cos
  )

  select
    m.role_name as role,
    round(m.match_score)::int,
    m.opportunity_score,
    round(
      (coalesce(s.similarity, 0) * 60) +
      (m.match_score * 0.4)
    , 2) as final_score,
    m.skills_to_learn

  from match_calc m
  left join similarity_calc s
    on s.role_name = m.role_name

  order by final_score desc
  limit top_n;

end;
$$;


ALTER FUNCTION "public"."get_opportunity_radar_ai"("user_skills" "text"[], "top_n" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_rag_context_v1"("p_user_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_profile         record;
  v_chi             record;
  v_opportunity     record;
  v_risk            record;
  v_personalization record;

  v_target_role     text;
  v_skills          jsonb;
  v_salary          jsonb := NULL;

  v_user_profile_block        jsonb := NULL;
  v_chi_block                 jsonb := NULL;
  v_opportunity_block         jsonb := NULL;
  v_risk_block                jsonb := NULL;
  v_personalization_block     jsonb := NULL;

  v_sources_used    text[]  := ARRAY[]::text[];
  v_source_count    integer := 0;
  v_total_sources   integer := 6;
  v_confidence      numeric := 0;

  w_user_profile    constant numeric := 0.20;
  w_chi_score       constant numeric := 0.15;
  w_opportunity     constant numeric := 0.12;
  w_risk            constant numeric := 0.10;
  w_salary          constant numeric := 0.08;
  w_personalization constant numeric := 0.05;

BEGIN

  SELECT
    up.skills, up.target_role, up.target_role_free_text,
    up.job_title, up.current_job_title, up.industry,
    up.experience_years, up.years_of_experience, up.years_experience,
    up.current_city, up.current_salary_lpa, up.work_mode,
    up.professional_summary
  INTO v_profile
  FROM user_profiles up
  WHERE up.user_id = p_user_id
  LIMIT 1;

  IF v_profile IS NOT NULL THEN
    v_target_role := COALESCE(
      NULLIF(TRIM(v_profile.target_role), ''),
      NULLIF(TRIM(v_profile.target_role_free_text), ''),
      NULLIF(TRIM(v_profile.current_job_title), ''),
      NULLIF(TRIM(v_profile.job_title), '')
    );

    v_skills := COALESCE(v_profile.skills, '[]'::jsonb);

    v_user_profile_block := jsonb_build_object(
      'skills',               v_skills,
      'target_role',          v_target_role,
      'current_role',         COALESCE(v_profile.current_job_title, v_profile.job_title),
      'industry',             v_profile.industry,
      'years_experience',     COALESCE(v_profile.experience_years, v_profile.years_of_experience, v_profile.years_experience, 0),
      'current_salary',       v_profile.current_salary_lpa,
      'location',             v_profile.current_city,
      'work_mode',            v_profile.work_mode,
      'professional_summary', v_profile.professional_summary
    );

    v_sources_used := array_append(v_sources_used, 'user_profile');
    v_confidence   := v_confidence + w_user_profile;

    IF jsonb_array_length(v_skills) > 0 AND v_target_role IS NOT NULL THEN
      v_confidence := LEAST(1, v_confidence + 0.05);
    END IF;
  END IF;

  SELECT
    chi.chi_score, chi.chi_confidence, chi.confidence, chi.dimensions,
    chi.analysis_source, chi.generated_at, chi.detected_profession,
    chi.top_skills, chi.top_strength, chi.critical_gap, chi.market_position,
    chi.trend, chi.current_estimated_salary_lpa,
    chi.next_level_estimated_salary_lpa, chi.projected_level_up_months
  INTO v_chi
  FROM career_health_index chi
  WHERE chi.user_id = p_user_id
    AND (chi.soft_deleted IS NULL OR chi.soft_deleted = FALSE)
  ORDER BY chi.generated_at DESC
  LIMIT 1;

  IF v_chi IS NOT NULL AND v_chi.chi_score IS NOT NULL THEN
    v_chi_block := jsonb_build_object(
      'chi_score',                       v_chi.chi_score,
      'chi_confidence',                  COALESCE(v_chi.chi_confidence, 0),
      'confidence',                      v_chi.confidence,
      'dimensions',                      v_chi.dimensions,
      'analysis_source',                 COALESCE(v_chi.analysis_source, 'unknown'),
      'calculated_at',                   v_chi.generated_at,
      'detected_profession',             v_chi.detected_profession,
      'top_skills',                      v_chi.top_skills,
      'top_strength',                    v_chi.top_strength,
      'critical_gap',                    v_chi.critical_gap,
      'market_position',                 v_chi.market_position,
      'trend',                           CASE WHEN v_chi.trend IS NULL THEN NULL::jsonb ELSE v_chi.trend::jsonb END,
      'current_estimated_salary_lpa',    v_chi.current_estimated_salary_lpa,
      'next_level_estimated_salary_lpa', v_chi.next_level_estimated_salary_lpa,
      'projected_level_up_months',       v_chi.projected_level_up_months
    );

    v_sources_used := array_append(v_sources_used, 'chi_score');
    v_confidence   := v_confidence + w_chi_score;

    IF v_target_role IS NULL THEN
      v_target_role := v_chi.detected_profession;
    END IF;
  END IF;

  SELECT
    orr.emerging_opportunities, orr.total_signals_evaluated, orr.computed_at
  INTO v_opportunity
  FROM opportunity_radar_results orr
  WHERE orr.user_id = p_user_id
  LIMIT 1;

  IF v_opportunity IS NOT NULL
     AND jsonb_array_length(COALESCE(v_opportunity.emerging_opportunities, '[]'::jsonb)) > 0
  THEN
    v_opportunity_block := jsonb_build_object(
      'emerging_opportunities', (
        SELECT jsonb_agg(elem) FROM (
          SELECT elem FROM jsonb_array_elements(v_opportunity.emerging_opportunities) AS elem
          LIMIT 5
        ) sub
      ),
      'total_evaluated', COALESCE(v_opportunity.total_signals_evaluated, 0),
      'source',          'precomputed',
      'computed_at',     v_opportunity.computed_at
    );

    v_sources_used := array_append(v_sources_used, 'opportunity_radar');
    v_confidence   := v_confidence + w_opportunity;
  END IF;

  SELECT
    rar.overall_risk_score, rar.risk_level, rar.risk_factors,
    rar.recommendations, rar.computed_at
  INTO v_risk
  FROM risk_analysis_results rar
  WHERE rar.user_id = p_user_id
  LIMIT 1;

  IF v_risk IS NOT NULL AND v_risk.overall_risk_score IS NOT NULL THEN
    v_risk_block := jsonb_build_object(
      'overall_risk_score', v_risk.overall_risk_score,
      'risk_level',         v_risk.risk_level,
      'risk_factors', (
        SELECT jsonb_agg(elem) FROM (
          SELECT elem FROM jsonb_array_elements(COALESCE(v_risk.risk_factors, '[]'::jsonb)) AS elem
          LIMIT 4
        ) sub
      ),
      'recommendations', (
        SELECT jsonb_agg(elem) FROM (
          SELECT elem FROM jsonb_array_elements(COALESCE(v_risk.recommendations, '[]'::jsonb)) AS elem
          LIMIT 3
        ) sub
      ),
      'computed_at', v_risk.computed_at
    );

    v_sources_used := array_append(v_sources_used, 'risk_analysis');
    v_confidence   := v_confidence + w_risk;
  END IF;

  SELECT
    upp.preferred_roles, upp.preferred_skills, upp.career_interests,
    upp.engagement_score, upp.total_events
  INTO v_personalization
  FROM user_personalization_profile upp
  WHERE upp.user_id = p_user_id
  LIMIT 1;

  IF v_personalization IS NOT NULL
     AND COALESCE(v_personalization.total_events, 0) >= 1
  THEN
    v_personalization_block := jsonb_build_object(
      'preferred_roles', (
        SELECT jsonb_agg(elem) FROM (
          SELECT elem FROM jsonb_array_elements(COALESCE(v_personalization.preferred_roles, '[]'::jsonb)) AS elem
          LIMIT 5
        ) sub
      ),
      'preferred_skills', (
        SELECT jsonb_agg(elem) FROM (
          SELECT elem FROM jsonb_array_elements(COALESCE(v_personalization.preferred_skills, '[]'::jsonb)) AS elem
          LIMIT 5
        ) sub
      ),
      'career_interests', (
        SELECT jsonb_agg(elem) FROM (
          SELECT elem FROM jsonb_array_elements(COALESCE(v_personalization.career_interests, '[]'::jsonb)) AS elem
          LIMIT 3
        ) sub
      ),
      'engagement_score', v_personalization.engagement_score,
      'total_events',     v_personalization.total_events
    );

    v_sources_used := array_append(v_sources_used, 'personalization_profile');
    v_confidence   := v_confidence + w_personalization;
  END IF;

  IF v_target_role IS NOT NULL THEN
    SELECT jsonb_build_object(
      'role',          csb.name,
      'median_salary', csb.median_salary,
      'min_salary',    csb.min_salary,
      'max_salary',    csb.max_salary,
      'currency',      COALESCE(csb.currency, 'INR'),
      'year',          csb.year,
      'source',        'cms_salary_benchmarks',
      'similarity',    ROUND(similarity(
                         LOWER(COALESCE(csb.normalized_name, csb.name)),
                         LOWER(v_target_role)
                       )::numeric, 3)
    )
    INTO v_salary
    FROM cms_salary_benchmarks csb
    WHERE csb.soft_deleted IS NOT TRUE
      AND csb.status = 'published'
      AND similarity(
            LOWER(COALESCE(csb.normalized_name, csb.name)),
            LOWER(v_target_role)
          ) > 0.25
    ORDER BY similarity(
               LOWER(COALESCE(csb.normalized_name, csb.name)),
               LOWER(v_target_role)
             ) DESC
    LIMIT 1;

    IF v_salary IS NOT NULL THEN
      v_sources_used := array_append(v_sources_used, 'salary_benchmarks');
      v_confidence   := v_confidence + w_salary;
    END IF;
  END IF;

  v_source_count := COALESCE(array_length(v_sources_used, 1), 0);
  v_confidence   := ROUND(LEAST(1.0, v_confidence)::numeric, 3);

  RETURN jsonb_build_object(
    'user_profile',            v_user_profile_block,
    'chi_score',               v_chi_block,
    'opportunity_radar',       v_opportunity_block,
    'risk_analysis',           v_risk_block,
    'salary_benchmarks',       v_salary,
    'personalization_profile', v_personalization_block,
    'data_sources_used',       to_jsonb(v_sources_used),
    'data_completeness',       ROUND((v_source_count::numeric / v_total_sources), 3),
    'confidence_score',        v_confidence,
    'is_sufficient',           (v_source_count::numeric / v_total_sources) >= 0.25,
    'retrieved_at',            to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

END;
$$;


ALTER FUNCTION "public"."get_rag_context_v1"("p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_salary_band"("p_role_id" "text", "p_level" "text", "p_region" "text" DEFAULT NULL::"text") RETURNS TABLE("role_id" "text", "level" "text", "min_salary" integer, "median_salary" integer, "max_salary" integer, "source" "text", "region" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    sb.role_id,
    sb.experience_band                AS level,
    sb.min_salary::integer            AS min_salary,
    sb.median_salary::integer         AS median_salary,
    sb.max_salary::integer            AS max_salary,
    COALESCE(sb.source, 'database')   AS source,
    sb.region
  FROM public.salary_bands sb
  WHERE
    LOWER(sb.role_id)      = LOWER(p_role_id)
    AND sb.experience_band = p_level
    AND (sb.soft_deleted = false OR sb.soft_deleted IS NULL)
    AND (
      p_region IS NULL
      OR sb.region = p_region
      OR sb.region IS NULL
    )
  ORDER BY
    CASE
      WHEN p_region IS NOT NULL AND sb.region = p_region THEN 0
      WHEN sb.region IS NULL                             THEN 1
      ELSE                                                    2
    END ASC,
    CASE WHEN sb.is_verified = true THEN 0 ELSE 1 END ASC,
    sb.updated_at DESC NULLS LAST
  LIMIT 1;
$$;


ALTER FUNCTION "public"."get_salary_band"("p_role_id" "text", "p_level" "text", "p_region" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    created_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."health_check"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT true;
$$;


ALTER FUNCTION "public"."health_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."immutable_unaccent"("text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
  SELECT public.unaccent($1);
$_$;


ALTER FUNCTION "public"."immutable_unaccent"("text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_ai_cost"("p_user_id" "text", "p_cost" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO usage_logs (
    user_id,
    feature,
    cost_usd,
    revenue_usd,
    tier,
    created_at
  )
  VALUES (
    p_user_id,
    'ai_request',
    p_cost,
    0,
    'unknown',
    NOW()
  );
END;
$$;


ALTER FUNCTION "public"."increment_ai_cost"("p_user_id" "text", "p_cost" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_ai_usage"("user_id" "text", "user_tier" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  current_count INT;
  reset_date TIMESTAMP;
  limit_val INT;
  new_reset_date TIMESTAMP;
BEGIN
  -- 1. Set limit
  limit_val := CASE user_tier
    WHEN 'free' THEN 5
    WHEN 'pro' THEN 100
    WHEN 'elite' THEN 500
    WHEN 'enterprise' THEN 500
    ELSE 5
  END;

  -- 2. Try to get existing row
  SELECT 
    "monthlyAiUsageCount", 
    "aiUsageResetDate"
  INTO current_count, reset_date
  FROM "userProfiles"
  WHERE id = user_id
  FOR UPDATE;

  -- 3. If user does NOT exist → insert
  IF NOT FOUND THEN
    INSERT INTO "userProfiles" (
      id,
      "monthlyAiUsageCount",
      "aiUsageResetDate",
      "updatedAt"
    )
    VALUES (
      user_id,
      1,
      date_trunc('month', NOW()) + INTERVAL '1 month',
      NOW()
    );
    RETURN;
  END IF;

  -- 4. Reset logic
  IF reset_date IS NULL OR NOW() >= reset_date THEN
    current_count := 0;
    new_reset_date := date_trunc('month', NOW()) + INTERVAL '1 month';
  ELSE
    new_reset_date := reset_date;
  END IF;

  -- 5. Limit check
  IF current_count >= limit_val THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED';
  END IF;

  -- 6. Update
  UPDATE "userProfiles"
  SET
    "monthlyAiUsageCount" = current_count + 1,
    "aiUsageResetDate" = new_reset_date,
    "updatedAt" = NOW()
  WHERE id = user_id;

END;
$$;


ALTER FUNCTION "public"."increment_ai_usage"("user_id" "text", "user_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_ava_memory_jobs"("p_user_id" "text", "p_delta" integer DEFAULT 1) RETURNS SETOF "public"."ava_memory"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.ava_memory (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  UPDATE public.ava_memory
  SET
    jobs_applied     = jobs_applied + p_delta,
    last_active_date = NOW()
  WHERE user_id = p_user_id
  RETURNING *;
END;
$$;


ALTER FUNCTION "public"."increment_ava_memory_jobs"("p_user_id" "text", "p_delta" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_ava_memory_skills"("p_user_id" "text", "p_delta" integer DEFAULT 1) RETURNS SETOF "public"."ava_memory"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.ava_memory (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  UPDATE public.ava_memory
  SET
    skills_added        = skills_added + p_delta,
    last_skill_added_at = NOW(),
    last_active_date    = NOW()
  WHERE user_id = p_user_id
  RETURNING *;
END;
$$;


ALTER FUNCTION "public"."increment_ava_memory_skills"("p_user_id" "text", "p_delta" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversion_aggregates" (
    "id" "text" NOT NULL,
    "engagement_score" integer DEFAULT 0 NOT NULL,
    "monetization_score" integer DEFAULT 0 NOT NULL,
    "total_intent_score" integer DEFAULT 0 NOT NULL,
    "event_counts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "score_version" integer DEFAULT 2 NOT NULL,
    "last_event_at" timestamp with time zone,
    "last_engagement_event_at" timestamp with time zone,
    "last_monetization_event_at" timestamp with time zone,
    "last_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."conversion_aggregates" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_conversion_aggregate"("p_user_id" "text", "p_event_type" "text", "p_hard_limit" integer, "p_score_version" integer) RETURNS "public"."conversion_aggregates"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_row       public.conversion_aggregates;
    v_current   INTEGER;
    v_new_count INTEGER;
BEGIN
    -- ── 1. Guarantee the row exists ─────────────────────────────────────────
    --
    -- INSERT ... ON CONFLICT DO NOTHING creates the row on first call.
    -- Under concurrent first-calls for the same id, exactly one INSERT wins;
    -- the rest skip silently. The TEXT PRIMARY KEY prevents duplicates.
    --
    INSERT INTO public.conversion_aggregates (id, event_counts, created_at, updated_at)
    VALUES (p_user_id, '{}'::jsonb, now(), now())
    ON CONFLICT (id) DO NOTHING;


    -- ── 2. Acquire a row-level lock ─────────────────────────────────────────
    --
    -- FOR UPDATE holds an exclusive lock on this row for the duration of the
    -- calling transaction. Concurrent writers for the same id queue here and
    -- execute serially — eliminating the lost-update window entirely.
    --
    -- Deadlock-safe: each call locks exactly one row (one id), so there is
    -- no possibility of circular waits between concurrent transactions.
    --
    SELECT * INTO v_row
    FROM public.conversion_aggregates
    WHERE id = p_user_id
    FOR UPDATE;


    -- ── 3. Compute the new count with hard cap ──────────────────────────────
    --
    -- ->> p_event_type returns NULL when the key doesn't exist yet (new event
    -- type for this user). COALESCE converts NULL → 0 so the first increment
    -- produces 1. LEAST enforces the hard ceiling.
    --
    v_current   := COALESCE((v_row.event_counts ->> p_event_type)::INTEGER, 0);
    v_new_count := LEAST(v_current + 1, p_hard_limit);


    -- ── 4. Single atomic UPDATE ─────────────────────────────────────────────
    --
    -- The || (concat) operator merges the updated key back into the existing
    -- JSONB object. All other keys in event_counts are preserved untouched.
    -- This is the critical fix: there is no gap between read and write where
    -- another writer can overwrite a different key.
    --
    -- Both last_updated_at and updated_at are written (table has both columns).
    --
    UPDATE public.conversion_aggregates
    SET
        event_counts    = v_row.event_counts
                          || jsonb_build_object(p_event_type, v_new_count),
        score_version   = p_score_version,
        last_event_at   = now(),
        last_updated_at = now(),
        updated_at      = now()
    WHERE id = p_user_id
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;


ALTER FUNCTION "public"."increment_conversion_aggregate"("p_user_id" "text", "p_event_type" "text", "p_hard_limit" integer, "p_score_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_conversion_event_count"("p_id" "text", "p_event_type" "text", "p_hard_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_row            conversion_aggregates%ROWTYPE;
  v_current_count  INTEGER;
  v_new_count      INTEGER;
  v_updated_counts JSONB;
BEGIN

  -- -------------------------------------------------------------------------
  -- Guard: fast-fail on bad inputs before any I/O
  -- -------------------------------------------------------------------------
  IF p_id IS NULL OR TRIM(p_id) = '' THEN
    RAISE EXCEPTION 'increment_conversion_event_count: p_id must not be null or empty';
  END IF;

  IF p_event_type IS NULL OR TRIM(p_event_type) = '' THEN
    RAISE EXCEPTION 'increment_conversion_event_count: p_event_type must not be null or empty';
  END IF;

  IF p_hard_limit IS NULL OR p_hard_limit < 1 THEN
    RAISE EXCEPTION 'increment_conversion_event_count: p_hard_limit must be a positive integer';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 1: Create row on first event (idempotent).
  --
  -- ON CONFLICT (id) DO NOTHING means two racing workers both attempting to
  -- create the same row produce no error — one INSERT wins, the other is a
  -- harmless no-op. Both then race to the SELECT FOR UPDATE below, which
  -- fully serialises the rest of the write.
  -- -------------------------------------------------------------------------
  INSERT INTO conversion_aggregates (
    id,
    event_counts,
    updated_at,
    last_updated_at,
    last_event_at
  )
  VALUES (
    p_id,
    jsonb_build_object(p_event_type, 0),
    NOW(),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- Step 2: Acquire an exclusive row-level lock.
  --
  -- FOR UPDATE blocks any other transaction that tries to SELECT FOR UPDATE
  -- or UPDATE this row until we commit. This is the only mechanism that
  -- completely prevents lost updates between concurrent Supabase workers.
  -- -------------------------------------------------------------------------
  SELECT *
    INTO v_row
    FROM conversion_aggregates
   WHERE id = p_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'increment_conversion_event_count: row id=% vanished after INSERT — this should never happen',
      p_id;
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 3: Compute the capped counter value.
  --
  -- COALESCE treats a missing key (never-seen event type) as 0.
  -- LEAST enforces the hard cap idempotently: replaying the same event once
  -- the cap is already reached leaves the value unchanged — no side-effect.
  -- -------------------------------------------------------------------------
  v_current_count := COALESCE(
    (v_row.event_counts ->> p_event_type)::INTEGER,
    0
  );

  v_new_count := LEAST(v_current_count + 1, p_hard_limit);

  -- Merge only the changed key; all other event counters remain intact.
  v_updated_counts := v_row.event_counts || jsonb_build_object(p_event_type, v_new_count);

  -- -------------------------------------------------------------------------
  -- Step 4: Persist and refresh timestamps atomically within the same lock.
  -- -------------------------------------------------------------------------
  UPDATE conversion_aggregates
     SET event_counts    = v_updated_counts,
         updated_at      = NOW(),
         last_updated_at = NOW(),
         last_event_at   = NOW()
   WHERE id = p_id;

  -- -------------------------------------------------------------------------
  -- Step 5: Return the full updated event_counts map.
  --         The JS layer uses this to feed computeScoresFn.
  -- -------------------------------------------------------------------------
  RETURN v_updated_counts;

END;
$$;


ALTER FUNCTION "public"."increment_conversion_event_count"("p_id" "text", "p_event_type" "text", "p_hard_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_rate_limit"("p_id" "text", "p_limit" integer, "p_expires_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  current_count int;
begin
  insert into rate_limit_counters (id, count, expires_at)
  values (p_id, 1, p_expires_at)
  on conflict (id)
  do update set count = rate_limit_counters.count + 1
  returning count into current_count;

  return current_count <= p_limit;
end;
$$;


ALTER FUNCTION "public"."increment_rate_limit"("p_id" "text", "p_limit" integer, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_user_quota"("p_user_id" "text", "p_month_key" "text", "p_feature" "text", "p_increment" integer, "p_expires_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  insert into user_quota (user_id, month_key, feature, count, expires_at)
  values (p_user_id, p_month_key, p_feature, p_increment, p_expires_at)
  on conflict (user_id, month_key, feature)
  do update set
    count = user_quota.count + p_increment,
    expires_at = p_expires_at,
    last_updated = now();
end;
$$;


ALTER FUNCTION "public"."increment_user_quota"("p_user_id" "text", "p_month_key" "text", "p_feature" "text", "p_increment" integer, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid()::TEXT
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_roles"("p_agency" "text", "p_limit" integer DEFAULT 100, "p_role_family" "text" DEFAULT NULL::"text", "p_cursor_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_cursor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  v_limit       int;
  v_roles       jsonb;
  v_last_row    jsonb;
  v_next_cursor jsonb;
BEGIN

  IF p_agency IS NULL OR trim(p_agency) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: agency is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);

  IF p_cursor_created_at IS NULL OR p_cursor_id IS NULL THEN

    IF p_role_family IS NULL THEN
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      INTO v_roles
      FROM (
        SELECT *
        FROM roles
        WHERE agency       = p_agency
          AND soft_deleted = false
        ORDER BY created_at DESC, role_id DESC
        LIMIT v_limit
      ) r;
    ELSE
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      INTO v_roles
      FROM (
        SELECT *
        FROM roles
        WHERE agency       = p_agency
          AND role_family  = p_role_family
          AND soft_deleted = false
        ORDER BY created_at DESC, role_id DESC
        LIMIT v_limit
      ) r;
    END IF;

  ELSE

    IF p_role_family IS NULL THEN
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      INTO v_roles
      FROM (
        SELECT *
        FROM roles
        WHERE agency       = p_agency
          AND soft_deleted = false
          AND (
            created_at < p_cursor_created_at
            OR (
              created_at  = p_cursor_created_at
              AND role_id < p_cursor_id
            )
          )
        ORDER BY created_at DESC, role_id DESC
        LIMIT v_limit
      ) r;
    ELSE
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      INTO v_roles
      FROM (
        SELECT *
        FROM roles
        WHERE agency       = p_agency
          AND role_family  = p_role_family
          AND soft_deleted = false
          AND (
            created_at < p_cursor_created_at
            OR (
              created_at  = p_cursor_created_at
              AND role_id < p_cursor_id
            )
          )
        ORDER BY created_at DESC, role_id DESC
        LIMIT v_limit
      ) r;
    END IF;

  END IF;

  IF jsonb_array_length(v_roles) = v_limit THEN
    v_last_row    := v_roles -> (jsonb_array_length(v_roles) - 1);
    v_next_cursor := jsonb_build_object(
      'created_at', v_last_row->>'created_at',
      'id',         v_last_row->>'role_id'
    );
  ELSE
    v_next_cursor := NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'roles',       v_roles,
      'next_cursor', v_next_cursor,
      'limit',       v_limit,
      'returned',    jsonb_array_length(v_roles)
    )
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'list_roles failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."list_roles"("p_agency" "text", "p_limit" integer, "p_role_family" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_jobs_by_embedding"("query_vector" "public"."vector", "min_score" numeric DEFAULT 0.3, "top_k" integer DEFAULT 50) RETURNS TABLE("job_id" "uuid", "similarity" numeric)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    je.job_id::uuid AS job_id,
    1 - (je.embedding_vector <=> query_vector) AS similarity
  FROM public.job_embeddings je
  JOIN public.jobs j
    ON j.id = je.job_id::uuid
  WHERE je.embedding_vector IS NOT NULL
    AND 1 - (je.embedding_vector <=> query_vector) >= min_score
  ORDER BY je.embedding_vector <=> query_vector
  LIMIT top_k;
$$;


ALTER FUNCTION "public"."match_jobs_by_embedding"("query_vector" "public"."vector", "min_score" numeric, "top_k" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_roles"("query_embedding" "public"."vector", "match_count" integer DEFAULT 10, "min_similarity" double precision DEFAULT 0.65) RETURNS TABLE("role_id" "text", "role_name" "text", "normalized_name" "text", "seniority_level" "text", "track" "text", "job_family_id" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    r.role_id,
    r.role_name,
    r.normalized_name,
    r.seniority_level,
    r.track,
    r.job_family_id,
    (1 - (r.embedding <=> query_embedding))::float AS similarity
  FROM public.roles r
  WHERE
    r.embedding IS NOT NULL
    AND r.soft_deleted = false
    AND (1 - (r.embedding <=> query_embedding)) >= min_similarity
  ORDER BY
    r.embedding <=> query_embedding ASC
  LIMIT match_count;
$$;


ALTER FUNCTION "public"."match_roles"("query_embedding" "public"."vector", "match_count" integer, "min_similarity" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_skills"("input_user_id" "uuid") RETURNS TABLE("skill_id" "uuid", "skill_name" "text", "similarity" double precision)
    LANGUAGE "plpgsql"
    AS $$
declare
  user_embedding vector(384);
begin
  -- ⚡ Force fast vector search
  set local ivfflat.probes = 10;

  -- ✅ Get precomputed user vector
  select embedding into user_embedding
  from user_vectors
  where user_id = input_user_id;

  -- ❌ Safety check
  if user_embedding is null then
    raise exception 'User embedding not found';
  end if;

  return query
  with top_matches as (
    select
      se.skill_id,
      se.embedding <-> user_embedding as distance
    from skill_embeddings se
    order by se.embedding <-> user_embedding
    limit 50
  )
  select
    s.id,
    s.name,
    (1 - tm.distance) as similarity
  from top_matches tm
  join skills s on s.id = tm.skill_id
  order by similarity desc
  limit 20;

end;
$$;


ALTER FUNCTION "public"."match_skills"("input_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_skills_semantic"("input_skills" "text"[], "top_k" integer DEFAULT 5, "min_score" double precision DEFAULT 0) RETURNS TABLE("skill_name" "text", "similarity" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog', 'extensions'
    AS $$
DECLARE
  query_vector vector(384);          -- ← corrected from 1536
BEGIN

  -- ── Validate inputs ───────────────────────────────────────────────
  IF input_skills IS NULL OR array_length(input_skills, 1) IS NULL THEN
    RETURN;
  END IF;

  -- ── Clamp min_score to valid cosine similarity range ─────────────
  IF min_score < -1 OR min_score > 1 THEN
    RAISE EXCEPTION 'min_score must be between -1 and 1, got: %', min_score
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ── Build centroid from matched input skills ──────────────────────
  SELECT AVG(s.embedding)
    INTO query_vector
    FROM public.skill_embeddings s
   WHERE s.skill_name = ANY(input_skills);

  IF query_vector IS NULL THEN
    RETURN;
  END IF;

  -- ── Return top-K similar skills above min_score threshold ─────────
  RETURN QUERY
  SELECT
    s.skill_name,
    (1 - (s.embedding <=> query_vector))::DOUBLE PRECISION AS similarity
  FROM public.skill_embeddings s
  WHERE (1 - (s.embedding <=> query_vector)) >= min_score
  ORDER BY s.embedding <=> query_vector ASC
  LIMIT top_k;

END;
$$;


ALTER FUNCTION "public"."match_skills_semantic"("input_skills" "text"[], "top_k" integer, "min_score" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_notification_delivery_status"("p_notification_id" "text", "p_channel" "text", "p_status" "text") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  UPDATE public.notifications
  SET delivery_status = COALESCE(delivery_status, '{}'::jsonb)
                        || jsonb_build_object(p_channel, p_status)
  WHERE id = p_notification_id;
$$;


ALTER FUNCTION "public"."merge_notification_delivery_status"("p_notification_id" "text", "p_channel" "text", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_resume_version"("p_resume_id" "uuid") RETURNS smallint
    LANGUAGE "sql" STABLE
    AS $$
  SELECT (COALESCE(MAX(version_number), 0) + 1)::SMALLINT
  FROM public.resume_versions
  WHERE resume_id = p_resume_id;
$$;


ALTER FUNCTION "public"."next_resume_version"("p_resume_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_query"("p_query" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $$
  SELECT lower(trim(unaccent(p_query)));
$$;


ALTER FUNCTION "public"."normalize_query"("p_query" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_role_name"("p_name" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $$
  SELECT lower(regexp_replace(trim(p_name), '\s+', ' ', 'g'));
$$;


ALTER FUNCTION "public"."normalize_role_name"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_text"("p_input" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  SELECT lower(regexp_replace(trim(p_input), '\s+', ' ', 'g'));
$$;


ALTER FUNCTION "public"."normalize_text"("p_input" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_old_agent_results"("retain_count" integer DEFAULT 5) RETURNS "jsonb"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
  WITH risk_stale AS (
    SELECT id
    FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY computed_at DESC
        ) AS rn
      FROM public.risk_analysis_results
    ) ranked
    WHERE rn > retain_count
  ),
  risk_deleted AS (
    DELETE FROM public.risk_analysis_results
    WHERE id IN (SELECT id FROM risk_stale)
    RETURNING 1
  ),
  radar_stale AS (
    SELECT id
    FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY computed_at DESC
        ) AS rn
      FROM public.opportunity_radar_results
    ) ranked
    WHERE rn > retain_count
  ),
  radar_deleted AS (
    DELETE FROM public.opportunity_radar_results
    WHERE id IN (SELECT id FROM radar_stale)
    RETURNING 1
  )
  SELECT jsonb_build_object(
    'risk_deleted',  (SELECT COUNT(*) FROM risk_deleted),
    'radar_deleted', (SELECT COUNT(*) FROM radar_deleted),
    'retain_count',  retain_count,
    'executed_at',   now()
  );
$$;


ALTER FUNCTION "public"."prune_old_agent_results"("retain_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_adaptive_outcome"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text", "p_predicted_score" numeric, "p_actual_outcome" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  rec RECORD;

  -- Constants
  learning_rate NUMERIC := 0.02;
  smoothing NUMERIC := 0.10;

  -- Variables
  prediction NUMERIC;
  error NUMERIC;
  delta NUMERIC;

  new_skills NUMERIC;
  new_experience NUMERIC;
  new_education NUMERIC;
  new_projects NUMERIC;

  total NUMERIC;
  accuracy NUMERIC;

  new_performance NUMERIC;
  new_confidence NUMERIC;

BEGIN
  -- Fetch or create
  SELECT *
  INTO rec
  FROM adaptive_weights
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag
  LIMIT 1;

  IF rec IS NULL THEN
    INSERT INTO adaptive_weights (
      role_family,
      experience_bucket,
      industry_tag,
      skills,
      experience,
      education,
      projects,
      performance_score,
      confidence_score
    )
    VALUES (
      p_role_family,
      p_experience_bucket,
      p_industry_tag,
      0.40, 0.25, 0.15, 0.20,
      0.50,
      0.50
    )
    RETURNING * INTO rec;
  END IF;

  -- Freeze learning
  IF rec.freeze_learning = TRUE THEN
    RETURN jsonb_build_object('updated', false);
  END IF;

  -- Prediction error
  prediction := p_predicted_score / 100;
  error := p_actual_outcome - prediction;
  delta := learning_rate * error;

  -- Apply delta + clamp
  new_skills     := LEAST(0.60, GREATEST(0.10, rec.skills + delta));
  new_experience := LEAST(0.60, GREATEST(0.10, rec.experience + delta));
  new_education  := LEAST(0.60, GREATEST(0.10, rec.education + delta));
  new_projects   := LEAST(0.60, GREATEST(0.10, rec.projects + delta));

  -- Normalize
  total := new_skills + new_experience + new_education + new_projects;

  new_skills     := new_skills / total;
  new_experience := new_experience / total;
  new_education  := new_education / total;
  new_projects   := new_projects / total;

  -- Accuracy + EMA
  accuracy := 1 - ABS(error);

  new_performance :=
    smoothing * accuracy +
    (1 - smoothing) * rec.performance_score;

  -- Confidence
  IF new_performance > 0.55 THEN
    new_confidence := rec.confidence_score + 0.02;
  ELSE
    new_confidence := rec.confidence_score - 0.03;
  END IF;

  new_confidence := LEAST(0.99, GREATEST(0.01, new_confidence));

  -- Update
  UPDATE adaptive_weights
  SET
    skills = new_skills,
    experience = new_experience,
    education = new_education,
    projects = new_projects,
    performance_score = new_performance,
    confidence_score = new_confidence,
    updated_at = NOW()
  WHERE role_family = p_role_family
    AND experience_bucket = p_experience_bucket
    AND industry_tag = p_industry_tag;

  RETURN jsonb_build_object(
    'updated', true,
    'weights', jsonb_build_object(
      'skills', new_skills,
      'experience', new_experience,
      'education', new_education,
      'projects', new_projects
    ),
    'performanceScore', new_performance,
    'confidenceScore', new_confidence
  );
END;
$$;


ALTER FUNCTION "public"."record_adaptive_outcome"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text", "p_predicted_score" numeric, "p_actual_outcome" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_click_popularity"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN

  REFRESH MATERIALIZED VIEW CONCURRENTLY most_clicked_roles;
  REFRESH MATERIALIZED VIEW CONCURRENTLY most_clicked_roles_recent;

  RETURN jsonb_build_object(
    'success',    true,
    'refreshed',  ARRAY['most_clicked_roles', 'most_clicked_roles_recent'],
    'refreshed_at', now()
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'refresh_click_popularity failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."refresh_click_popularity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_remaining integer;
BEGIN
    -- -------------------------------------------------------------------------
    -- Lock the row to serialise concurrent refunds / deductions on same user.
    -- -------------------------------------------------------------------------
    PERFORM id
    FROM    public.users
    WHERE   id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', p_user_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- -------------------------------------------------------------------------
    -- Atomic increment + timestamp update.
    -- No balance cap is enforced here — if a cap is needed add it explicitly.
    -- -------------------------------------------------------------------------
    UPDATE public.users
    SET
        ai_credits_remaining = ai_credits_remaining + p_amount,
        updated_at           = now()
    WHERE id = p_user_id
    RETURNING ai_credits_remaining INTO v_remaining;

    RETURN v_remaining;

EXCEPTION
    WHEN no_data_found THEN
        RAISE;
    WHEN OTHERS THEN
        RAISE EXCEPTION 'refund_ai_credits failed for user %: % (%)',
                        p_user_id, SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_sync_lock"("p_lock_key" "text", "p_instance_id" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_row sync_locks%ROWTYPE;
BEGIN

  -- Lock the row exclusively — prevents concurrent release races
  SELECT * INTO v_row
  FROM sync_locks
  WHERE lock_id = p_lock_key
  FOR UPDATE;

  -- Lock doesn't exist
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Wrong owner — only the instance that acquired can release
  IF v_row.locked_by IS DISTINCT FROM p_instance_id THEN
    RETURN false;
  END IF;

  -- Lock is already idle — idempotent, safe to return true
  IF v_row.status = 'idle' THEN
    RETURN true;
  END IF;

  -- Release: flip to idle, clear owner, stamp released_at, clear expires_at
  UPDATE sync_locks SET
    status      = 'idle',
    locked_by   = NULL,
    locked_at   = NULL,
    released_at = now(),
    expires_at  = NULL,
    updated_at  = now()
  WHERE lock_id = p_lock_key;

  RETURN true;

END;
$$;


ALTER FUNCTION "public"."release_sync_lock"("p_lock_key" "text", "p_instance_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_user_skills"("p_user_id" "text", "p_skill_names" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current_skills  jsonb;        -- existing skills array from the row
  v_lower_targets   text[];       -- lower-cased version of caller's list
  v_updated_skills  jsonb;        -- skills after removal
  v_removed_count   int;
  v_result          jsonb;
BEGIN

  -- ── 1. Input guards ──────────────────────────────────────────────────────

  IF p_user_id IS NULL OR trim(p_user_id) = '' THEN
    RAISE EXCEPTION 'remove_user_skills: p_user_id must not be null or empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Nothing to remove – return early without touching the DB.
  IF p_skill_names IS NULL OR array_length(p_skill_names, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'removed_count',   0,
      'updated_skills',  '[]'::jsonb
    );
  END IF;

  -- ── 2. Build lower-cased target set for case-insensitive comparison ──────

  SELECT array_agg(lower(trim(s)))
  INTO   v_lower_targets
  FROM   unnest(p_skill_names) AS s
  WHERE  trim(s) <> '';         -- silently skip blank entries

  -- All entries were blank strings after trimming – nothing to do.
  IF v_lower_targets IS NULL THEN
    RETURN jsonb_build_object(
      'removed_count',   0,
      'updated_skills',  '[]'::jsonb
    );
  END IF;

  -- ── 3. Fetch current skills (row-level lock for the duration of the txn) ─

  SELECT COALESCE(skills, '[]'::jsonb)
  INTO   v_current_skills
  FROM   public.user_profiles
  WHERE  id = p_user_id
  FOR UPDATE;             -- prevents concurrent mutations on the same row

  -- User not found – return gracefully (idempotent, no error).
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'removed_count',   0,
      'updated_skills',  '[]'::jsonb
    );
  END IF;

  -- ── 4. Filter out matching skills ────────────────────────────────────────
  --
  -- Each element in the JSONB array is expected to be either:
  --   • a plain string   → e.g. "JavaScript"
  --   • an object        → e.g. {"name":"JavaScript","level":"advanced"}
  --
  -- Both shapes are handled: we match on the element itself (if a string)
  -- or on element->>'name' (if an object).  Unrecognised shapes are kept.

  SELECT jsonb_agg(elem)
  INTO   v_updated_skills
  FROM   jsonb_array_elements(v_current_skills) AS elem
  WHERE  NOT (
    -- plain string element
    (jsonb_typeof(elem) = 'string'
      AND lower(elem #>> '{}') = ANY(v_lower_targets))
    OR
    -- object element with a "name" key
    (jsonb_typeof(elem) = 'object'
      AND lower(elem->>'name') = ANY(v_lower_targets))
  );

  -- jsonb_agg returns NULL when every element is filtered out.
  v_updated_skills := COALESCE(v_updated_skills, '[]'::jsonb);

  -- ── 5. Compute removed count ──────────────────────────────────────────────

  v_removed_count := jsonb_array_length(v_current_skills)
                   - jsonb_array_length(v_updated_skills);

  -- ── 6. Persist only when something actually changed ───────────────────────

  IF v_removed_count > 0 THEN
    UPDATE public.user_profiles
    SET    skills     = v_updated_skills,
           updated_at = now()
    WHERE  id = p_user_id;
  END IF;

  -- ── 7. Return result payload ───────────────────────────────────────────────

  v_result := jsonb_build_object(
    'removed_count',   v_removed_count,
    'updated_skills',  v_updated_skills
  );

  RETURN v_result;

END;
$$;


ALTER FUNCTION "public"."remove_user_skills"("p_user_id" "text", "p_skill_names" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_career_predictions: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM lmi_career_predictions WHERE student_id = p_student_id;

  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO lmi_career_predictions (student_id, career_name, success_probability)
    SELECT p_student_id, r.career_name, r.success_probability
    FROM jsonb_to_recordset(p_rows) AS r(
      career_name         TEXT,
      success_probability NUMERIC
    );
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  -- -----------------------------------------------------------------
  -- Guard: validate input is a JSON array (not null / object / scalar)
  -- -----------------------------------------------------------------
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_career_predictions: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- -----------------------------------------------------------------
  -- Atomic replace: DELETE then INSERT in a single transaction block.
  -- If INSERT fails, the DELETE is automatically rolled back by
  -- PostgreSQL — the student's previous rows are restored.
  -- -----------------------------------------------------------------
  DELETE FROM lmi_career_predictions
  WHERE student_id = p_student_id;

  -- Skip INSERT entirely when the caller sends an empty array.
  -- jsonb_to_recordset raises an error on '[]', so we guard here.
  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO lmi_career_predictions (student_id, career_name, success_probability)
    SELECT
      p_student_id,
      r.career_name,
      r.success_probability
    FROM jsonb_to_recordset(p_rows) AS r(
      career_name          TEXT,
      success_probability  NUMERIC
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") IS 'Atomically replaces all lmi_career_predictions rows for a student. DELETE + INSERT execute in one transaction; any INSERT failure rolls back the DELETE, preserving the student''s previous data.';



CREATE OR REPLACE FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_career_simulations: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM edu_career_simulations WHERE student_id = p_student_id;

  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO edu_career_simulations (
      student_id, career_name, probability, entry_salary,
      salary_3_year, salary_5_year, salary_10_year,
      annual_growth_rate, demand_level, roi_level,
      best_education_path, milestones
    )
    SELECT
      p_student_id, r.career_name, r.probability, r.entry_salary,
      r.salary_3_year, r.salary_5_year, r.salary_10_year,
      r.annual_growth_rate, r.demand_level, r.roi_level,
      r.best_education_path, r.milestones
    FROM jsonb_to_recordset(p_rows) AS r(
      career_name         TEXT,
      probability         NUMERIC,
      entry_salary        NUMERIC,
      salary_3_year       NUMERIC,
      salary_5_year       NUMERIC,
      salary_10_year      NUMERIC,
      annual_growth_rate  NUMERIC,
      demand_level        TEXT,
      roi_level           TEXT,
      best_education_path TEXT,
      milestones          JSONB
    );
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_career_simulations: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM edu_career_simulations
  WHERE student_id = p_student_id;

  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO edu_career_simulations (
      student_id,
      career_name,
      probability,
      entry_salary,
      salary_3_year,
      salary_5_year,
      salary_10_year,
      annual_growth_rate,
      demand_level,
      roi_level,
      best_education_path,
      milestones
    )
    SELECT
      p_student_id,
      r.career_name,
      r.probability,
      r.entry_salary,
      r.salary_3_year,
      r.salary_5_year,
      r.salary_10_year,
      r.annual_growth_rate,
      r.demand_level,
      r.roi_level,
      r.best_education_path,
      r.milestones          -- kept as jsonb; matches orchestrator's milestones array
    FROM jsonb_to_recordset(p_rows) AS r(
      career_name         TEXT,
      probability         NUMERIC,
      entry_salary        NUMERIC,
      salary_3_year       NUMERIC,
      salary_5_year       NUMERIC,
      salary_10_year      NUMERIC,
      annual_growth_rate  NUMERIC,
      demand_level        TEXT,
      roi_level           TEXT,
      best_education_path TEXT,
      milestones          JSONB
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") IS 'Atomically replaces all edu_career_simulations rows for a student. DELETE + INSERT execute in one transaction; any INSERT failure rolls back the DELETE, preserving the student''s previous data.';



CREATE OR REPLACE FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_education_roi: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM edu_education_roi WHERE student_id = p_student_id;

  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO edu_education_roi (
      student_id, education_path, duration_years, estimated_cost,
      expected_salary, roi_score, roi_level, matched_careers
    )
    SELECT
      p_student_id, r.education_path, r.duration_years, r.estimated_cost,
      r.expected_salary, r.roi_score, r.roi_level, r.matched_careers
    FROM jsonb_to_recordset(p_rows) AS r(
      education_path  TEXT,
      duration_years  NUMERIC,
      estimated_cost  NUMERIC,
      expected_salary NUMERIC,
      roi_score       NUMERIC,
      roi_level       TEXT,
      matched_careers JSONB
    );
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_education_roi: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM edu_education_roi
  WHERE student_id = p_student_id;

  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO edu_education_roi (
      student_id,
      education_path,
      duration_years,
      estimated_cost,
      expected_salary,
      roi_score,
      roi_level,
      matched_careers
    )
    SELECT
      p_student_id,
      r.education_path,
      r.duration_years,
      r.estimated_cost,
      r.expected_salary,
      r.roi_score,
      r.roi_level,
      r.matched_careers
    FROM jsonb_to_recordset(p_rows) AS r(
      education_path  TEXT,
      duration_years  NUMERIC,
      estimated_cost  NUMERIC,
      expected_salary NUMERIC,
      roi_score       NUMERIC,
      roi_level       TEXT,
      matched_careers JSONB        -- stored as jsonb / text[] — adjust if your
                                   -- schema uses TEXT[]; cast below if needed
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") IS 'Atomically replaces all edu_education_roi rows for a student. DELETE + INSERT execute in one transaction; any INSERT failure rolls back the DELETE, preserving the student''s previous data.';



CREATE OR REPLACE FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  -- -------------------------------------------------------------------
  -- Guard: validate input is a JSON array before touching any data.
  -- Rejects null / object / scalar payloads before the DELETE runs —
  -- a bad payload can never wipe the student's existing records.
  -- -------------------------------------------------------------------
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION
      'replace_student_academic_records: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- -------------------------------------------------------------------
  -- Atomic replace.
  -- DELETE + INSERT execute inside the same transaction block.
  -- If INSERT fails for any reason, PostgreSQL automatically rolls
  -- back the DELETE — the student's previous rows are fully restored.
  -- -------------------------------------------------------------------
  DELETE FROM edu_academic_records
  WHERE student_id = p_student_id;

  -- jsonb_to_recordset raises an error on '[]' — guard before calling.
  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO edu_academic_records (student_id, subject, class_level, marks)
    SELECT
      p_student_id,
      r.subject,
      r.class_level,
      r.marks
    FROM jsonb_to_recordset(p_rows) AS r(
      subject     TEXT,
      class_level TEXT,
      marks       NUMERIC
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") IS 'Atomically replaces all edu_academic_records rows for a student. DELETE + INSERT run in one transaction — INSERT failure rolls back the DELETE, preserving the student''s previous academic data.';



CREATE OR REPLACE FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION
      'replace_student_activities: p_rows must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM edu_extracurricular
  WHERE student_id = p_student_id;

  IF jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO edu_extracurricular (student_id, activity_name, activity_level)
    SELECT
      p_student_id,
      r.activity_name,
      r.activity_level
    FROM jsonb_to_recordset(p_rows) AS r(
      activity_name  TEXT,
      activity_level TEXT
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") IS 'Atomically replaces all edu_extracurricular rows for a student. DELETE + INSERT run in one transaction — INSERT failure rolls back the DELETE, preserving the student''s previous activity data.';



CREATE OR REPLACE FUNCTION "public"."resolve_search_weights"("p_weights" "jsonb" DEFAULT NULL::"jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT jsonb_build_object(
    'fts',        COALESCE((p_weights->>'fts')::float,        0.5),
    'similarity', COALESCE((p_weights->>'similarity')::float, 0.3),
    'prefix',     COALESCE((p_weights->>'prefix')::float,     0.15),
    'recency',    COALESCE((p_weights->>'recency')::float,    0.05),
    'popularity', COALESCE((p_weights->>'popularity')::float, 0.1)
  );
$$;


ALTER FUNCTION "public"."resolve_search_weights"("p_weights" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."retry_outbox_event"("p_id" "uuid", "p_error" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  UPDATE public.event_outbox
  SET
    processed_at = NULL,            -- back to pending
    retry_count  = retry_count + 1,
    last_error   = COALESCE(p_error, last_error)
  WHERE id = p_id;
$$;


ALTER FUNCTION "public"."retry_outbox_event"("p_id" "uuid", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."roles_search_vector_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'english',
    coalesce(NEW.role_name, '')                                    || ' ' ||
    coalesce(NEW.normalized_name, '')                              || ' ' ||
    coalesce(NEW.description, '')                                  || ' ' ||
    coalesce(NEW.seniority_level, '')                              || ' ' ||
    coalesce(NEW.track, '')                                        || ' ' ||
    coalesce(NEW.role_family, '')                                  || ' ' ||
    coalesce(array_to_string(NEW.alternative_titles, ' '), '')
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."roles_search_vector_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."roles_search_vector_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.role_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(NEW.alternative_titles, ' '), '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."roles_search_vector_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sch_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sch_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_cms_roles"("p_query" "text", "p_limit" integer DEFAULT 20, "p_agency" "text" DEFAULT NULL::"text", "p_job_family_id" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_threshold" double precision DEFAULT 0.1) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  v_query     text;
  v_limit     int;
  v_threshold float;
  v_roles     jsonb;
BEGIN

  IF p_query IS NULL OR trim(p_query) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: query is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_query     := lower(trim(p_query));
  v_limit     := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_threshold := COALESCE(p_threshold, 0.1);

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
  INTO v_roles
  FROM (
    SELECT
      id,
      name,
      normalized_name,
      job_family_id,
      level,
      track,
      description,
      alternative_titles,
      source_agency,
      status,
      created_at,

      -- Relevance tier for deterministic ordering:
      -- 1 = exact, 2 = prefix, 3 = trigram partial
      CASE
        WHEN normalized_name = v_query                    THEN 1
        WHEN normalized_name LIKE v_query || '%'          THEN 2
        ELSE 3
      END AS match_tier,

      -- Continuous similarity score for ranking within tier 3
      similarity(normalized_name, v_query) AS sim_score

    FROM cms_roles
    WHERE soft_deleted = false
      AND (
        normalized_name = v_query
        OR normalized_name LIKE v_query || '%'
        OR similarity(normalized_name, v_query) >= v_threshold
        OR name ILIKE '%' || p_query || '%'
      )
      -- Optional filters
      AND (p_agency        IS NULL OR source_agency  = p_agency)
      AND (p_job_family_id IS NULL OR job_family_id  = p_job_family_id)
      AND (p_status        IS NULL OR status         = p_status)

    ORDER BY
      match_tier ASC,
      sim_score  DESC,
      created_at DESC
    LIMIT v_limit
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'roles',     v_roles,
      'query',     p_query,
      'returned',  jsonb_array_length(v_roles)
    )
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'search_cms_roles failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."search_cms_roles"("p_query" "text", "p_limit" integer, "p_agency" "text", "p_job_family_id" "text", "p_status" "text", "p_threshold" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_roles"("p_query" "text", "p_agency" "text", "p_limit" integer DEFAULT 20) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  v_query   tsquery;
  v_limit   int;
  v_roles   jsonb;
  v_total   int;
BEGIN

  IF p_query IS NULL OR trim(p_query) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: query is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_agency IS NULL OR trim(p_agency) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: agency is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_query := plainto_tsquery('english', trim(p_query));

  -- Guard against stop-word-only queries
  IF v_query IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'data', jsonb_build_object(
        'roles',    '[]'::jsonb,
        'total',    0,
        'query',    trim(p_query),
        'returned', 0
      )
    );
  END IF;

  -- Main search: GIN index on search_vector drives candidate retrieval.
  -- ts_rank with normalization 1 scores by weight without length bias.
  -- Future: add vector similarity score here for hybrid ranking.
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
  INTO v_roles
  FROM (
    SELECT
      role_id,
      role_name,
      seniority_level,
      track,
      role_family,
      normalized_name,
      alternative_titles,
      description,
      agency,
      created_at,
      ts_rank(search_vector, v_query, 1) AS rank
    FROM roles
    WHERE agency        = p_agency
      AND soft_deleted  = false
      AND search_vector @@ v_query
    ORDER BY
      ts_rank(search_vector, v_query, 1) DESC,
      created_at DESC
    LIMIT v_limit
  ) r;

  -- Separate count query using same GIN index path
  SELECT COUNT(*)
  INTO v_total
  FROM roles
  WHERE agency        = p_agency
    AND soft_deleted  = false
    AND search_vector @@ v_query;

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'roles',    v_roles,
      'total',    v_total,
      'query',    trim(p_query),
      'returned', jsonb_array_length(v_roles)
    )
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'search_roles failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."search_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_roles_hybrid"("p_query" "text", "p_agency" "text", "p_limit" integer DEFAULT 20, "p_threshold" double precision DEFAULT 0.1, "p_weights" "jsonb" DEFAULT NULL::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  v_query          tsquery;
  v_limit          int;
  v_threshold      float;
  v_weights        jsonb;
  v_weight_error   text;
  v_roles          jsonb;
  v_w_fts          float;
  v_w_similarity   float;
  v_w_prefix       float;
  v_w_recency      float;
  v_w_popularity   float;
BEGIN

  IF p_query IS NULL OR trim(p_query) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: query is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_agency IS NULL OR trim(p_agency) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: agency is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_weights IS NOT NULL THEN
    v_weight_error := validate_search_weights(p_weights);
    IF v_weight_error IS NOT NULL THEN
      RAISE EXCEPTION '%', v_weight_error
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  v_limit        := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_threshold    := COALESCE(p_threshold, 0.1);
  v_query        := plainto_tsquery('english', trim(p_query));
  v_weights      := resolve_search_weights(p_weights);
  v_w_fts        := (v_weights->>'fts')::float;
  v_w_similarity := (v_weights->>'similarity')::float;
  v_w_prefix     := (v_weights->>'prefix')::float;
  v_w_recency    := (v_weights->>'recency')::float;
  v_w_popularity := (v_weights->>'popularity')::float;

  IF v_query IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'data', jsonb_build_object(
        'roles',    '[]'::jsonb,
        'total',    0,
        'query',    trim(p_query),
        'weights',  v_weights,
        'returned', 0
      )
    );
  END IF;

  SELECT COALESCE(jsonb_agg(r ORDER BY r.rank_score DESC), '[]'::jsonb)
  INTO v_roles
  FROM (
    SELECT
      ro.role_id,
      ro.role_name,
      ro.role_family,
      ro.seniority_level,
      ro.track,
      ro.alternative_titles,
      ro.agency,
      ro.created_at,
      COALESCE(mc.click_count, 0)      AS click_count,
      COALESCE(mc.popularity_score, 0) AS popularity_score,
      ts_rank(ro.search_vector, v_query, 1)                        AS fts_score,
      similarity(ro.normalized_name, lower(trim(p_query)))         AS sim_score,
      CASE WHEN ro.normalized_name LIKE lower(trim(p_query)) || '%'
           THEN true ELSE false END                                 AS is_prefix,
      exp(-extract(epoch FROM (now() - ro.created_at)) / 86400.0
          / 30.0)                                                   AS recency_score,
      (
        ts_rank(ro.search_vector, v_query, 1)
          * v_w_fts
        +
        similarity(ro.normalized_name, lower(trim(p_query)))
          * v_w_similarity
        +
        CASE WHEN ro.normalized_name LIKE lower(trim(p_query)) || '%'
             THEN v_w_prefix ELSE 0 END
        +
        exp(-extract(epoch FROM (now() - ro.created_at)) / 86400.0
            / 30.0)
          * v_w_recency
        +
        COALESCE(mc.popularity_score, 0)
          * v_w_popularity
      ) AS rank_score
    FROM roles ro
    LEFT JOIN most_clicked_roles mc
           ON mc.role_id = ro.role_id
          AND mc.agency  = ro.agency
    WHERE ro.agency        = p_agency
      AND ro.soft_deleted  = false
      AND (
        (v_query IS NOT NULL AND ro.search_vector @@ v_query)
        OR
        similarity(ro.normalized_name, lower(trim(p_query))) >= v_threshold
        OR
        ro.normalized_name LIKE lower(trim(p_query)) || '%'
      )
    ORDER BY rank_score DESC
    LIMIT v_limit
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'roles',    v_roles,
      'total',    jsonb_array_length(v_roles),
      'query',    trim(p_query),
      'weights',  v_weights,
      'returned', jsonb_array_length(v_roles)
    )
  );

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'search_roles_hybrid failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."search_roles_hybrid"("p_query" "text", "p_agency" "text", "p_limit" integer, "p_threshold" double precision, "p_weights" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_consent_versions"("versions" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  v        JSONB;
  v_count  INT;
BEGIN
  -- Guard: input must be a non-empty JSON array
  IF jsonb_typeof(versions) != 'array' THEN
    RAISE EXCEPTION 'seed_consent_versions: input must be a JSON array, got %',
      jsonb_typeof(versions);
  END IF;

  v_count := jsonb_array_length(versions);

  IF v_count = 0 THEN
    RAISE EXCEPTION 'seed_consent_versions: versions array must not be empty';
  END IF;

  -- Step 1: Upsert each version in the incoming array.
  -- ON CONFLICT (version) preserves created_at by only updating
  -- the mutable fields — never overwriting the original insert timestamp.
  FOR v IN SELECT * FROM jsonb_array_elements(versions)
  LOOP
    -- Field-level validation inside the DB for defence in depth
    IF (v->>'version') IS NULL OR trim(v->>'version') = '' THEN
      RAISE EXCEPTION 'seed_consent_versions: missing version field in element %', v;
    END IF;
    IF (v->>'label') IS NULL OR trim(v->>'label') = '' THEN
      RAISE EXCEPTION 'seed_consent_versions: missing label for version %', v->>'version';
    END IF;
    IF (v->>'effective_date') IS NULL THEN
      RAISE EXCEPTION 'seed_consent_versions: missing effective_date for version %', v->>'version';
    END IF;
    IF (v->>'tos_url') IS NULL OR (v->>'privacy_url') IS NULL THEN
      RAISE EXCEPTION 'seed_consent_versions: missing tos_url or privacy_url for version %', v->>'version';
    END IF;

    INSERT INTO public.consent_versions (
      version,
      label,
      effective_date,
      deprecated,
      tos_url,
      privacy_url,
      created_at
    )
    VALUES (
      v->>'version',
      v->>'label',
      (v->>'effective_date')::date,
      COALESCE((v->>'deprecated')::boolean, false),
      v->>'tos_url',
      v->>'privacy_url',
      now()                          -- set on first insert only
    )
    ON CONFLICT (version) DO UPDATE
      SET
        label          = EXCLUDED.label,
        effective_date = EXCLUDED.effective_date,
        deprecated     = EXCLUDED.deprecated,
        tos_url        = EXCLUDED.tos_url,
        privacy_url    = EXCLUDED.privacy_url;
        -- created_at intentionally omitted: preserves original insert timestamp
  END LOOP;

  -- Step 2: Deprecate every version NOT present in the incoming array.
  -- Uses a subquery against the JSONB array so no temp table is needed.
  UPDATE public.consent_versions
  SET deprecated = true
  WHERE version NOT IN (
    SELECT jsonb_array_elements_text(
      jsonb_path_query_array(versions, '$[*].version')
    )
  )
  AND deprecated IS DISTINCT FROM true;  -- skip rows already deprecated (no-op update avoidance)

END;
$_$;


ALTER FUNCTION "public"."seed_consent_versions"("versions" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_user_and_profile"("p_user_id" "text", "p_email" "text", "p_display_name" "text", "p_photo_url" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_created_user    boolean := false;
  v_created_profile boolean := false;
  v_row_count       integer;
BEGIN

  -- ── users (id is uuid) ─────────────────────────────────────────────────────
  INSERT INTO users (
    id,
    uid,
    email,
    display_name,
    tier,
    plan_amount,
    report_unlocked,
    onboarding_completed,
    resume_uploaded,
    subscription_status,
    subscription_provider,
    subscription_id
  )
  VALUES (
    p_user_id::uuid,   -- users.id is uuid
    p_user_id,         -- uid is text
    p_email,
    p_display_name,
    'free',
    NULL,
    false,
    false,
    false,
    'inactive',
    NULL,
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_created_user := (v_row_count > 0);

  -- ── user_profiles (id is text) ─────────────────────────────────────────────
  INSERT INTO user_profiles (
    id,
    uid,
    email,
    display_name,
    photo_url,
    onboarding_completed,
    career_history,
    expected_role_ids,
    skills,
    resume_uploaded,
    consent_granted_at,
    consent_version,
    consent_source
  )
  VALUES (
    p_user_id,         -- user_profiles.id is text
    p_user_id,
    p_email,
    p_display_name,
    p_photo_url,
    false,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    false,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_created_profile := (v_row_count > 0);

  RETURN jsonb_build_object(
    'created_user',    v_created_user,
    'created_profile', v_created_profile
  );

END;
$$;


ALTER FUNCTION "public"."seed_user_and_profile"("p_user_id" "text", "p_email" "text", "p_display_name" "text", "p_photo_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_updated_at"() IS 'Reusable BEFORE UPDATE trigger — stamps updated_at = NOW(). Shared across edu_ and pi_ table families.';



CREATE OR REPLACE FUNCTION "public"."sync_career_predictions"("p_student_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE edu_career_predictions
  SET predictions = agg.predictions_array
  FROM (
    SELECT
      student_id,
      jsonb_agg(
        jsonb_build_object(
          'career_name',         career_name,
          'success_probability', success_probability
        )
        ORDER BY success_probability DESC NULLS LAST
      ) AS predictions_array
    FROM  edu_career_predictions
    WHERE student_id = p_student_id
    GROUP BY student_id
  ) agg
  WHERE edu_career_predictions.student_id = agg.student_id;
END;
$$;


ALTER FUNCTION "public"."sync_career_predictions"("p_student_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sync_career_predictions"("p_student_id" "uuid") IS 'Rebuilds the denormalised predictions JSONB column from normalised row-per-career data for a given student. Call after any INSERT/UPDATE/DELETE on edu_career_predictions. Used by studentMatching.service.js syncPredictionsColumn().';



CREATE OR REPLACE FUNCTION "public"."sync_user_display_fields"("p_user_id" "uuid", "p_display_name" "text", "p_photo_url" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_users_updated   boolean := false;
  v_profile_updated boolean := false;
  v_row_count       integer;
BEGIN

  UPDATE users
  SET display_name = p_display_name
  WHERE id = p_user_id;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_users_updated := (v_row_count > 0);

  UPDATE user_profiles
  SET
    display_name = p_display_name,
    photo_url    = p_photo_url
  WHERE id = p_user_id::text;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_profile_updated := (v_row_count > 0);

  RETURN jsonb_build_object(
    'users_updated',   v_users_updated,
    'profile_updated', v_profile_updated
  );

END;
$$;


ALTER FUNCTION "public"."sync_user_display_fields"("p_user_id" "uuid", "p_display_name" "text", "p_photo_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_user_tier_plan"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.tier IS DISTINCT FROM OLD.tier THEN NEW.plan := NEW.tier; END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan THEN NEW.tier := NEW.plan; END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_user_tier_plan"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."track_click_event"("p_query" "text", "p_role_id" "text", "p_role_name" "text", "p_position" integer, "p_match_type" "text", "p_agency" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_normalized text;
  v_id         uuid;
BEGIN

  IF p_query IS NULL OR trim(p_query) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: query is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_role_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: role_id is required for click events'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_position IS NULL OR p_position < 1 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: position must be >= 1'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_agency IS NULL OR trim(p_agency) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: agency is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_match_type IS NOT NULL AND p_match_type NOT IN ('prefix', 'fts', 'fuzzy_name', 'fuzzy_composite') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: invalid match_type "%"', p_match_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_normalized := normalize_query(p_query);

  INSERT INTO search_events (
    query,
    normalized_query,
    event_type,
    role_id,
    role_name,
    position,
    match_type,
    agency,
    user_id,
    created_at
  )
  VALUES (
    trim(p_query),
    v_normalized,
    'click',
    p_role_id,
    trim(COALESCE(p_role_name, '')),
    p_position,
    p_match_type,
    trim(p_agency),
    auth.uid(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'id', v_id);

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'track_click_event failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."track_click_event"("p_query" "text", "p_role_id" "text", "p_role_name" "text", "p_position" integer, "p_match_type" "text", "p_agency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."track_search_event"("p_query" "text", "p_agency" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_normalized text;
  v_id         uuid;
BEGIN

  IF p_query IS NULL OR trim(p_query) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: query is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_agency IS NULL OR trim(p_agency) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: agency is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_normalized := normalize_query(p_query);

  INSERT INTO search_events (
    query,
    normalized_query,
    event_type,
    agency,
    user_id,
    created_at
  )
  VALUES (
    trim(p_query),
    v_normalized,
    'search',
    trim(p_agency),
    auth.uid(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'id', v_id);

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'track_search_event failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."track_search_event"("p_query" "text", "p_agency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_fn_career_roles_search_vector"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.role_name, '') || ' ' ||
    COALESCE(NEW.normalized_name, '') || ' ' ||
    COALESCE(NEW.role_family, '') || ' ' ||
    COALESCE(array_to_string(NEW.alternative_titles, ' '), '')
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trg_fn_career_roles_search_vector"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_fn_career_skills_search_vector"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.skill_name, '') || ' ' ||
    COALESCE(NEW.normalized_name, '') || ' ' ||
    COALESCE(NEW.skill_category, '')
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trg_fn_career_skills_search_vector"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_role"("p_role_id" "text", "p_updates" "jsonb", "p_updated_by" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_existing        roles%ROWTYPE;
  v_new_name        text;
  v_normalized      text;
  v_new_family      text;
  v_new_seniority   text;
  v_new_track       text;
  v_new_description text;
  v_new_alt_titles  text[];
  v_new_agency      text;
  v_changed         boolean := false;
  v_result          jsonb;
BEGIN

  IF p_role_id IS NULL OR trim(p_role_id) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: role_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_updated_by IS NULL OR trim(p_updated_by) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: updated_by is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_updates IS NULL OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: no update fields provided'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_existing
  FROM roles
  WHERE role_id      = p_role_id
    AND soft_deleted = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Role "%" does not exist', p_role_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- role_name
  IF p_updates ? 'role_name' THEN
    v_new_name := trim(p_updates->>'role_name');
    IF v_new_name = '' THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: role_name cannot be empty'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_normalized := lower(v_new_name);
    IF v_normalized <> v_existing.normalized_name THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_name   := v_existing.role_name;
    v_normalized := v_existing.normalized_name;
  END IF;

  -- role_family
  IF p_updates ? 'role_family' THEN
    v_new_family := NULLIF(trim(p_updates->>'role_family'), '');
    IF v_new_family IS DISTINCT FROM v_existing.role_family THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_family := v_existing.role_family;
  END IF;

  -- seniority_level
  IF p_updates ? 'seniority_level' THEN
    v_new_seniority := NULLIF(trim(p_updates->>'seniority_level'), '');
    IF v_new_seniority IS DISTINCT FROM v_existing.seniority_level THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_seniority := v_existing.seniority_level;
  END IF;

  -- track
  IF p_updates ? 'track' THEN
    v_new_track := NULLIF(trim(p_updates->>'track'), '');
    IF v_new_track IS DISTINCT FROM v_existing.track THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_track := v_existing.track;
  END IF;

  -- description
  IF p_updates ? 'description' THEN
    v_new_description := COALESCE(trim(p_updates->>'description'), '');
    IF v_new_description IS DISTINCT FROM v_existing.description THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_description := v_existing.description;
  END IF;

  -- alternative_titles
  IF p_updates ? 'alternative_titles' THEN
    v_new_alt_titles := ARRAY(
      SELECT trim(t)
      FROM jsonb_array_elements_text(p_updates->'alternative_titles') AS t
      WHERE trim(t) <> ''
    );
    IF v_new_alt_titles IS DISTINCT FROM v_existing.alternative_titles THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_alt_titles := v_existing.alternative_titles;
  END IF;

  -- agency
  IF p_updates ? 'agency' THEN
    v_new_agency := COALESCE(trim(p_updates->>'agency'), '');
    IF v_new_agency IS DISTINCT FROM v_existing.agency THEN
      v_changed := true;
    END IF;
  ELSE
    v_new_agency := v_existing.agency;
  END IF;

  -- Skip write if nothing changed
  IF NOT v_changed THEN
    RETURN jsonb_build_object(
      'success', true,
      'data',    to_jsonb(v_existing),
      'note',    'no changes detected, update skipped'
    );
  END IF;

  UPDATE roles SET
    role_name          = v_new_name,
    normalized_name    = v_normalized,
    role_family        = v_new_family,
    seniority_level    = v_new_seniority,
    track              = v_new_track,
    description        = v_new_description,
    alternative_titles = v_new_alt_titles,
    agency             = v_new_agency,
    updated_by         = trim(p_updated_by),
    updated_at         = now()
  WHERE role_id      = p_role_id
    AND soft_deleted = false
  RETURNING to_jsonb(roles.*) INTO v_result;

  RETURN jsonb_build_object('success', true, 'data', v_result);

EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'VALIDATION_ERROR'
    );
  WHEN no_data_found THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'code',    'NOT_FOUND'
    );
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   format('DUPLICATE_ROLE: Role "%s" already exists in agency "%s"', v_new_name, v_new_agency),
      'code',    'DUPLICATE_ROLE'
    );
  WHEN OTHERS THEN
    RAISE EXCEPTION 'update_role failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;


ALTER FUNCTION "public"."update_role"("p_role_id" "text", "p_updates" "jsonb", "p_updated_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_ai_cost_tracking_atomic"("p_user_id" "uuid", "p_feature" "text", "p_date" "date", "p_total_cost_usd" numeric, "p_input_tokens" bigint, "p_output_tokens" bigint, "p_retention_days" integer) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_id         text;
  v_expires_at timestamp with time zone;
BEGIN
  v_id         := p_user_id::text || '_' || p_feature || '_' || p_date::text;
  v_expires_at := now() + (p_retention_days || ' days')::interval;

  INSERT INTO ai_cost_tracking (
    id,
    user_id,
    feature,
    date,
    total_cost_usd,
    input_tokens,
    output_tokens,
    call_count,
    is_deleted,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    v_id,
    p_user_id,
    p_feature,
    p_date,
    p_total_cost_usd,
    p_input_tokens,
    p_output_tokens,
    1,
    false,
    v_expires_at,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    total_cost_usd = ai_cost_tracking.total_cost_usd + EXCLUDED.total_cost_usd,
    input_tokens   = ai_cost_tracking.input_tokens   + EXCLUDED.input_tokens,
    output_tokens  = ai_cost_tracking.output_tokens  + EXCLUDED.output_tokens,
    call_count     = ai_cost_tracking.call_count     + 1,
    expires_at     = v_expires_at,
    updated_at     = now(),
    is_deleted     = false;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."upsert_ai_cost_tracking_atomic"("p_user_id" "uuid", "p_feature" "text", "p_date" "date", "p_total_cost_usd" numeric, "p_input_tokens" bigint, "p_output_tokens" bigint, "p_retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_search_weights"("p_weights" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
DECLARE
  v_key   text;
  v_value float;
BEGIN
  FOR v_key, v_value IN
    SELECT key, value::float
    FROM jsonb_each_text(p_weights)
  LOOP
    IF v_value < 0 OR v_value > 1 THEN
      RETURN format('INVALID_WEIGHT: "%s" must be between 0 and 1, got %s', v_key, v_value);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."validate_search_weights"("p_weights" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."activity_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."activity_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."activity_logs" (
    "id" "text" NOT NULL,
    "action" "text",
    "user_id" "text",
    "target_id" "text",
    "metadata" "jsonb",
    "created_at" timestamp without time zone,
    "targetid" "text",
    "data" "jsonb"
);


ALTER TABLE "public"."activity_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."adaptive_weights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "experience_bucket" "text" NOT NULL,
    "skills" numeric NOT NULL,
    "experience" numeric NOT NULL,
    "education" numeric NOT NULL,
    "projects" numeric NOT NULL,
    "confidence" numeric DEFAULT 0.5,
    "performance_score" numeric DEFAULT 0.5,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."adaptive_weights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_logs" (
    "id" "text" NOT NULL,
    "admin_id" "text",
    "action" "text",
    "entity_type" "text",
    "entity_id" "text",
    "metadata" "jsonb",
    "ip_address" "text",
    "created_at" timestamp without time zone,
    "data" "jsonb"
);


ALTER TABLE "public"."admin_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_principals" (
    "uid" "text" NOT NULL,
    "role" "text" DEFAULT 'admin'::"text" NOT NULL,
    "granted_by" "text" DEFAULT 'system'::"text" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verified_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_action_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "revoked_at" timestamp with time zone,
    "revoked_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_principals_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'super_admin'::"text", 'MASTER_ADMIN'::"text"])))
);


ALTER TABLE "public"."admin_principals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_secrets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "encrypted_value" "text" NOT NULL,
    "iv" "text" NOT NULL,
    "auth_tag" "text" NOT NULL,
    "hmac" "text" NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rotation_grace_ends_at" timestamp with time zone,
    "rotated_at" timestamp with time zone,
    "rotated_by" "text",
    "previous_encrypted_value" "text",
    "previous_iv" "text",
    "previous_auth_tag" "text",
    "previous_hmac" "text"
);

ALTER TABLE ONLY "public"."admin_secrets" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_users" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."admin_users" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."admin_users_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."admin_users_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."admin_users_id_seq" OWNED BY "public"."admin_users"."id";



CREATE TABLE IF NOT EXISTS "public"."ai_alerts" (
    "id" bigint NOT NULL,
    "alert_key" "text" NOT NULL,
    "type" "text" NOT NULL,
    "feature" "text" NOT NULL,
    "severity" "public"."alert_severity" NOT NULL,
    "title" "text" NOT NULL,
    "detail" "jsonb",
    "resolved" boolean DEFAULT false NOT NULL,
    "is_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    CONSTRAINT "ai_alerts_type_check" CHECK (("type" = ANY (ARRAY['MARGIN_CRITICAL'::"text", 'MARGIN_WARNING'::"text", 'FREE_BURN_WARNING'::"text", 'FREE_BURN_CRITICAL'::"text", 'USER_COST_ANOMALY'::"text", 'COST_SPIKE'::"text"])))
);


ALTER TABLE "public"."ai_alerts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ai_alerts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ai_alerts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ai_alerts_id_seq" OWNED BY "public"."ai_alerts"."id";



CREATE TABLE IF NOT EXISTS "public"."ai_cost_daily_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "usage_date" "date" NOT NULL,
    "tier" "text" NOT NULL,
    "total_requests" integer DEFAULT 0,
    "total_input_tokens" integer DEFAULT 0,
    "total_output_tokens" integer DEFAULT 0,
    "total_cost_usd" numeric(12,6) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_cost_daily_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_cost_tracking" (
    "id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "feature" "text" NOT NULL,
    "date" "date" NOT NULL,
    "total_cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "input_tokens" bigint DEFAULT 0 NOT NULL,
    "output_tokens" bigint DEFAULT 0 NOT NULL,
    "call_count" integer DEFAULT 0 NOT NULL,
    "is_deleted" boolean DEFAULT false NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_cost_tracking" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_daily_costs" (
    "user_id" "text" NOT NULL,
    "date" "date" NOT NULL,
    "cost_usd" numeric(10,4) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_daily_costs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_jobs" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "job_id" "text",
    "user_id" "text" NOT NULL,
    "operation_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb",
    "result" "jsonb",
    "error" "jsonb",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "soft_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1
);


ALTER TABLE "public"."ai_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
)
PARTITION BY RANGE ("created_at");

ALTER TABLE ONLY "public"."ai_observability_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs_2025_q1" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_observability_logs_2025_q1" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs_2025_q2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_observability_logs_2025_q2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs_2025_q3" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_observability_logs_2025_q3" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs_2025_q4" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_observability_logs_2025_q4" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs_2026_q1" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_observability_logs_2026_q1" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_observability_logs_2026_q2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resume_id" "uuid",
    "feature" "text" NOT NULL,
    "engine" "text",
    "model" "text",
    "input_hash" "text",
    "latency_ms" integer,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(12,6),
    "fallback_used" boolean DEFAULT false,
    "fallback_model" "text",
    "circuit_breaker_triggered" boolean DEFAULT false,
    "cache_hit" boolean DEFAULT false,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_observability_logs_2026_q2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_pipeline_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "bullmq_job_id" "text",
    "queue_name" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 3 NOT NULL,
    "input_payload" "jsonb",
    "error_message" "text",
    "error_code" "text",
    "queued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    CONSTRAINT "ai_pipeline_jobs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'retrying'::"text"])))
);


ALTER TABLE "public"."ai_pipeline_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."ai_pipeline_jobs" IS 'Master job registry for every event published to the AIEventBus. BullMQ job IDs correlate here.';



CREATE TABLE IF NOT EXISTS "public"."ai_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "feature" "text" NOT NULL,
    "provider" "text",
    "model" "text",
    "tokens_used" integer DEFAULT 0,
    "cost_usd" numeric(10,6) DEFAULT 0,
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_usage_logs" (
    "id" bigint NOT NULL,
    "user_id" "text",
    "feature" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "model" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "success" boolean DEFAULT true NOT NULL,
    "error_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_usage_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ai_usage_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ai_usage_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ai_usage_logs_id_seq" OWNED BY "public"."ai_usage_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."ats_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "resume_id" "uuid",
    "score" integer NOT NULL,
    "breakdown" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "target_role" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ats_scores_score_check" CHECK ((("score" >= 0) AND ("score" <= 100)))
);


ALTER TABLE "public"."ats_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."automation_jobs" (
    "id" "text" NOT NULL,
    "user_id" "text",
    "status" "text",
    "attempts" integer,
    "max_attempts" integer,
    "worker_id" "text",
    "result" "jsonb",
    "idempotency_key" "text",
    "created_at" timestamp without time zone,
    "updated_at" timestamp without time zone,
    "claimed_at" timestamp without time zone,
    "completed_at" timestamp without time zone,
    "failed_at" timestamp without time zone,
    "deleted_at" timestamp with time zone,
    "last_error_code" "text",
    "last_error_message" "text"
);


ALTER TABLE "public"."automation_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_advice_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "advice_text" "text",
    "profile_hash" "text",
    "generated_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval)
);


ALTER TABLE "public"."career_advice_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_advice_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "job_id" "uuid",
    "career_insight" "text",
    "key_opportunity" "text",
    "salary_potential" "text",
    "timeline" "text",
    "skills_to_prioritise" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "profile_hash" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."career_advice_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."career_advice_results" IS 'Stored AI career advice output written by CareerAdvisorWorker.';



CREATE TABLE IF NOT EXISTS "public"."career_alerts" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text" NOT NULL,
    "alert_type" "text",
    "title" "text",
    "description" "text",
    "alert_priority" integer DEFAULT 3,
    "payload" "jsonb" DEFAULT '{}'::"jsonb",
    "action_url" "text",
    "dedup_key" "text",
    "is_read" boolean DEFAULT false,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."career_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_health_index" (
    "id" "text" NOT NULL,
    "snapshot_id" "text",
    "user_id" "text" NOT NULL,
    "resume_id" "text",
    "chi_score" integer,
    "chi_confidence" integer,
    "confidence" "text",
    "dimensions" "jsonb",
    "detected_profession" "text",
    "current_job_title" "text",
    "top_skills" "jsonb" DEFAULT '[]'::"jsonb",
    "estimated_experience_years" integer,
    "top_strength" "text",
    "critical_gap" "text",
    "market_position" "text",
    "peer_comparison" "text",
    "projected_level_up_months" integer,
    "current_estimated_salary_lpa" numeric,
    "next_level_estimated_salary_lpa" numeric,
    "trend" "text",
    "analysis_source" "text",
    "ai_model_version" "text",
    "region" "text",
    "generated_at" timestamp with time zone,
    "soft_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1
);


ALTER TABLE "public"."career_health_index" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_health_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "job_id" "uuid",
    "chi_score" numeric(5,2),
    "dimensions" "jsonb",
    "skill_gaps" "jsonb",
    "analysis_source" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "career_health_results_chi_score_check" CHECK ((("chi_score" >= (0)::numeric) AND ("chi_score" <= (100)::numeric)))
);


ALTER TABLE "public"."career_health_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."career_health_results" IS 'Stored CHI engine output written by CareerHealthWorker. Dashboard reads from here.';



CREATE TABLE IF NOT EXISTS "public"."career_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "chi_score" integer,
    "insights" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "analysis_source" "text" DEFAULT 'full'::"text" NOT NULL,
    "detected_profession" "text",
    "current_job_title" "text",
    "top_skills" "jsonb" DEFAULT '[]'::"jsonb",
    "dimensions" "jsonb",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "career_insights_analysis_source_check" CHECK (("analysis_source" = ANY (ARRAY['full'::"text", 'provisional'::"text", 'quick_provisional'::"text", 'resume_scored'::"text"]))),
    CONSTRAINT "career_insights_chi_score_check" CHECK ((("chi_score" >= 0) AND ("chi_score" <= 100)))
);


ALTER TABLE "public"."career_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "composite" integer NOT NULL,
    "ats_score" integer,
    "job_match" integer,
    "interview_score" integer,
    "activity_score" integer,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "career_metrics_activity_score_check" CHECK ((("activity_score" >= 0) AND ("activity_score" <= 100))),
    CONSTRAINT "career_metrics_ats_score_check" CHECK ((("ats_score" >= 0) AND ("ats_score" <= 100))),
    CONSTRAINT "career_metrics_composite_check" CHECK ((("composite" >= 0) AND ("composite" <= 100))),
    CONSTRAINT "career_metrics_interview_score_check" CHECK ((("interview_score" >= 0) AND ("interview_score" <= 100))),
    CONSTRAINT "career_metrics_job_match_check" CHECK ((("job_match" >= 0) AND ("job_match" <= 100)))
);


ALTER TABLE "public"."career_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_opportunity_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_name" "text" NOT NULL,
    "industry" "text" NOT NULL,
    "growth_rate" numeric(6,2) DEFAULT 0 NOT NULL,
    "salary_growth_rate" numeric(6,2) DEFAULT 0 NOT NULL,
    "average_salary" "text" DEFAULT '0'::"text" NOT NULL,
    "average_salary_raw" bigint DEFAULT 0 NOT NULL,
    "demand_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "emerging_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "opportunity_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "score_breakdown" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "growth_trend" "text" DEFAULT 'Moderate'::"text" NOT NULL,
    "is_emerging" boolean DEFAULT false NOT NULL,
    "data_source" "text" DEFAULT 'lmi'::"text" NOT NULL,
    "signal_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "average_salary_display" "text",
    "required_skills" "text"[],
    CONSTRAINT "career_opportunity_signals_demand_score_check" CHECK ((("demand_score" >= (0)::numeric) AND ("demand_score" <= (100)::numeric))),
    CONSTRAINT "career_opportunity_signals_emerging_score_check" CHECK ((("emerging_score" >= (0)::numeric) AND ("emerging_score" <= (100)::numeric))),
    CONSTRAINT "career_opportunity_signals_growth_trend_check" CHECK (("growth_trend" = ANY (ARRAY['Very High'::"text", 'High'::"text", 'Moderate'::"text", 'Emerging'::"text", 'Stable'::"text"]))),
    CONSTRAINT "career_opportunity_signals_opportunity_score_check" CHECK ((("opportunity_score" >= (0)::numeric) AND ("opportunity_score" <= (100)::numeric)))
);


ALTER TABLE "public"."career_opportunity_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_paths" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_role" "text" NOT NULL,
    "to_role" "text" NOT NULL,
    "avg_years" integer DEFAULT 2,
    "demand_score" integer DEFAULT 50,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "required_skills" "jsonb" DEFAULT '[]'::"jsonb"
);


ALTER TABLE "public"."career_paths" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_progress_history" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text" NOT NULL,
    "career_health_index" integer DEFAULT 0,
    "skills_count" integer DEFAULT 0,
    "job_match_score" integer DEFAULT 0,
    "chi_delta" integer,
    "skills_delta" integer,
    "job_match_delta" integer,
    "trigger_event" "text" DEFAULT 'manual'::"text",
    "snapshot" "jsonb" DEFAULT '{}'::"jsonb",
    "recorded_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."career_progress_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_readiness_scores" (
    "id" bigint NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "overall_score" numeric(5,2) NOT NULL,
    "breakdown" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "scored_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "career_readiness_scores_overall_score_check" CHECK ((("overall_score" >= (0)::numeric) AND ("overall_score" <= (100)::numeric)))
);


ALTER TABLE "public"."career_readiness_scores" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."career_readiness_scores_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."career_readiness_scores_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."career_readiness_scores_id_seq" OWNED BY "public"."career_readiness_scores"."id";



CREATE TABLE IF NOT EXISTS "public"."career_role_skills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "skill_id" "text" NOT NULL,
    "importance" "text" DEFAULT 'preferred'::"text" NOT NULL,
    "proficiency_level" "text",
    "years_required" numeric(4,1),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "career_role_skills_importance_check" CHECK (("importance" = ANY (ARRAY['required'::"text", 'preferred'::"text", 'nice_to_have'::"text"]))),
    CONSTRAINT "career_role_skills_proficiency_check" CHECK ((("proficiency_level" = ANY (ARRAY['beginner'::"text", 'intermediate'::"text", 'advanced'::"text", 'expert'::"text"])) OR ("proficiency_level" IS NULL)))
);


ALTER TABLE "public"."career_role_skills" OWNER TO "postgres";


COMMENT ON TABLE "public"."career_role_skills" IS 'Junction table: career_roles ↔ career_skills_registry.';



CREATE TABLE IF NOT EXISTS "public"."career_role_transitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_role_id" "text" NOT NULL,
    "to_role_id" "text" NOT NULL,
    "transition_type" "text" DEFAULT 'progression'::"text" NOT NULL,
    "avg_transition_years" numeric(4,1),
    "difficulty_score" numeric(5,2) DEFAULT 50 NOT NULL,
    "demand_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "required_skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "bridging_skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "median_salary_delta_lpa" numeric(8,2),
    "typical_companies" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "data_confidence" "text" DEFAULT 'low'::"text" NOT NULL,
    "sample_size" integer DEFAULT 0 NOT NULL,
    "source" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    CONSTRAINT "career_role_transitions_confidence_check" CHECK (("data_confidence" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"]))),
    CONSTRAINT "career_role_transitions_demand_check" CHECK ((("demand_score" >= (0)::numeric) AND ("demand_score" <= (100)::numeric))),
    CONSTRAINT "career_role_transitions_difficulty_check" CHECK ((("difficulty_score" >= (0)::numeric) AND ("difficulty_score" <= (100)::numeric))),
    CONSTRAINT "career_role_transitions_no_self_loop" CHECK (("from_role_id" <> "to_role_id")),
    CONSTRAINT "career_role_transitions_type_check" CHECK (("transition_type" = ANY (ARRAY['progression'::"text", 'lateral'::"text", 'pivot'::"text", 'promotion'::"text", 'specialization'::"text"])))
);


ALTER TABLE "public"."career_role_transitions" OWNER TO "postgres";


COMMENT ON TABLE "public"."career_role_transitions" IS 'Directed edges in the career graph. from_role_id → to_role_id.';



COMMENT ON COLUMN "public"."career_role_transitions"."transition_type" IS 'Edge type: progression | lateral | pivot | promotion | specialization';



COMMENT ON COLUMN "public"."career_role_transitions"."required_skills" IS 'JSONB snapshot of skills for this transition. Shape: [{ skill_id, skill_name, importance }]';



COMMENT ON COLUMN "public"."career_role_transitions"."data_confidence" IS 'Data quality confidence: low | medium | high';



CREATE TABLE IF NOT EXISTS "public"."career_roles" (
    "role_id" "text" NOT NULL,
    "role_name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "alternative_titles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "role_family" "text" NOT NULL,
    "track" "text",
    "seniority_level" "text",
    "seniority_rank" integer DEFAULT 0 NOT NULL,
    "salary_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "education_requirements" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "demand_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "search_vector" "tsvector",
    "source" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "career_roles_demand_check" CHECK ((("demand_score" >= (0)::numeric) AND ("demand_score" <= (100)::numeric))),
    CONSTRAINT "career_roles_seniority_check" CHECK (("seniority_rank" >= 0))
);


ALTER TABLE "public"."career_roles" OWNER TO "postgres";


COMMENT ON TABLE "public"."career_roles" IS 'Normalized graph nodes for career roles.';



COMMENT ON COLUMN "public"."career_roles"."role_id" IS 'Stable text slug PK. Matches roles.role_id convention.';



COMMENT ON COLUMN "public"."career_roles"."seniority_rank" IS 'Numeric seniority for traversal ordering. 0=intern, 2=junior, 4=mid, 6=senior, 8=staff/principal, 10=C-suite.';



COMMENT ON COLUMN "public"."career_roles"."salary_data" IS 'JSONB salary blob. Shape: { "INR": { min, median, max, p25, p75 }, "source", "year" }';



COMMENT ON COLUMN "public"."career_roles"."education_requirements" IS 'JSONB education blob. Shape: { minimum, preferred, fields[], certifications[] }';



COMMENT ON COLUMN "public"."career_roles"."search_vector" IS 'tsvector maintained by trg_career_roles_search_vector trigger.';



CREATE TABLE IF NOT EXISTS "public"."career_simulations" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text" NOT NULL,
    "career_path" "jsonb" DEFAULT '[]'::"jsonb",
    "salary_projection" "text",
    "risk_level" "text",
    "growth_score" integer DEFAULT 0,
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "soft_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1
);


ALTER TABLE "public"."career_simulations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."career_skills_registry" (
    "skill_id" "text" NOT NULL,
    "skill_name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "aliases" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "skill_category" "text" NOT NULL,
    "skill_subcategory" "text",
    "difficulty_level" numeric(5,2) DEFAULT 50 NOT NULL,
    "demand_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "is_emerging" boolean DEFAULT false NOT NULL,
    "is_deprecated" boolean DEFAULT false NOT NULL,
    "adjacent_skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "search_vector" "tsvector",
    "source" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "career_skills_registry_category_check" CHECK (("skill_category" = ANY (ARRAY['technical'::"text", 'soft'::"text", 'domain'::"text", 'tool'::"text", 'certification'::"text", 'language'::"text", 'other'::"text"]))),
    CONSTRAINT "career_skills_registry_demand_check" CHECK ((("demand_score" >= (0)::numeric) AND ("demand_score" <= (100)::numeric))),
    CONSTRAINT "career_skills_registry_difficulty_check" CHECK ((("difficulty_level" >= (0)::numeric) AND ("difficulty_level" <= (100)::numeric)))
);


ALTER TABLE "public"."career_skills_registry" OWNER TO "postgres";


COMMENT ON TABLE "public"."career_skills_registry" IS 'Canonical skill nodes for the career graph.';



COMMENT ON COLUMN "public"."career_skills_registry"."skill_id" IS 'Stable text slug PK. Matches skills.skill_id convention.';



COMMENT ON COLUMN "public"."career_skills_registry"."adjacent_skills" IS 'Denormalized related skills. Shape: [{ skill_id, skill_name, relationship }]';



CREATE TABLE IF NOT EXISTS "public"."certifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "url" "text",
    "related_skills" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "description" "text",
    "level" "text",
    "duration_hours" integer,
    "is_free" boolean DEFAULT false NOT NULL,
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."certifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "collection_name" "text" NOT NULL,
    "document_id" "text" NOT NULL,
    "operation" "text" NOT NULL,
    "changed_fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "previous_value" "jsonb",
    "new_value" "jsonb",
    "user_id" "text" DEFAULT 'system'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."change_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chi_scores" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "role_id" "text" NOT NULL,
    "skill_match" numeric(5,2) DEFAULT 0 NOT NULL,
    "experience_fit" numeric(5,2) DEFAULT 0 NOT NULL,
    "market_demand" numeric(5,2) DEFAULT 0 NOT NULL,
    "learning_progress" numeric(5,2) DEFAULT 0 NOT NULL,
    "chi_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "last_updated" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chi_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_career_domains" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cms_career_domains" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_education_levels" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cms_education_levels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_job_families" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cms_job_families" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "normalized_composite_key" "text" NOT NULL,
    "job_family_id" "text" NOT NULL,
    "level" "text",
    "track" "text" DEFAULT 'individual_contributor'::"text",
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "alternative_titles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "required_skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "experience_min" numeric(4,1) DEFAULT 0 NOT NULL,
    "experience_max" numeric(4,1) DEFAULT 20 NOT NULL,
    "market_demand" numeric(4,1) DEFAULT 5 NOT NULL,
    "domain_id" "text"
);


ALTER TABLE "public"."cms_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_salary_benchmarks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "min_salary" bigint,
    "median_salary" bigint,
    "max_salary" bigint,
    "year" integer,
    "currency" "text" DEFAULT 'INR'::"text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cms_salary_benchmarks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_skill_clusters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "domain_id" "text",
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cms_skill_clusters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cms_skills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "category" "text" DEFAULT 'technical'::"text" NOT NULL,
    "aliases" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "demand_score" numeric(5,2),
    "search_tokens" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_admin_id" "text" NOT NULL,
    "updated_by_admin_id" "text" NOT NULL,
    "source_agency" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cms_skills_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'pending'::"text"])))
);


ALTER TABLE "public"."cms_skills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."consent_versions" (
    "version" "text" NOT NULL,
    "label" "text" NOT NULL,
    "effective_date" "date" NOT NULL,
    "deprecated" boolean DEFAULT false,
    "tos_url" "text" NOT NULL,
    "privacy_url" "text" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."consent_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversion_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "metadata" "jsonb",
    "idempotency_key" "text",
    "timestamp" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."conversion_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "conversation_id" "text" NOT NULL,
    "turn_index" integer DEFAULT 0 NOT NULL,
    "user_message" "text" NOT NULL,
    "ai_response" "text" NOT NULL,
    "data_sources" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "confidence" numeric(4,3),
    "rag_context_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."copilot_conversations" OWNER TO "postgres";


COMMENT ON TABLE "public"."copilot_conversations" IS 'Job-seeker path Copilot conversation history with source attribution per turn.';



CREATE TABLE IF NOT EXISTS "public"."copilot_grounding_failures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "user_query" "text" NOT NULL,
    "missing_sources" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "data_completeness" numeric(4,3),
    "refusal_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."copilot_grounding_failures" OWNER TO "postgres";


COMMENT ON TABLE "public"."copilot_grounding_failures" IS 'Audit log of queries refused due to insufficient platform data. Used to prioritise data collection.';



CREATE TABLE IF NOT EXISTS "public"."copilot_rag_contexts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "conversation_id" "text" NOT NULL,
    "turn_index" integer DEFAULT 0 NOT NULL,
    "user_query" "text" NOT NULL,
    "retrieved_context" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "data_sources_used" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "confidence_score" numeric(4,3),
    "data_completeness" numeric(4,3),
    "ai_response" "text",
    "refused_generation" boolean DEFAULT false NOT NULL,
    "refusal_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "copilot_rag_contexts_confidence_score_check" CHECK ((("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (1)::numeric))),
    CONSTRAINT "copilot_rag_contexts_data_completeness_check" CHECK ((("data_completeness" >= (0)::numeric) AND ("data_completeness" <= (1)::numeric)))
);


ALTER TABLE "public"."copilot_rag_contexts" OWNER TO "postgres";


COMMENT ON TABLE "public"."copilot_rag_contexts" IS 'Full retrieved context snapshot per Copilot query. Enables complete auditability of every grounded AI response.';



COMMENT ON COLUMN "public"."copilot_rag_contexts"."confidence_score" IS 'Composite confidence: 0.4×data_completeness + 0.3×source_count/7 + 0.3×profile_completeness';



COMMENT ON COLUMN "public"."copilot_rag_contexts"."refused_generation" IS 'True when data_completeness < MIN_COMPLETENESS_THRESHOLD (0.25). The Copilot refused to speculate.';



CREATE TABLE IF NOT EXISTS "public"."courses" (
    "old_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "provider" "text",
    "level" "text",
    "duration_hours" integer,
    "url" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "id" "uuid" NOT NULL
);


ALTER TABLE "public"."courses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."credit_operation_costs" (
    "id" bigint NOT NULL,
    "operation_key" "text" NOT NULL,
    "credit_cost" integer NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."credit_operation_costs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."credit_operation_costs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."credit_operation_costs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."credit_operation_costs_id_seq" OWNED BY "public"."credit_operation_costs"."id";



CREATE TABLE IF NOT EXISTS "public"."daily_career_insights" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text" NOT NULL,
    "insight_type" "text",
    "title" "text",
    "description" "text",
    "source_engine" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb",
    "priority" integer DEFAULT 3,
    "is_read" boolean DEFAULT false,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone
);


ALTER TABLE "public"."daily_career_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_metric_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "date" "text" NOT NULL,
    "total_requests" integer DEFAULT 0 NOT NULL,
    "total_tokens" bigint DEFAULT 0 NOT NULL,
    "total_cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "total_revenue_usd" numeric(12,4) DEFAULT 0 NOT NULL,
    "free_tier_cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "paid_tier_cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "paid_user_count" integer DEFAULT 0 NOT NULL,
    "feature_counts" "jsonb" DEFAULT '{}'::"jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."daily_metric_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edu_academic_records" (
    "id" bigint NOT NULL,
    "student_id" "text" NOT NULL,
    "subject" "text",
    "class_level" "text",
    "marks" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."edu_academic_records" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_academic_records" OWNER TO "postgres";


COMMENT ON TABLE "public"."edu_academic_records" IS 'Per-subject academic marks for education intelligence students. Managed atomically via replace_student_academic_records() RPC — never mutate directly from application code.';



COMMENT ON COLUMN "public"."edu_academic_records"."student_id" IS 'Firebase UID — TEXT, matches edu_students.id and student_career_profiles.id.';



COMMENT ON COLUMN "public"."edu_academic_records"."class_level" IS 'One of: class_8, class_9, class_10, class_11, class_12 (see CLASS_LEVELS enum in student.model.js).';



CREATE SEQUENCE IF NOT EXISTS "public"."edu_academic_records_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."edu_academic_records_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."edu_academic_records_id_seq" OWNED BY "public"."edu_academic_records"."id";



CREATE TABLE IF NOT EXISTS "public"."edu_career_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "user_message" "text",
    "ai_response" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."edu_career_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edu_career_predictions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid",
    "career_name" "text",
    "success_probability" integer,
    "created_at" timestamp with time zone,
    "predictions" "jsonb"
);


ALTER TABLE "public"."edu_career_predictions" OWNER TO "postgres";


COMMENT ON TABLE "public"."edu_career_predictions" IS 'Normalised row-per-career predictions with denormalised predictions JSONB column for service reads. Managed by fn_sync_career_predictions(UUID). This block is a no-op in production where the table already exists.';



COMMENT ON COLUMN "public"."edu_career_predictions"."predictions" IS 'Aggregated array of { career_name, success_probability } objects consumed by loadStudentProfile() via select(''predictions'').maybeSingle(). Kept in sync with normalised rows by application layer on write.';



CREATE TABLE IF NOT EXISTS "public"."edu_career_simulations" (
    "id" bigint NOT NULL,
    "student_id" "text" NOT NULL,
    "career_name" "text" NOT NULL,
    "probability" numeric,
    "entry_salary" numeric,
    "salary_3_year" numeric,
    "salary_5_year" numeric,
    "salary_10_year" numeric,
    "annual_growth_rate" numeric,
    "demand_level" "text",
    "roi_level" "text",
    "best_education_path" "text",
    "milestones" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_career_simulations" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."edu_career_simulations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."edu_career_simulations_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."edu_career_simulations_id_seq" OWNED BY "public"."edu_career_simulations"."id";



CREATE TABLE IF NOT EXISTS "public"."edu_cognitive_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "test_type" "text",
    "assessment_version" "text",
    "result_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_cognitive_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."edu_cognitive_results" IS 'Cognitive assessment results per student. Flexible JSONB payload allows evolving schemas without migrations.';



COMMENT ON COLUMN "public"."edu_cognitive_results"."test_type" IS 'Assessment category e.g. logical_reasoning, verbal, numerical.';



COMMENT ON COLUMN "public"."edu_cognitive_results"."assessment_version" IS 'Version tag for the instrument — enables longitudinal comparisons.';



COMMENT ON COLUMN "public"."edu_cognitive_results"."result_payload" IS 'Full JSONB assessment output consumed by loadStudentProfile() via select(''*'').';



CREATE TABLE IF NOT EXISTS "public"."edu_education_roi" (
    "id" bigint NOT NULL,
    "student_id" "text" NOT NULL,
    "education_path" "text" NOT NULL,
    "duration_years" numeric,
    "estimated_cost" numeric,
    "expected_salary" numeric,
    "roi_score" numeric,
    "roi_level" "text",
    "matched_careers" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_education_roi" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."edu_education_roi_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."edu_education_roi_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."edu_education_roi_id_seq" OWNED BY "public"."edu_education_roi"."id";



CREATE TABLE IF NOT EXISTS "public"."edu_extracurricular" (
    "id" bigint NOT NULL,
    "student_id" "text" NOT NULL,
    "activity_name" "text",
    "activity_level" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_extracurricular" OWNER TO "postgres";


COMMENT ON TABLE "public"."edu_extracurricular" IS 'Extracurricular activities for education intelligence students. Managed atomically via replace_student_activities() RPC — never mutate directly from application code.';



COMMENT ON COLUMN "public"."edu_extracurricular"."activity_level" IS 'One of: beginner, intermediate, advanced, national, international (see ACTIVITY_LEVELS enum in student.model.js).';



CREATE SEQUENCE IF NOT EXISTS "public"."edu_extracurricular_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."edu_extracurricular_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."edu_extracurricular_id_seq" OWNED BY "public"."edu_extracurricular"."id";



CREATE TABLE IF NOT EXISTS "public"."edu_skill_recommendations" (
    "student_id" "uuid" NOT NULL,
    "top_career" "text",
    "recommended_stream" "text",
    "skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "roadmap" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "engine_version" "text" DEFAULT '2.0.0'::"text" NOT NULL,
    "calculated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_skill_recommendations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edu_stream_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "recommended_stream" "text",
    "scores" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_stream_scores" OWNER TO "postgres";


COMMENT ON TABLE "public"."edu_stream_scores" IS 'One row per student — latest recommended stream and full score breakdown.';



COMMENT ON COLUMN "public"."edu_stream_scores"."recommended_stream" IS 'Plain text stream name matched against program.streams in scoreStreamAlignment().';



COMMENT ON COLUMN "public"."edu_stream_scores"."scores" IS 'Full JSONB scoring payload — e.g. per-stream percentiles.';



CREATE TABLE IF NOT EXISTS "public"."edu_student_skills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "skill_name" "text" NOT NULL,
    "proficiency_level" "public"."proficiency_level" DEFAULT 'beginner'::"public"."proficiency_level" NOT NULL,
    "impact_score" numeric,
    "career_relevance" numeric,
    "demand_score" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_student_skills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edu_students" (
    "id" "uuid" NOT NULL,
    "name" "text",
    "education_level" "text",
    "skills" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edu_students" OWNER TO "postgres";


COMMENT ON TABLE "public"."edu_students" IS 'Core student profile. id = auth.users(id) for direct RLS alignment.';



COMMENT ON COLUMN "public"."edu_students"."education_level" IS 'e.g. secondary, undergraduate, postgraduate.';



COMMENT ON COLUMN "public"."edu_students"."skills" IS 'Flat text array. Matched via scoreSkillMatch() with lowercase normalisation.';



CREATE TABLE IF NOT EXISTS "public"."emp_employer_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employer_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."emp_employer_users" OWNER TO "postgres";


COMMENT ON TABLE "public"."emp_employer_users" IS 'Membership table linking Firebase users to employer accounts. role values: employer_admin, employer_hr (see EMPLOYER_ROLES in employer.model.js).';



COMMENT ON COLUMN "public"."emp_employer_users"."user_id" IS 'Firebase UID — TEXT, matches the auth identity used across the platform.';



CREATE TABLE IF NOT EXISTS "public"."emp_employers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_name" "text" NOT NULL,
    "industry" "text",
    "website" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."emp_employers" OWNER TO "postgres";


COMMENT ON TABLE "public"."emp_employers" IS 'Employer company records for the employer integration module. One row per company. Managed via employer.repository.js.';



COMMENT ON COLUMN "public"."emp_employers"."created_by" IS 'Firebase UID of the user who created this employer record.';



CREATE TABLE IF NOT EXISTS "public"."emp_job_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employer_id" "uuid" NOT NULL,
    "role_name" "text" NOT NULL,
    "required_skills" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "salary_range" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "streams" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "experience_years" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."emp_job_roles" OWNER TO "postgres";


COMMENT ON TABLE "public"."emp_job_roles" IS 'Job roles posted by employers. Managed via employer.repository.js. salary_range: {min, max, currency}. experience_years: {min, max}.';



COMMENT ON COLUMN "public"."emp_job_roles"."required_skills" IS 'PostgreSQL TEXT[] — Supabase JS client sends/receives as a JS string array. Filtered for falsy values by buildJobRoleRow().';



COMMENT ON COLUMN "public"."emp_job_roles"."salary_range" IS 'JSONB shape: {"min": 0, "max": 0, "currency": "USD"} — matches buildJobRoleRow() in employer.model.js.';



COMMENT ON COLUMN "public"."emp_job_roles"."streams" IS 'Education stream filters e.g. ["engineering", "commerce"]. TEXT[] — filtered for falsy values by buildJobRoleRow().';



COMMENT ON COLUMN "public"."emp_job_roles"."experience_years" IS 'JSONB shape: {"min": 0, "max": 5} — matches buildJobRoleRow() in employer.model.js.';



CREATE TABLE IF NOT EXISTS "public"."emp_talent_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employer_id" "uuid" NOT NULL,
    "job_role_id" "uuid",
    "student_id" "text" NOT NULL,
    "signal_type" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."emp_talent_signals" OWNER TO "postgres";


COMMENT ON TABLE "public"."emp_talent_signals" IS 'Employer interest signals against student profiles. signal_type examples: shortlisted, viewed, contacted. metadata holds any additional signal-specific payload.';



CREATE TABLE IF NOT EXISTS "public"."external_salary_apis" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "name" "text",
    "base_url" "text",
    "api_key" "text",
    "enabled" boolean DEFAULT false NOT NULL,
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "last_sync" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text"
);


ALTER TABLE "public"."external_salary_apis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gcid_aggregated_cache" (
    "metric_name" "text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ttl_seconds" integer DEFAULT 3600 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."gcid_aggregated_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gcid_analytics_snapshots" (
    "id" bigint NOT NULL,
    "metric_name" "text" NOT NULL,
    "metric_value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "region" "text" DEFAULT 'india'::"text" NOT NULL,
    "snapshot_date" "date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."gcid_analytics_snapshots" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."gcid_analytics_snapshots_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."gcid_analytics_snapshots_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."gcid_analytics_snapshots_id_seq" OWNED BY "public"."gcid_analytics_snapshots"."id";



CREATE TABLE IF NOT EXISTS "public"."generated_cvs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "model_version" "text",
    "generation_hash" "text",
    "cv_content" "jsonb" NOT NULL,
    "input_profile" "jsonb",
    "cache_hit" boolean DEFAULT false,
    "cost_usd" numeric(12,6),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."generated_cvs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_skills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "skill_id" "text" NOT NULL,
    "importance_weight" numeric DEFAULT 1.0,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "skill_type" "text" DEFAULT 'required'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_skills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_transitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_role_id" "text" NOT NULL,
    "to_role_id" "text" NOT NULL,
    "probability" numeric,
    "years_required" numeric,
    "transition_type" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_transitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "role_id" "text" DEFAULT "gen_random_uuid"() NOT NULL,
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role_name" "text",
    "role_family" "text",
    "seniority_level" "text",
    "description" "text",
    "normalized_name" "text" NOT NULL,
    "track" "text",
    "alternative_titles" "text"[] DEFAULT '{}'::"text"[],
    "created_by" "text",
    "updated_by" "text",
    "agency" "text" DEFAULT ''::"text",
    "search_vector" "tsvector",
    "embedding_updated_at" timestamp with time zone,
    "embedding" "public"."vector"(768),
    "composite_key" "text" GENERATED ALWAYS AS ((("lower"(TRIM(BOTH FROM "role_name")) || '::'::"text") || COALESCE("role_family", ''::"text"))) STORED,
    "id" "text",
    "title" "text",
    "level" "text",
    "job_family_id" "text",
    "skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);

ALTER TABLE ONLY "public"."roles" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skill_relationships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "skill_id" "text" NOT NULL,
    "related_skill_id" "text" NOT NULL,
    "relationship_type" "text" DEFAULT 'complementary'::"text" NOT NULL,
    "strength_score" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."skill_relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skills" (
    "old_id" "text" NOT NULL,
    "name" "text",
    "metadata" "jsonb",
    "aliases" "jsonb",
    "data" "jsonb",
    "created_at" timestamp without time zone,
    "skill_name" "text",
    "skill_category" "text",
    "difficulty_level" numeric,
    "demand_score" numeric,
    "skill_id" "text",
    "category" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "soft_deleted" boolean DEFAULT false,
    "id" "uuid" NOT NULL,
    "normalized_name" "text" NOT NULL
);


ALTER TABLE "public"."skills" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."graph_metrics" AS
 SELECT ( SELECT "count"(*) AS "count"
           FROM "public"."roles") AS "total_roles",
    ( SELECT "count"(*) AS "count"
           FROM "public"."skills") AS "total_skills",
    ( SELECT "count"(*) AS "count"
           FROM "public"."role_transitions") AS "total_role_transitions",
    ( SELECT "count"(*) AS "count"
           FROM "public"."skill_relationships") AS "total_skill_relationships",
    ( SELECT "count"(*) AS "count"
           FROM "public"."role_skills") AS "total_role_skills";


ALTER VIEW "public"."graph_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."health_check" (
    "id" integer NOT NULL
);


ALTER TABLE "public"."health_check" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."idempotency_keys" (
    "id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "operation" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "result" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."idempotency_keys" OWNER TO "postgres";


COMMENT ON TABLE "public"."idempotency_keys" IS 'Deduplication cache for AI and write operations. TTL = 24 h (enforced in application layer and pg_cron job).';



COMMENT ON COLUMN "public"."idempotency_keys"."id" IS 'Composite key: userId:operation:idempotencyKey';



COMMENT ON COLUMN "public"."idempotency_keys"."user_id" IS 'Owner — used for RLS and per-user expiry queries';



COMMENT ON COLUMN "public"."idempotency_keys"."operation" IS 'Logical operation name e.g. careerReport, resumeScore';



COMMENT ON COLUMN "public"."idempotency_keys"."idempotency_key" IS 'Caller-supplied dedup token (UUID or hash)';



COMMENT ON COLUMN "public"."idempotency_keys"."result" IS 'Cached service return value. NULL until first successful write.';



COMMENT ON COLUMN "public"."idempotency_keys"."created_at" IS 'Insert time. App deletes rows older than 24 h on read; see IDEMPOTENCY_TTL_MS.';



CREATE TABLE IF NOT EXISTS "public"."import_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "row_results" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dataset_name" "text",
    "admin_user_id" "text",
    "rows_processed" integer,
    "rows_imported" integer,
    "rows_skipped" integer,
    "rows_failed" integer,
    "duplicate_errors" integer,
    "fk_errors" integer,
    "import_mode" "text",
    "duration_ms" integer
);


ALTER TABLE "public"."import_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."jd_analysis_logs" (
    "id" bigint NOT NULL,
    "match_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "skills_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."jd_analysis_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."jd_analysis_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."jd_analysis_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."jd_analysis_logs_id_seq" OWNED BY "public"."jd_analysis_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."job_analyses" (
    "id" "text" NOT NULL,
    "user_id" "text",
    "job_title" "text",
    "job_url" "text",
    "job_description" "text",
    "job_skills" "jsonb",
    "matched_skills" "jsonb",
    "missing_skills" "jsonb",
    "job_fit_score" integer,
    "fit_summary" "text",
    "top_recommendations" "jsonb",
    "user_skills_snapshot" "jsonb",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."job_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_name" "text",
    "job_title" "text",
    "email_sent_to" "text",
    "applied_date" timestamp without time zone,
    "follow_up_date" timestamp without time zone,
    "status" "text" DEFAULT 'applied'::"text",
    "notes" "text",
    "source" "text",
    "deleted" boolean DEFAULT false,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."job_applications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "embedding_vector" "public"."vector"(1536) NOT NULL,
    "job_title" "text" NOT NULL,
    "company" "text" NOT NULL,
    "location" "text",
    "skills_snapshot" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_families" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "track_count" integer DEFAULT 0 NOT NULL,
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_families" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_listings_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "cache_key" "text" NOT NULL,
    "jobs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_count" integer DEFAULT 0,
    "query" "text",
    "country" "text",
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."job_listings_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_match_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "job_id" "uuid",
    "recommended_jobs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_evaluated" integer DEFAULT 0 NOT NULL,
    "user_skills_count" integer DEFAULT 0 NOT NULL,
    "scoring_mode" "text" DEFAULT 'keyword'::"text" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_match_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_match_results" IS 'Stored job matching output written by JobMatchingWorker. Dashboard reads from here.';



CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "external_id" "text",
    "title" "text" NOT NULL,
    "company" "text",
    "location" "text",
    "description" "text",
    "skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "experience_level" "text",
    "salary_min" numeric,
    "salary_max" numeric,
    "salary_currency" "text" DEFAULT 'INR'::"text",
    "contract_type" "text",
    "redirect_url" "text",
    "source" "text" DEFAULT 'adzuna'::"text" NOT NULL,
    "country" "text" DEFAULT 'IN'::"text",
    "posted_at" timestamp with time zone,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."learning_paths_cache" (
    "skill" "text" NOT NULL,
    "path" "jsonb",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."learning_paths_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."learning_resources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "skill" "text" NOT NULL,
    "course_name" "text" NOT NULL,
    "provider" "text",
    "level" "text",
    "duration_hours" integer,
    "url" "text",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."learning_resources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lmi_career_market_scores" (
    "id" bigint NOT NULL,
    "career_name" "text" NOT NULL,
    "demand_score" numeric,
    "trend_score" numeric,
    "automation_risk" numeric,
    "salary_growth" numeric,
    "top_skills" "text"[],
    "avg_entry_salary" numeric,
    "avg_5yr_salary" numeric,
    "avg_10yr_salary" numeric,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lmi_career_market_scores" OWNER TO "postgres";


ALTER TABLE "public"."lmi_career_market_scores" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lmi_career_market_scores_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lmi_career_predictions" (
    "id" bigint NOT NULL,
    "student_id" "text" NOT NULL,
    "career_name" "text" NOT NULL,
    "success_probability" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lmi_career_predictions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lmi_career_predictions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lmi_career_predictions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lmi_career_predictions_id_seq" OWNED BY "public"."lmi_career_predictions"."id";



CREATE TABLE IF NOT EXISTS "public"."lmi_ingestion_runs" (
    "id" "text" NOT NULL,
    "run_id" "text" NOT NULL,
    "source" "text" NOT NULL,
    "jobs_written" integer,
    "duration_ms" integer,
    "status" "text" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lmi_ingestion_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lmi_job_market_data" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_title" "text" NOT NULL,
    "company" "text",
    "location" "text",
    "salary_min" integer,
    "salary_max" integer,
    "skills" "text"[],
    "industry" "text",
    "source" "text",
    "posting_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lmi_job_market_data" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_intelligence_cache" (
    "id" "text" NOT NULL,
    "role" "text",
    "country" "text",
    "job_postings" integer,
    "salary_median" numeric,
    "growth_rate" numeric,
    "remote_ratio" numeric DEFAULT 0,
    "provider" "text",
    "fetched_at" timestamp with time zone,
    "cached_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."market_intelligence_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_intelligence_sync" (
    "id" bigint NOT NULL,
    "role" "text",
    "country" "text",
    "provider" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."market_intelligence_sync" OWNER TO "postgres";


ALTER TABLE "public"."market_intelligence_sync" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."market_intelligence_sync_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."metrics_daily_snapshots" (
    "date" "date" NOT NULL,
    "total_users" integer,
    "active_users" integer,
    "total_requests" integer,
    "total_tokens" bigint,
    "total_cost_usd" numeric,
    "total_revenue_usd" numeric,
    "gross_margin_usd" numeric,
    "gross_margin_percent" numeric,
    "free_tier_cost_usd" numeric,
    "paid_tier_cost_usd" numeric,
    "paid_user_count" integer,
    "feature_counts" "jsonb",
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."metrics_daily_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."search_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "query" "text" NOT NULL,
    "normalized_query" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "role_id" "text",
    "role_name" "text",
    "position" integer,
    "match_type" "text",
    "agency" "text" NOT NULL,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_click_requires_role" CHECK ((("event_type" <> 'click'::"text") OR (("role_id" IS NOT NULL) AND ("position" IS NOT NULL)))),
    CONSTRAINT "search_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['search'::"text", 'click'::"text"]))),
    CONSTRAINT "search_events_match_type_check" CHECK (("match_type" = ANY (ARRAY['prefix'::"text", 'fts'::"text", 'fuzzy_name'::"text", 'fuzzy_composite'::"text"])))
);


ALTER TABLE "public"."search_events" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."most_clicked_roles" AS
 SELECT "role_id",
    "agency",
    "count"(*) AS "click_count",
    ("avg"("position"))::double precision AS "avg_position",
    "max"("created_at") AS "last_clicked_at",
    "log"((("count"(*) + 1))::double precision) AS "popularity_score"
   FROM "public"."search_events"
  WHERE (("event_type" = 'click'::"text") AND ("role_id" IS NOT NULL))
  GROUP BY "role_id", "agency"
  ORDER BY ("count"(*)) DESC
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."most_clicked_roles" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."most_clicked_roles_recent" AS
 SELECT "role_id",
    "agency",
    "count"(*) AS "click_count",
    ("avg"("position"))::double precision AS "avg_position",
    "max"("created_at") AS "last_clicked_at",
    "log"((("count"(*) + 1))::double precision) AS "popularity_score"
   FROM "public"."search_events"
  WHERE (("event_type" = 'click'::"text") AND ("role_id" IS NOT NULL) AND ("created_at" >= ("now"() - '7 days'::interval)))
  GROUP BY "role_id", "agency"
  ORDER BY ("count"(*)) DESC
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."most_clicked_roles_recent" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_delivery" (
    "id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "attempted_at" timestamp with time zone,
    "sent_at" timestamp with time zone
);


ALTER TABLE "public"."notification_delivery" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_jobs" (
    "id" "text" NOT NULL,
    "job_id" "text",
    "user_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "soft_deleted" boolean DEFAULT false,
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1
);


ALTER TABLE "public"."notification_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "notification_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "action_url" "text",
    "data" "jsonb",
    "read" boolean DEFAULT false NOT NULL,
    "channels" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "delivery_status" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "push_delivered_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_progress" (
    "id" "text" NOT NULL,
    "user_id" "text",
    "step" "text",
    "completed_steps" "jsonb" DEFAULT '[]'::"jsonb",
    "data" "jsonb" DEFAULT '{}'::"jsonb",
    "completed" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "uid" "text",
    "skills" "jsonb" DEFAULT '[]'::"jsonb",
    "industry" "text",
    "industry_id" "text",
    "industry_text" "text",
    "experience_years" integer,
    "experience" "jsonb",
    "target_role" "text",
    "target_role_free_text" "text",
    "job_title" "text",
    "job_function" "text",
    "resume_id" "text",
    "latest_resume_id" "text",
    "resume_uploaded" boolean DEFAULT false,
    "current_salary_lpa" numeric,
    "expected_salary_lpa" numeric,
    "expected_role_ids" "jsonb" DEFAULT '[]'::"jsonb",
    "work_mode" "text",
    "preferred_work_location" "text",
    "professional_summary" "text",
    "onboarding_completed" boolean DEFAULT false,
    "onboarding_completed_at" timestamp with time zone,
    "onboarding_started_at" timestamp with time zone,
    "quick_start_completed" boolean DEFAULT false,
    "last_active_at" timestamp with time zone,
    "last_active_step" "text",
    "chi_status" "text",
    "consent_granted_at" timestamp with time zone,
    "consent_version" "text",
    "referral_source" "text",
    "import_source" "text",
    "role_count" integer,
    "skill_count" integer,
    "email_mismatch_detected_at" timestamp with time zone,
    "email_mismatch_note" "text",
    "draft" "jsonb",
    "draft_saved_at" timestamp with time zone,
    "draft_version" integer,
    "extracted_details" "jsonb",
    "soft_deleted" boolean DEFAULT false,
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1,
    "cv_resume_id" "text",
    "wants_cv" boolean DEFAULT false,
    "personal_details" "jsonb",
    "step_history" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "current_job_title" "text",
    "current_company" "text",
    "years_of_experience" integer,
    "years_experience" integer,
    "linked_in_url" "text",
    "portfolio_url" "text",
    "languages" "jsonb" DEFAULT '[]'::"jsonb",
    "work_authorisation" "text",
    "full_name" "text",
    "email" "text",
    "phone" "text",
    "city" "text",
    "country" "text",
    "career_report" "jsonb",
    "ai_failures" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "imported_profile" "jsonb",
    "import_confirmed_at" timestamp with time zone
);


ALTER TABLE "public"."onboarding_progress" OWNER TO "postgres";


COMMENT ON COLUMN "public"."onboarding_progress"."imported_profile" IS 'Staging area for LinkedIn-imported education/experience/skills pending user confirmation. Populated by importLinkedIn(), promoted and nulled by confirmLinkedInImport().';



COMMENT ON COLUMN "public"."onboarding_progress"."import_confirmed_at" IS 'Timestamp when user explicitly confirmed their LinkedIn import. NULL = import pending or not started.';



CREATE TABLE IF NOT EXISTS "public"."opportunity_radar_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "job_id" "uuid",
    "emerging_opportunities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_signals_evaluated" integer DEFAULT 0 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."opportunity_radar_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."opportunity_radar_results" IS 'Stored personalised opportunity radar output written by OpportunityRadarWorker.';



CREATE TABLE IF NOT EXISTS "public"."payment_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "subscription_id" "text",
    "provider" "text",
    "amount" numeric,
    "credits_granted" integer,
    "status" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payment_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pending_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "submitted_by" "text" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "text",
    "reviewed_at" timestamp with time zone,
    "review_notes" "text",
    "live_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pending_entries_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['skill'::"text", 'role'::"text", 'jobFamily'::"text", 'educationLevel'::"text", 'salaryBenchmark'::"text"]))),
    CONSTRAINT "pending_entries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."pending_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personalized_recommendations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "personalized_roles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "personalized_skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "personalized_paths" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "personalization_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "signal_strength" "text" DEFAULT 'low'::"text" NOT NULL,
    "score_breakdown" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval) NOT NULL,
    CONSTRAINT "personalized_recommendations_signal_strength_check" CHECK (("signal_strength" = ANY (ARRAY['none'::"text", 'low'::"text", 'medium'::"text", 'high'::"text", 'very_high'::"text"])))
);


ALTER TABLE "public"."personalized_recommendations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pi_ai_model_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "primary_model" "text" DEFAULT 'claude-sonnet-4-5'::"text" NOT NULL,
    "fallback_model" "text" DEFAULT 'gpt-4o-mini'::"text" NOT NULL,
    "temperature" numeric(4,2) DEFAULT 0.3 NOT NULL,
    "max_tokens" integer DEFAULT 1200 NOT NULL,
    "analysis_mode" "text" DEFAULT 'balanced'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_ai_model_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_ai_model_settings" IS 'AI model configuration. Singleton row managed by platform admins.';



COMMENT ON COLUMN "public"."pi_ai_model_settings"."temperature" IS 'LLM sampling temperature. Range 0.0–1.0.';



COMMENT ON COLUMN "public"."pi_ai_model_settings"."analysis_mode" IS 'e.g. balanced, precise, creative.';



CREATE TABLE IF NOT EXISTS "public"."pi_ai_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prompt_name" "text",
    "prompt_text" "text",
    "engine" "text",
    "version" "text" DEFAULT '1.0.0'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_ai_prompts" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_ai_prompts" IS 'Versioned prompt template registry. Multiple versions per prompt_name are allowed.';



COMMENT ON COLUMN "public"."pi_ai_prompts"."engine" IS 'Target engine e.g. claude, openai, gemini.';



COMMENT ON COLUMN "public"."pi_ai_prompts"."version" IS 'Semantic version string — enables prompt A/B testing and rollback.';



CREATE TABLE IF NOT EXISTS "public"."pi_ai_usage_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text",
    "action" "text",
    "tokens_used" integer DEFAULT 0 NOT NULL,
    "model_used" "text",
    "cost" numeric(10,6) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_ai_usage_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_ai_usage_logs" IS 'Append-only AI usage audit log. Rows are never updated — no updated_at.';



COMMENT ON COLUMN "public"."pi_ai_usage_logs"."user_id" IS 'TEXT not UUID FK — supports anonymous and service-role calls.';



COMMENT ON COLUMN "public"."pi_ai_usage_logs"."tokens_used" IS 'Total tokens (prompt + completion).';



COMMENT ON COLUMN "public"."pi_ai_usage_logs"."cost" IS 'Estimated USD cost to 6 decimal places for micro-cost accuracy.';



CREATE TABLE IF NOT EXISTS "public"."pi_career_datasets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dataset_name" "text",
    "dataset_type" "text",
    "file_url" "text",
    "version" "text" DEFAULT '1.0.0'::"text" NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_career_datasets" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_career_datasets" IS 'Career dataset file registry. file_url points to Supabase Storage object.';



COMMENT ON COLUMN "public"."pi_career_datasets"."version" IS 'Semantic version string e.g. 1.0.0, 2.1.3.';



COMMENT ON COLUMN "public"."pi_career_datasets"."uploaded_at" IS 'DB-managed upload timestamp — replaces Firestore serverTimestamp().';



CREATE TABLE IF NOT EXISTS "public"."pi_career_paths" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_role" "text",
    "to_role" "text",
    "required_skills" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "min_experience" numeric(4,1) DEFAULT 0 NOT NULL,
    "salary_range" "jsonb",
    "probability_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_career_paths" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_career_paths" IS 'Directed career transition graph. Each row = one from_role → to_role edge.';



COMMENT ON COLUMN "public"."pi_career_paths"."required_skills" IS 'Text array of skills required to traverse this path edge.';



COMMENT ON COLUMN "public"."pi_career_paths"."salary_range" IS 'JSONB e.g. { "min": 60000, "max": 90000, "currency": "INR" }.';



COMMENT ON COLUMN "public"."pi_career_paths"."probability_score" IS 'Model-estimated transition probability 0–100.';



CREATE TABLE IF NOT EXISTS "public"."pi_chi_weights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "skill_weight" numeric(5,2) DEFAULT 25 NOT NULL,
    "experience_weight" numeric(5,2) DEFAULT 20 NOT NULL,
    "market_weight" numeric(5,2) DEFAULT 20 NOT NULL,
    "salary_weight" numeric(5,2) DEFAULT 20 NOT NULL,
    "education_weight" numeric(5,2) DEFAULT 15 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pi_chi_weights_sum_check" CHECK (("round"((((("skill_weight" + "experience_weight") + "market_weight") + "salary_weight") + "education_weight"), 2) = 100.00))
);


ALTER TABLE "public"."pi_chi_weights" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_chi_weights" IS 'Career Health Index scoring weights. Active row weights must sum to 100.';



COMMENT ON COLUMN "public"."pi_chi_weights"."skill_weight" IS 'Default 25 — percentage weight for skill dimension in CHI score.';



CREATE TABLE IF NOT EXISTS "public"."pi_feature_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "feature_name" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_feature_flags" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_feature_flags" IS 'Boolean feature toggle registry. feature_name is globally unique.';



COMMENT ON COLUMN "public"."pi_feature_flags"."feature_name" IS 'Unique snake_case flag identifier e.g. enable_chi_v2, market_reports_beta.';



COMMENT ON COLUMN "public"."pi_feature_flags"."enabled" IS 'FALSE = flag off. Toggle via admin upsert.';



CREATE TABLE IF NOT EXISTS "public"."pi_market_data_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "api_key" "text",
    "endpoint" "text",
    "region" "text" DEFAULT 'global'::"text" NOT NULL,
    "update_frequency" "text" DEFAULT 'daily'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_market_data_sources" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_market_data_sources" IS 'External market data feed registry.';



COMMENT ON COLUMN "public"."pi_market_data_sources"."api_key" IS 'Encrypted at rest via Supabase Vault in production.';



COMMENT ON COLUMN "public"."pi_market_data_sources"."status" IS 'active | paused | deprecated.';



CREATE TABLE IF NOT EXISTS "public"."pi_skill_taxonomy" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "skill_name" "text",
    "parent_skill_id" "uuid",
    "category" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_skill_taxonomy" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_skill_taxonomy" IS 'Hierarchical skill ontology. Self-referencing tree via parent_skill_id.';



COMMENT ON COLUMN "public"."pi_skill_taxonomy"."parent_skill_id" IS 'NULL = root skill node. ON DELETE SET NULL preserves child skills if parent removed.';



CREATE TABLE IF NOT EXISTS "public"."pi_subscription_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_name" "text",
    "monthly_price" numeric(10,2) DEFAULT 0 NOT NULL,
    "career_analyses_limit" integer DEFAULT 0 NOT NULL,
    "resume_scans_limit" integer DEFAULT 0 NOT NULL,
    "market_reports_limit" integer DEFAULT 0 NOT NULL,
    "api_calls_limit" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_subscription_plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_subscription_plans" IS 'Subscription tier definitions. 0 on any limit column = unlimited by convention.';



COMMENT ON COLUMN "public"."pi_subscription_plans"."monthly_price" IS 'Recurring monthly price in platform default currency.';



COMMENT ON COLUMN "public"."pi_subscription_plans"."career_analyses_limit" IS '0 = unlimited.';



CREATE TABLE IF NOT EXISTS "public"."pi_training_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_name" "text",
    "course_name" "text",
    "mapped_skill" "text",
    "difficulty" "text" DEFAULT 'beginner'::"text" NOT NULL,
    "duration" "text",
    "cost" numeric(10,2) DEFAULT 0 NOT NULL,
    "link" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pi_training_sources" OWNER TO "postgres";


COMMENT ON TABLE "public"."pi_training_sources" IS 'Training resource catalogue. mapped_skill links to pi_skill_taxonomy.skill_name.';



COMMENT ON COLUMN "public"."pi_training_sources"."difficulty" IS 'beginner | intermediate | advanced.';



COMMENT ON COLUMN "public"."pi_training_sources"."cost" IS 'Course cost in platform default currency. 0 = free.';



CREATE TABLE IF NOT EXISTS "public"."professional_career_profiles" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text" NOT NULL,
    "job_title" "text",
    "years_experience" numeric,
    "industry" "text",
    "education_level" "text",
    "country" "text",
    "city" "text",
    "salary_range" "text",
    "career_goals" "jsonb" DEFAULT '[]'::"jsonb",
    "skills" "jsonb" DEFAULT '[]'::"jsonb",
    "cv_uploaded" boolean DEFAULT false,
    "profile_version" integer DEFAULT 1,
    "soft_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1
);


ALTER TABLE "public"."professional_career_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "role" "text" DEFAULT 'user'::"text",
    "avatar_url" "text",
    "onboarding_complete" boolean DEFAULT false,
    "promoted_at" timestamp with time zone,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'contributor'::"text", 'admin'::"text", 'super_admin'::"text", 'master_admin'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qualifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "short_name" "text",
    "level" "text" NOT NULL,
    "domain" "text" DEFAULT 'general'::"text" NOT NULL,
    "category" "text",
    "country" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "qualifications_level_check" CHECK (("level" = ANY (ARRAY['certificate'::"text", 'diploma'::"text", 'undergraduate'::"text", 'postgraduate'::"text", 'doctorate'::"text"])))
);


ALTER TABLE "public"."qualifications" OWNER TO "postgres";


COMMENT ON TABLE "public"."qualifications" IS 'Qualification reference data. Drives onboarding dropdowns and profile validation.';



COMMENT ON COLUMN "public"."qualifications"."short_name" IS 'Optional abbreviation e.g. B.Tech, MBA.';



COMMENT ON COLUMN "public"."qualifications"."level" IS 'certificate | diploma | undergraduate | postgraduate | doctorate. Ordered by LEVEL_ORDER in qualification.service.js.';



COMMENT ON COLUMN "public"."qualifications"."domain" IS 'Subject domain. Defaults to ''general'' when blank — mirrors service mapQualificationRow() fallback.';



COMMENT ON COLUMN "public"."qualifications"."is_active" IS 'FALSE = hidden from dropdowns and rejected by getQualificationById().';



CREATE TABLE IF NOT EXISTS "public"."rate_limits" (
    "key" "text" NOT NULL,
    "count" integer DEFAULT 1 NOT NULL,
    "window_start" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."resume_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resume_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "engine" "text" NOT NULL,
    "analysis_hash" "text" NOT NULL,
    "score" integer,
    "tier" "text",
    "summary" "text",
    "breakdown" "jsonb",
    "strengths" "jsonb",
    "improvements" "jsonb",
    "top_skills" "text"[],
    "estimated_experience_years" integer,
    "chi_score" integer,
    "dimensions" "jsonb",
    "market_position" "jsonb",
    "peer_comparison" "jsonb",
    "growth_insights" "jsonb",
    "salary_estimate" "jsonb",
    "roadmap" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ai_model_version" "text",
    "projected_level_up_months" integer,
    "current_estimated_salary_lpa" numeric(10,2),
    "next_level_estimated_salary_lpa" numeric(10,2),
    "career_roadmap" "jsonb",
    "weighted_career_context" "jsonb",
    "token_input_count" integer,
    "token_output_count" integer,
    "ai_cost_usd" numeric(12,6),
    "cache_hit" boolean DEFAULT false,
    "cache_source" "text",
    "latency_ms" integer,
    "operation_type" "text",
    CONSTRAINT "resume_analyses_engine_check" CHECK (("engine" = ANY (ARRAY['free'::"text", 'premium'::"text"])))
);


ALTER TABLE "public"."resume_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."resume_exports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resume_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "version_id" "uuid",
    "format" "text" NOT NULL,
    "storage_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "resume_exports_format_check" CHECK (("format" = ANY (ARRAY['pdf'::"text", 'docx'::"text"])))
);


ALTER TABLE "public"."resume_exports" OWNER TO "postgres";


COMMENT ON TABLE "public"."resume_exports" IS 'Export audit log. storage_path is the Supabase Storage object key.';



CREATE TABLE IF NOT EXISTS "public"."resume_growth_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "role_id" "text" NOT NULL,
    "signal" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."resume_growth_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."resume_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "resume_id" "uuid",
    "score" numeric(5,2) NOT NULL,
    "breakdown" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "role_fit" "text",
    "is_mock_data" boolean DEFAULT false NOT NULL,
    "scored_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "resume_scores_score_check" CHECK ((("score" >= (0)::numeric) AND ("score" <= (100)::numeric)))
);


ALTER TABLE "public"."resume_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."resume_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resume_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "version_number" smallint DEFAULT 1 NOT NULL,
    "content_json" "jsonb" NOT NULL,
    "template_id" "text" DEFAULT 'modern'::"text" NOT NULL,
    "ats_score" smallint,
    "change_summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "resume_versions_ats_score_check" CHECK ((("ats_score" >= 0) AND ("ats_score" <= 100)))
);


ALTER TABLE "public"."resume_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."resume_versions" IS 'Immutable snapshots per save or AI-improve. Supports full rollback.';



CREATE TABLE IF NOT EXISTS "public"."resumes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "content" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_text" "text",
    "parsed_data" "jsonb",
    "ats_score" integer DEFAULT 0,
    "ats_breakdown" "jsonb",
    "template_id" "text" DEFAULT 'modern'::"text" NOT NULL,
    "customization" "jsonb",
    "target_role" "text",
    "source" "text" DEFAULT 'generated'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "is_primary" boolean DEFAULT true NOT NULL,
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scored_at" timestamp with time zone,
    CONSTRAINT "resumes_ats_score_check" CHECK ((("ats_score" >= 0) AND ("ats_score" <= 100))),
    CONSTRAINT "resumes_source_check" CHECK (("source" = ANY (ARRAY['generated'::"text", 'uploaded'::"text", 'manual'::"text"]))),
    CONSTRAINT "resumes_template_id_check" CHECK (("template_id" = ANY (ARRAY['modern'::"text", 'minimal'::"text", 'ats'::"text", 'creative'::"text", 'executive'::"text", 'modern-photo'::"text"])))
);


ALTER TABLE "public"."resumes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."risk_analysis_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "job_id" "uuid",
    "overall_risk_score" numeric(5,2),
    "risk_level" "text",
    "risk_factors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "recommendations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "market_stability" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "risk_analysis_results_overall_risk_score_check" CHECK ((("overall_risk_score" >= (0)::numeric) AND ("overall_risk_score" <= (100)::numeric))),
    CONSTRAINT "risk_analysis_results_risk_level_check" CHECK (("risk_level" = ANY (ARRAY['Low'::"text", 'Medium'::"text", 'High'::"text", 'Critical'::"text"])))
);


ALTER TABLE "public"."risk_analysis_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."risk_analysis_results" IS 'Stored risk predictor output written by RiskAnalysisWorker. Dashboard reads from here.';



CREATE TABLE IF NOT EXISTS "public"."role_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "alias" "text" NOT NULL,
    "normalizedAlias" "text" NOT NULL,
    "canonicalName" "text" NOT NULL,
    "roleId" "text" NOT NULL,
    "softDeleted" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT "now"() NOT NULL,
    "createdBy" "text",
    "updatedBy" "text"
);


ALTER TABLE "public"."role_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_education" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "education_level" "text" NOT NULL,
    "match_score" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_education" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_market_data" (
    "role" "text" NOT NULL,
    "demand_score" integer DEFAULT 50,
    "growth_score" integer DEFAULT 50,
    "avg_salary_lpa" integer DEFAULT 10
);


ALTER TABLE "public"."role_market_data" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_market_demand" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "country" "text" NOT NULL,
    "job_postings" integer,
    "growth_rate" numeric,
    "competition_score" numeric,
    "remote_ratio" numeric,
    "last_updated" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_market_demand" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_salary_market" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "country" "text" NOT NULL,
    "median_salary" numeric,
    "p25" numeric,
    "p75" numeric,
    "currency" "text" DEFAULT 'INR'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_salary_market" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."salary_bands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text",
    "region" "text",
    "currency" "text" DEFAULT 'INR'::"text",
    "min_salary" numeric,
    "max_salary" numeric,
    "median_salary" numeric,
    "experience_band" "text",
    "source" "text",
    "soft_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "notes" "text",
    "confidence_score" numeric(5,2),
    "is_verified" boolean DEFAULT false,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone
);


ALTER TABLE "public"."salary_bands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."salary_data" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "text" NOT NULL,
    "location" "text",
    "experience_level" "text",
    "industry" "text",
    "source_name" "text",
    "source_type" "text" DEFAULT 'ADMIN'::"text" NOT NULL,
    "min_salary" numeric NOT NULL,
    "max_salary" numeric NOT NULL,
    "confidence_score" numeric DEFAULT 1.0 NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "soft_deleted" boolean DEFAULT false NOT NULL,
    "status" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dedupe_key" "text" NOT NULL
);


ALTER TABLE "public"."salary_data" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sch_school_students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "class" "text",
    "section" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sch_school_students" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sch_school_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sch_school_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sch_schools" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_name" "text",
    "location" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sch_schools" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."secrets_rotation_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "secret_name" "text" NOT NULL,
    "rotated_by" "text" NOT NULL,
    "reason" "text",
    "rotated_at" timestamp with time zone NOT NULL,
    "grace_ends_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."secrets_rotation_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."semantic_match_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "job_id" "text" NOT NULL,
    "semantic_score" numeric(5,2),
    "final_score" numeric(5,2),
    "score_breakdown" "jsonb",
    "missing_skills" "text"[],
    "computed_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval)
);


ALTER TABLE "public"."semantic_match_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skill_demand" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "skill" "text" NOT NULL,
    "demand_score" numeric DEFAULT 60,
    "growth_rate" numeric DEFAULT 0,
    "salary_boost" numeric DEFAULT 0,
    "industry" "text" DEFAULT 'General'::"text"
);


ALTER TABLE "public"."skill_demand" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skill_demand_analyses" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "role" "text",
    "skill_score" numeric,
    "user_skills" "jsonb" DEFAULT '[]'::"jsonb",
    "required_skills" "jsonb" DEFAULT '[]'::"jsonb",
    "skill_gaps" "jsonb" DEFAULT '[]'::"jsonb",
    "top_recommended_skills" "jsonb" DEFAULT '[]'::"jsonb",
    "analyzed_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "soft_deleted" boolean DEFAULT false,
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1
);


ALTER TABLE "public"."skill_demand_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skill_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "skill_name" "text" NOT NULL,
    "embedding" "public"."vector"(384) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."skill_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skill_keywords" (
    "id" bigint NOT NULL,
    "category" "text" NOT NULL,
    "keyword" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."skill_keywords" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."skill_keywords_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."skill_keywords_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."skill_keywords_id_seq" OWNED BY "public"."skill_keywords"."id";



CREATE TABLE IF NOT EXISTS "public"."student_career_profiles" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "data" "jsonb",
    "age" integer,
    "grade" "text",
    "country" "text",
    "preferred_subjects" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "interests" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "strengths" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "career_curiosities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "learning_styles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "academic_marks" "jsonb",
    "profile_version" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "student_career_profiles_age_range" CHECK ((("age" IS NULL) OR (("age" >= 10) AND ("age" <= 30)))),
    CONSTRAINT "student_career_profiles_version_positive" CHECK (("profile_version" >= 1))
);


ALTER TABLE "public"."student_career_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."student_onboarding_drafts" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text",
    "draft_data" "jsonb" DEFAULT '{}'::"jsonb",
    "soft_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1,
    "age" integer,
    "grade" "text",
    "country" "text",
    "preferred_subjects" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "interests" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "strengths" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "career_curiosities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "learning_styles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "academic_marks" "jsonb",
    CONSTRAINT "student_onboarding_drafts_age_range" CHECK ((("age" IS NULL) OR (("age" >= 10) AND ("age" <= 30))))
);


ALTER TABLE "public"."student_onboarding_drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_credit_plans" (
    "id" bigint NOT NULL,
    "plan_amount_inr" integer NOT NULL,
    "credits" integer NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."subscription_credit_plans" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."subscription_credit_plans_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."subscription_credit_plans_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."subscription_credit_plans_id_seq" OWNED BY "public"."subscription_credit_plans"."id";



CREATE TABLE IF NOT EXISTS "public"."subscription_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "provider" "text",
    "external_event_id" "text",
    "plan_amount" numeric,
    "plan_currency" "text",
    "credits_granted" integer,
    "previous_tier" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "new_tier" "text",
    "metadata" "jsonb",
    "idempotency_key" "text" NOT NULL
);


ALTER TABLE "public"."subscription_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "status" "text" DEFAULT 'inactive'::"text" NOT NULL,
    "plan_amount" numeric,
    "plan_currency" "text" DEFAULT 'INR'::"text",
    "ai_credits_allocated" integer DEFAULT 0 NOT NULL,
    "ai_credits_remaining" integer DEFAULT 0 NOT NULL,
    "subscription_id" "text",
    "provider" "text",
    "activated_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "auto_renew" boolean DEFAULT false NOT NULL,
    "trial_ends_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_locks" (
    "lock_id" "text" DEFAULT 'jobSync'::"text" NOT NULL,
    "status" "text" DEFAULT 'idle'::"text" NOT NULL,
    "locked_by" "text",
    "locked_at" timestamp with time zone,
    "released_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    CONSTRAINT "sync_locks_status_check" CHECK (("status" = ANY (ARRAY['idle'::"text", 'running'::"text"])))
);


ALTER TABLE "public"."sync_locks" OWNER TO "postgres";


COMMENT ON TABLE "public"."sync_locks" IS 'Distributed advisory lock table for coordinating singleton jobs across multiple service instances.';



COMMENT ON COLUMN "public"."sync_locks"."lock_id" IS 'Logical lock name. Always ''jobSync'' for the job sync service.';



COMMENT ON COLUMN "public"."sync_locks"."status" IS 'Lock state: idle = available, running = held by an instance.';



COMMENT ON COLUMN "public"."sync_locks"."locked_by" IS 'UUID identifying the instance holding the lock. Should be unique per process (e.g. crypto.randomUUID() at startup).';



COMMENT ON COLUMN "public"."sync_locks"."locked_at" IS 'When the lock was last acquired. Used to detect stale locks (threshold: 30 min).';



COMMENT ON COLUMN "public"."sync_locks"."released_at" IS 'When the lock was last released. Useful for audit and dashboards.';



COMMENT ON COLUMN "public"."sync_locks"."updated_at" IS 'Auto-updated on every row change via trigger.';



CREATE TABLE IF NOT EXISTS "public"."sync_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "text" DEFAULT 'JOB_SYNC'::"text" NOT NULL,
    "source_type" "text",
    "source_origin" "text",
    "total_records" integer DEFAULT 0 NOT NULL,
    "success_count" integer DEFAULT 0 NOT NULL,
    "fail_count" integer DEFAULT 0 NOT NULL,
    "duration_ms" integer,
    "errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "initiated_by" "text",
    "request_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "success_rate" numeric(5,2)
);


ALTER TABLE "public"."sync_logs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."sync_logs"."success_rate" IS 'Job success rate as a percentage (e.g. 98.75). NULL for rows written before this column was added.';



CREATE MATERIALIZED VIEW "public"."top_searches" AS
 SELECT "agency",
    "normalized_query",
    "count"(*) AS "search_count",
    "max"("created_at") AS "last_searched_at"
   FROM "public"."search_events"
  WHERE (("event_type" = 'search'::"text") AND ("created_at" >= ("now"() - '30 days'::interval)))
  GROUP BY "agency", "normalized_query"
  ORDER BY ("count"(*)) DESC
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."top_searches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."uni_programs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "university_id" "uuid" NOT NULL,
    "program_name" "text" NOT NULL,
    "degree_type" "text",
    "duration_years" numeric DEFAULT 4 NOT NULL,
    "tuition_cost" numeric DEFAULT 0 NOT NULL,
    "streams" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "career_outcomes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."uni_programs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."uni_student_matches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "program_id" "uuid" NOT NULL,
    "match_score" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."uni_student_matches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."uni_universities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "university_name" "text" NOT NULL,
    "country" "text",
    "website" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."uni_universities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."uni_university_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "university_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."uni_university_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."usage_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "feature" "text" NOT NULL,
    "tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "model" "text",
    "input_tokens" integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL,
    "total_tokens" integer DEFAULT 0 NOT NULL,
    "cost_usd" numeric(12,8) DEFAULT 0 NOT NULL,
    "revenue_usd" numeric(12,8) DEFAULT 0 NOT NULL,
    "margin_usd" numeric(12,8) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."usage_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."userProfiles" (
    "id" "text" NOT NULL,
    "monthlyAiUsageCount" integer DEFAULT 0,
    "aiUsageResetDate" timestamp without time zone,
    "updatedAt" timestamp without time zone
);


ALTER TABLE "public"."userProfiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_activity_events" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "text" NOT NULL,
    "event_type" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_activity_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_behavior_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "text",
    "entity_label" "text",
    "metadata" "jsonb",
    "session_id" "text",
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_behavior_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['job_click'::"text", 'job_apply'::"text", 'skill_view'::"text", 'course_view'::"text", 'career_path_view'::"text", 'opportunity_click'::"text", 'dashboard_module_usage'::"text", 'job_save'::"text", 'skill_search'::"text", 'role_explore'::"text", 'advice_read'::"text", 'learning_path_start'::"text", 'salary_check'::"text"])))
);


ALTER TABLE "public"."user_behavior_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_fcm_tokens" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "token" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_fcm_tokens" OWNER TO "postgres";


ALTER TABLE "public"."user_fcm_tokens" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_fcm_tokens_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."user_personalization_profile" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "preferred_roles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "preferred_skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "career_interests" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "active_modules" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "engagement_score" numeric(5,2) DEFAULT 0 NOT NULL,
    "total_events" integer DEFAULT 0 NOT NULL,
    "profile_completeness" numeric(5,2) DEFAULT 0 NOT NULL,
    "analyzed_from" timestamp with time zone,
    "analyzed_to" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_personalization_profile_engagement_score_check" CHECK ((("engagement_score" >= (0)::numeric) AND ("engagement_score" <= (100)::numeric))),
    CONSTRAINT "user_personalization_profile_profile_completeness_check" CHECK ((("profile_completeness" >= (0)::numeric) AND ("profile_completeness" <= (100)::numeric)))
);


ALTER TABLE "public"."user_personalization_profile" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "id" "text" NOT NULL,
    "user_id" "text",
    "metadata" "jsonb",
    "consentgrantedat" timestamp without time zone,
    "data" "jsonb",
    "created_at" timestamp without time zone,
    "uid" "text",
    "display_name" "text",
    "email" "text",
    "photo_url" "text",
    "skills" "jsonb" DEFAULT '[]'::"jsonb",
    "industry" "text",
    "industry_id" "text",
    "industry_text" "text",
    "experience_years" integer,
    "experience" "jsonb",
    "target_role" "text",
    "target_role_free_text" "text",
    "job_title" "text",
    "job_function" "text",
    "resume_id" "text",
    "latest_resume_id" "text",
    "resume_uploaded" boolean DEFAULT false,
    "career_history" "jsonb" DEFAULT '[]'::"jsonb",
    "current_city" "text",
    "current_salary_lpa" numeric,
    "expected_salary_lpa" numeric,
    "expected_role_ids" "jsonb" DEFAULT '[]'::"jsonb",
    "job_search_timeline" "text",
    "work_mode" "text",
    "preferred_work_location" "text",
    "professional_summary" "text",
    "professional_profile" "jsonb",
    "onboarding_completed" boolean DEFAULT false,
    "onboarding_completed_at" timestamp with time zone,
    "onboarding_started_at" timestamp with time zone,
    "quick_start_completed" boolean DEFAULT false,
    "last_active_at" timestamp with time zone,
    "last_active_step" "text",
    "chi_status" "text",
    "consent_granted_at" timestamp with time zone,
    "consent_version" "text",
    "consent_source" "text",
    "referral_source" "text",
    "import_source" "text",
    "role_count" integer,
    "skill_count" integer,
    "email_mismatch_detected_at" timestamp with time zone,
    "email_mismatch_note" "text",
    "professional_onboarding_complete" boolean DEFAULT false,
    "draft" "jsonb",
    "draft_saved_at" timestamp with time zone,
    "draft_version" integer,
    "extracted_details" "jsonb",
    "soft_deleted" boolean DEFAULT false,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text",
    "updated_by" "text",
    "version" integer DEFAULT 1,
    "current_job_title" "text",
    "current_company" "text",
    "years_of_experience" integer,
    "years_experience" integer,
    "linked_in_url" "text",
    "portfolio_url" "text",
    "languages" "jsonb" DEFAULT '[]'::"jsonb",
    "work_authorisation" "text",
    "is_premium" boolean DEFAULT false NOT NULL,
    "plan" "text",
    "created_at_tz" timestamp with time zone,
    "student_onboarding_complete" boolean DEFAULT false NOT NULL,
    "student_profile" "jsonb"
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_profiles"."student_profile" IS 'Full student onboarding snapshot (snake_case). Shape: {age, grade, country, preferred_subjects, interests, strengths, career_curiosities, learning_styles, academic_marks}.';



CREATE TABLE IF NOT EXISTS "public"."user_quota" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "month_key" "text" NOT NULL,
    "feature" "text" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "last_updated" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone
);


ALTER TABLE "public"."user_quota" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_roles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'moderator'::"text", 'user'::"text"])))
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."user_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."user_roles_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."user_roles_id_seq" OWNED BY "public"."user_roles"."id";



CREATE TABLE IF NOT EXISTS "public"."user_vectors" (
    "user_id" "text" NOT NULL,
    "embedding_vector" "public"."vector"(1536) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_vectors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "display_name" "text",
    "user_type" "text",
    "career_goal" "text",
    "onboarding_completed" boolean DEFAULT false NOT NULL,
    "target_role" "text",
    "current_job_title" "text",
    "experience_years" numeric(4,1),
    "industry" "text",
    "skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "location" "text",
    "role" "text" DEFAULT 'user'::"text" NOT NULL,
    "tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "plan_amount" numeric,
    "professional_onboarding_complete" boolean DEFAULT false,
    "report_unlocked" boolean DEFAULT false,
    "resume_uploaded" boolean DEFAULT false,
    "student_onboarding_complete" boolean DEFAULT false,
    "subscription_id" "text",
    "subscription_provider" "text",
    "subscription_status" "text" DEFAULT 'inactive'::"text",
    "uid" "text",
    "latest_resume_id" "text",
    "resume" "jsonb",
    "experience" "jsonb",
    "onboarding_step" "text",
    "resume_data" "jsonb",
    "profile_strength" smallint DEFAULT 0,
    "updated_by" "uuid",
    "user_direction" "text",
    "ai_credits_remaining" integer DEFAULT 0 NOT NULL,
    "contributor_promoted_at" timestamp with time zone,
    "contributor_promoted_by" "text",
    "direction_set_at" timestamp with time zone,
    "direction_reset_at" timestamp with time zone,
    CONSTRAINT "chk_users_user_direction" CHECK ((("user_direction" IS NULL) OR ("user_direction" = ANY (ARRAY['education'::"text", 'career'::"text", 'market'::"text"])))),
    CONSTRAINT "user_direction_check" CHECK ((("user_direction" = ANY (ARRAY['education'::"text", 'career'::"text", 'market'::"text"])) OR ("user_direction" IS NULL))),
    CONSTRAINT "user_type_check" CHECK ((("user_type" = ANY (ARRAY['student'::"text", 'professional'::"text"])) OR ("user_type" IS NULL))),
    CONSTRAINT "users_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'admin'::"text", 'super_admin'::"text", 'MASTER_ADMIN'::"text", 'contributor'::"text"]))),
    CONSTRAINT "users_tier_check" CHECK (("tier" = ANY (ARRAY['free'::"text", 'pro'::"text", 'elite'::"text"]))),
    CONSTRAINT "users_user_type_check" CHECK (("user_type" = ANY (ARRAY['student'::"text", 'professional'::"text"])))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON COLUMN "public"."users"."contributor_promoted_at" IS 'Timestamp when the user was last promoted to contributor role.';



COMMENT ON COLUMN "public"."users"."contributor_promoted_by" IS 'UID of the admin who last promoted this user to contributor.';



ALTER TABLE ONLY "public"."ai_observability_logs" ATTACH PARTITION "public"."ai_observability_logs_2025_q1" FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-04-01 00:00:00+00');



ALTER TABLE ONLY "public"."ai_observability_logs" ATTACH PARTITION "public"."ai_observability_logs_2025_q2" FOR VALUES FROM ('2025-04-01 00:00:00+00') TO ('2025-07-01 00:00:00+00');



ALTER TABLE ONLY "public"."ai_observability_logs" ATTACH PARTITION "public"."ai_observability_logs_2025_q3" FOR VALUES FROM ('2025-07-01 00:00:00+00') TO ('2025-10-01 00:00:00+00');



ALTER TABLE ONLY "public"."ai_observability_logs" ATTACH PARTITION "public"."ai_observability_logs_2025_q4" FOR VALUES FROM ('2025-10-01 00:00:00+00') TO ('2026-01-01 00:00:00+00');



ALTER TABLE ONLY "public"."ai_observability_logs" ATTACH PARTITION "public"."ai_observability_logs_2026_q1" FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');



ALTER TABLE ONLY "public"."ai_observability_logs" ATTACH PARTITION "public"."ai_observability_logs_2026_q2" FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');



ALTER TABLE ONLY "public"."admin_users" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."admin_users_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ai_alerts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ai_alerts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ai_usage_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ai_usage_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."career_readiness_scores" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."career_readiness_scores_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."credit_operation_costs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."credit_operation_costs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."edu_academic_records" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."edu_academic_records_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."edu_career_simulations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."edu_career_simulations_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."edu_education_roi" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."edu_education_roi_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."edu_extracurricular" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."edu_extracurricular_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."gcid_analytics_snapshots" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."gcid_analytics_snapshots_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."jd_analysis_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."jd_analysis_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lmi_career_predictions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lmi_career_predictions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."skill_keywords" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."skill_keywords_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."subscription_credit_plans" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."subscription_credit_plans_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."user_roles" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."user_roles_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."activity_events"
    ADD CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."adaptive_weights"
    ADD CONSTRAINT "adaptive_weights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."adaptive_weights"
    ADD CONSTRAINT "adaptive_weights_role_id_experience_bucket_key" UNIQUE ("role_id", "experience_bucket");



ALTER TABLE ONLY "public"."admin_logs"
    ADD CONSTRAINT "admin_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_principals"
    ADD CONSTRAINT "admin_principals_pkey" PRIMARY KEY ("uid");



ALTER TABLE ONLY "public"."admin_secrets"
    ADD CONSTRAINT "admin_secrets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."ai_alerts"
    ADD CONSTRAINT "ai_alerts_alert_key_key" UNIQUE ("alert_key");



ALTER TABLE ONLY "public"."ai_alerts"
    ADD CONSTRAINT "ai_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_cost_daily_usage"
    ADD CONSTRAINT "ai_cost_daily_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_cost_tracking"
    ADD CONSTRAINT "ai_cost_tracking_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_daily_costs"
    ADD CONSTRAINT "ai_daily_costs_pkey" PRIMARY KEY ("user_id", "date");



ALTER TABLE ONLY "public"."ai_jobs"
    ADD CONSTRAINT "ai_jobs_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."ai_jobs"
    ADD CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_observability_logs"
    ADD CONSTRAINT "ai_observability_logs_pkey1" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_observability_logs_2025_q1"
    ADD CONSTRAINT "ai_observability_logs_2025_q1_pkey" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_observability_logs_2025_q2"
    ADD CONSTRAINT "ai_observability_logs_2025_q2_pkey" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_observability_logs_2025_q3"
    ADD CONSTRAINT "ai_observability_logs_2025_q3_pkey" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_observability_logs_2025_q4"
    ADD CONSTRAINT "ai_observability_logs_2025_q4_pkey" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_observability_logs_2026_q1"
    ADD CONSTRAINT "ai_observability_logs_2026_q1_pkey" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_observability_logs_2026_q2"
    ADD CONSTRAINT "ai_observability_logs_2026_q2_pkey" PRIMARY KEY ("id", "created_at");



ALTER TABLE ONLY "public"."ai_pipeline_jobs"
    ADD CONSTRAINT "ai_pipeline_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage_logs"
    ADD CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ats_scores"
    ADD CONSTRAINT "ats_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_jobs"
    ADD CONSTRAINT "automation_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ava_memory"
    ADD CONSTRAINT "ava_memory_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."career_advice_cache"
    ADD CONSTRAINT "career_advice_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_advice_cache"
    ADD CONSTRAINT "career_advice_cache_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."career_advice_results"
    ADD CONSTRAINT "career_advice_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_advice_results"
    ADD CONSTRAINT "career_advice_results_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."career_alerts"
    ADD CONSTRAINT "career_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_health_index"
    ADD CONSTRAINT "career_health_index_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_health_index"
    ADD CONSTRAINT "career_health_index_snapshot_id_key" UNIQUE ("snapshot_id");



ALTER TABLE ONLY "public"."career_health_results"
    ADD CONSTRAINT "career_health_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_insights"
    ADD CONSTRAINT "career_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_metrics"
    ADD CONSTRAINT "career_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_opportunity_signals"
    ADD CONSTRAINT "career_opportunity_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_opportunity_signals"
    ADD CONSTRAINT "career_opportunity_signals_role_name_industry_key" UNIQUE ("role_name", "industry");



ALTER TABLE ONLY "public"."career_paths"
    ADD CONSTRAINT "career_paths_from_role_to_role_key" UNIQUE ("from_role", "to_role");



ALTER TABLE ONLY "public"."career_paths"
    ADD CONSTRAINT "career_paths_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_progress_history"
    ADD CONSTRAINT "career_progress_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_readiness_scores"
    ADD CONSTRAINT "career_readiness_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_role_skills"
    ADD CONSTRAINT "career_role_skills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_role_skills"
    ADD CONSTRAINT "career_role_skills_unique" UNIQUE ("role_id", "skill_id");



ALTER TABLE ONLY "public"."career_role_transitions"
    ADD CONSTRAINT "career_role_transitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_role_transitions"
    ADD CONSTRAINT "career_role_transitions_unique_edge" UNIQUE ("from_role_id", "to_role_id");



ALTER TABLE ONLY "public"."career_roles"
    ADD CONSTRAINT "career_roles_pkey" PRIMARY KEY ("role_id");



ALTER TABLE ONLY "public"."career_simulations"
    ADD CONSTRAINT "career_simulations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."career_skills_registry"
    ADD CONSTRAINT "career_skills_registry_pkey" PRIMARY KEY ("skill_id");



ALTER TABLE ONLY "public"."certifications"
    ADD CONSTRAINT "certifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_logs"
    ADD CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chi_scores"
    ADD CONSTRAINT "chi_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_career_domains"
    ADD CONSTRAINT "cms_career_domains_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."cms_career_domains"
    ADD CONSTRAINT "cms_career_domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_education_levels"
    ADD CONSTRAINT "cms_education_levels_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."cms_education_levels"
    ADD CONSTRAINT "cms_education_levels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_job_families"
    ADD CONSTRAINT "cms_job_families_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."cms_job_families"
    ADD CONSTRAINT "cms_job_families_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_roles"
    ADD CONSTRAINT "cms_roles_normalized_composite_key_key" UNIQUE ("normalized_composite_key");



ALTER TABLE ONLY "public"."cms_roles"
    ADD CONSTRAINT "cms_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_salary_benchmarks"
    ADD CONSTRAINT "cms_salary_benchmarks_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."cms_salary_benchmarks"
    ADD CONSTRAINT "cms_salary_benchmarks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_skill_clusters"
    ADD CONSTRAINT "cms_skill_clusters_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."cms_skill_clusters"
    ADD CONSTRAINT "cms_skill_clusters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cms_skills"
    ADD CONSTRAINT "cms_skills_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."cms_skills"
    ADD CONSTRAINT "cms_skills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consent_versions"
    ADD CONSTRAINT "consent_versions_pkey" PRIMARY KEY ("version");



ALTER TABLE ONLY "public"."conversion_aggregates"
    ADD CONSTRAINT "conversion_aggregates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversion_events"
    ADD CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_conversations"
    ADD CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_grounding_failures"
    ADD CONSTRAINT "copilot_grounding_failures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_rag_contexts"
    ADD CONSTRAINT "copilot_rag_contexts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."courses"
    ADD CONSTRAINT "courses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credit_operation_costs"
    ADD CONSTRAINT "credit_operation_costs_operation_key_key" UNIQUE ("operation_key");



ALTER TABLE ONLY "public"."credit_operation_costs"
    ADD CONSTRAINT "credit_operation_costs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_career_insights"
    ADD CONSTRAINT "daily_career_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_metric_snapshots"
    ADD CONSTRAINT "daily_metric_snapshots_date_key" UNIQUE ("date");



ALTER TABLE ONLY "public"."daily_metric_snapshots"
    ADD CONSTRAINT "daily_metric_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_academic_records"
    ADD CONSTRAINT "edu_academic_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_career_conversations"
    ADD CONSTRAINT "edu_career_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_career_predictions"
    ADD CONSTRAINT "edu_career_predictions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_career_simulations"
    ADD CONSTRAINT "edu_career_simulations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_cognitive_results"
    ADD CONSTRAINT "edu_cognitive_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_education_roi"
    ADD CONSTRAINT "edu_education_roi_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_extracurricular"
    ADD CONSTRAINT "edu_extracurricular_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_skill_recommendations"
    ADD CONSTRAINT "edu_skill_recommendations_pkey" PRIMARY KEY ("student_id");



ALTER TABLE ONLY "public"."edu_stream_scores"
    ADD CONSTRAINT "edu_stream_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_stream_scores"
    ADD CONSTRAINT "edu_stream_scores_student_unique" UNIQUE ("student_id");



ALTER TABLE ONLY "public"."edu_student_skills"
    ADD CONSTRAINT "edu_student_skills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edu_students"
    ADD CONSTRAINT "edu_students_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emp_employer_users"
    ADD CONSTRAINT "emp_employer_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emp_employers"
    ADD CONSTRAINT "emp_employers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emp_job_roles"
    ADD CONSTRAINT "emp_job_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emp_talent_signals"
    ADD CONSTRAINT "emp_talent_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_outbox"
    ADD CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_salary_apis"
    ADD CONSTRAINT "external_salary_apis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gcid_aggregated_cache"
    ADD CONSTRAINT "gcid_aggregated_cache_pkey" PRIMARY KEY ("metric_name");



ALTER TABLE ONLY "public"."gcid_analytics_snapshots"
    ADD CONSTRAINT "gcid_analytics_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."generated_cvs"
    ADD CONSTRAINT "generated_cvs_generation_hash_key" UNIQUE ("generation_hash");



ALTER TABLE ONLY "public"."generated_cvs"
    ADD CONSTRAINT "generated_cvs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_check"
    ADD CONSTRAINT "health_check_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_logs"
    ADD CONSTRAINT "import_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jd_analysis_logs"
    ADD CONSTRAINT "jd_analysis_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_analyses"
    ADD CONSTRAINT "job_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_applications"
    ADD CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_embeddings"
    ADD CONSTRAINT "job_embeddings_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."job_embeddings"
    ADD CONSTRAINT "job_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_families"
    ADD CONSTRAINT "job_families_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."job_families"
    ADD CONSTRAINT "job_families_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_listings_cache"
    ADD CONSTRAINT "job_listings_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_match_results"
    ADD CONSTRAINT "job_match_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_match_results"
    ADD CONSTRAINT "job_match_results_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."learning_paths_cache"
    ADD CONSTRAINT "learning_paths_cache_pkey" PRIMARY KEY ("skill");



ALTER TABLE ONLY "public"."learning_resources"
    ADD CONSTRAINT "learning_resources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lmi_career_market_scores"
    ADD CONSTRAINT "lmi_career_market_scores_career_name_key" UNIQUE ("career_name");



ALTER TABLE ONLY "public"."lmi_career_market_scores"
    ADD CONSTRAINT "lmi_career_market_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lmi_career_predictions"
    ADD CONSTRAINT "lmi_career_predictions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lmi_ingestion_runs"
    ADD CONSTRAINT "lmi_ingestion_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lmi_job_market_data"
    ADD CONSTRAINT "lmi_job_market_data_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."market_intelligence_cache"
    ADD CONSTRAINT "market_intelligence_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."market_intelligence_sync"
    ADD CONSTRAINT "market_intelligence_sync_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."metrics_daily_snapshots"
    ADD CONSTRAINT "metrics_daily_snapshots_pkey" PRIMARY KEY ("date");



ALTER TABLE ONLY "public"."notification_delivery"
    ADD CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_jobs"
    ADD CONSTRAINT "notification_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."opportunity_radar_results"
    ADD CONSTRAINT "opportunity_radar_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_logs"
    ADD CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pending_entries"
    ADD CONSTRAINT "pending_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personalized_recommendations"
    ADD CONSTRAINT "personalized_recommendations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_ai_model_settings"
    ADD CONSTRAINT "pi_ai_model_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_ai_prompts"
    ADD CONSTRAINT "pi_ai_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_ai_usage_logs"
    ADD CONSTRAINT "pi_ai_usage_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_career_datasets"
    ADD CONSTRAINT "pi_career_datasets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_career_paths"
    ADD CONSTRAINT "pi_career_paths_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_chi_weights"
    ADD CONSTRAINT "pi_chi_weights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_feature_flags"
    ADD CONSTRAINT "pi_feature_flags_feature_name_key" UNIQUE ("feature_name");



ALTER TABLE ONLY "public"."pi_feature_flags"
    ADD CONSTRAINT "pi_feature_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_market_data_sources"
    ADD CONSTRAINT "pi_market_data_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_skill_taxonomy"
    ADD CONSTRAINT "pi_skill_taxonomy_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_subscription_plans"
    ADD CONSTRAINT "pi_subscription_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pi_training_sources"
    ADD CONSTRAINT "pi_training_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."professional_career_profiles"
    ADD CONSTRAINT "professional_career_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qualifications"
    ADD CONSTRAINT "qualifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rate_limits"
    ADD CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."resume_analyses"
    ADD CONSTRAINT "resume_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resume_exports"
    ADD CONSTRAINT "resume_exports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resume_growth_signals"
    ADD CONSTRAINT "resume_growth_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resume_scores"
    ADD CONSTRAINT "resume_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resume_versions"
    ADD CONSTRAINT "resume_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resumes"
    ADD CONSTRAINT "resumes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."risk_analysis_results"
    ADD CONSTRAINT "risk_analysis_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_aliases"
    ADD CONSTRAINT "role_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_education"
    ADD CONSTRAINT "role_education_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_market_data"
    ADD CONSTRAINT "role_market_data_pkey" PRIMARY KEY ("role");



ALTER TABLE ONLY "public"."role_market_demand"
    ADD CONSTRAINT "role_market_demand_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_salary_market"
    ADD CONSTRAINT "role_salary_market_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_skills"
    ADD CONSTRAINT "role_skills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_transitions"
    ADD CONSTRAINT "role_transitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_bands"
    ADD CONSTRAINT "salary_bands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_data"
    ADD CONSTRAINT "salary_data_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sch_school_students"
    ADD CONSTRAINT "sch_school_students_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sch_school_users"
    ADD CONSTRAINT "sch_school_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sch_schools"
    ADD CONSTRAINT "sch_schools_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."search_events"
    ADD CONSTRAINT "search_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."secrets_rotation_log"
    ADD CONSTRAINT "secrets_rotation_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."semantic_match_cache"
    ADD CONSTRAINT "semantic_match_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."semantic_match_cache"
    ADD CONSTRAINT "semantic_match_cache_user_id_job_id_key" UNIQUE ("user_id", "job_id");



ALTER TABLE ONLY "public"."skill_demand_analyses"
    ADD CONSTRAINT "skill_demand_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."skill_demand"
    ADD CONSTRAINT "skill_demand_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."skill_embeddings"
    ADD CONSTRAINT "skill_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."skill_embeddings"
    ADD CONSTRAINT "skill_embeddings_skill_name_key" UNIQUE ("skill_name");



ALTER TABLE ONLY "public"."skill_keywords"
    ADD CONSTRAINT "skill_keywords_keyword_key" UNIQUE ("keyword");



ALTER TABLE ONLY "public"."skill_keywords"
    ADD CONSTRAINT "skill_keywords_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."skill_relationships"
    ADD CONSTRAINT "skill_relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."skills"
    ADD CONSTRAINT "skills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_career_profiles"
    ADD CONSTRAINT "student_career_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_career_profiles"
    ADD CONSTRAINT "student_career_profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."student_onboarding_drafts"
    ADD CONSTRAINT "student_onboarding_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_onboarding_drafts"
    ADD CONSTRAINT "student_onboarding_drafts_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."subscription_credit_plans"
    ADD CONSTRAINT "subscription_credit_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_credit_plans"
    ADD CONSTRAINT "subscription_credit_plans_plan_amount_inr_key" UNIQUE ("plan_amount_inr");



ALTER TABLE ONLY "public"."subscription_events"
    ADD CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."sync_locks"
    ADD CONSTRAINT "sync_locks_pkey" PRIMARY KEY ("lock_id");



ALTER TABLE ONLY "public"."sync_logs"
    ADD CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."uni_programs"
    ADD CONSTRAINT "uni_programs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."uni_student_matches"
    ADD CONSTRAINT "uni_student_matches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."uni_universities"
    ADD CONSTRAINT "uni_universities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."uni_university_users"
    ADD CONSTRAINT "uni_university_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_secrets"
    ADD CONSTRAINT "uq_admin_secrets_name" UNIQUE ("name");



ALTER TABLE ONLY "public"."emp_employer_users"
    ADD CONSTRAINT "uq_emp_employer_users_employer_user" UNIQUE ("employer_id", "user_id");



ALTER TABLE ONLY "public"."gcid_analytics_snapshots"
    ADD CONSTRAINT "uq_gcid_snapshot_metric_region_date" UNIQUE ("metric_name", "region", "snapshot_date");



ALTER TABLE ONLY "public"."resume_analyses"
    ADD CONSTRAINT "uq_resume_analyses_resume_hash_engine" UNIQUE ("resume_id", "analysis_hash", "engine");



ALTER TABLE ONLY "public"."sch_school_students"
    ADD CONSTRAINT "uq_school_students_school_student" UNIQUE ("school_id", "student_id");



ALTER TABLE ONLY "public"."sch_school_users"
    ADD CONSTRAINT "uq_school_users_school_user" UNIQUE ("school_id", "user_id");



ALTER TABLE ONLY "public"."edu_student_skills"
    ADD CONSTRAINT "uq_student_skill" UNIQUE ("student_id", "skill_name");



ALTER TABLE ONLY "public"."uni_student_matches"
    ADD CONSTRAINT "uq_uni_student_matches" UNIQUE ("student_id", "program_id");



ALTER TABLE ONLY "public"."uni_university_users"
    ADD CONSTRAINT "uq_uni_university_users" UNIQUE ("university_id", "user_id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "uq_user_profiles_user_id" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "uq_user_role" UNIQUE ("user_id", "role");



ALTER TABLE ONLY "public"."ai_cost_daily_usage"
    ADD CONSTRAINT "uq_user_usage_date" UNIQUE ("user_id", "usage_date");



ALTER TABLE ONLY "public"."usage_logs"
    ADD CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."userProfiles"
    ADD CONSTRAINT "userProfiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_activity_events"
    ADD CONSTRAINT "user_activity_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_behavior_events"
    ADD CONSTRAINT "user_behavior_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_fcm_tokens"
    ADD CONSTRAINT "user_fcm_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_personalization_profile"
    ADD CONSTRAINT "user_personalization_profile_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_personalization_profile"
    ADD CONSTRAINT "user_personalization_profile_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_quota"
    ADD CONSTRAINT "user_quota_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_quota"
    ADD CONSTRAINT "user_quota_user_id_month_key_feature_key" UNIQUE ("user_id", "month_key", "feature");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_vectors"
    ADD CONSTRAINT "user_vectors_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE INDEX "ai_jobs_expires_at_idx" ON "public"."ai_jobs" USING "btree" ("expires_at");



CREATE INDEX "ai_jobs_status_idx" ON "public"."ai_jobs" USING "btree" ("status");



CREATE INDEX "ai_jobs_user_id_idx" ON "public"."ai_jobs" USING "btree" ("user_id");



CREATE INDEX "ai_usage_created_at_idx" ON "public"."ai_usage" USING "btree" ("created_at" DESC);



CREATE INDEX "ai_usage_feature_idx" ON "public"."ai_usage" USING "btree" ("feature");



CREATE INDEX "ai_usage_user_id_idx" ON "public"."ai_usage" USING "btree" ("user_id");



CREATE INDEX "ats_scores_resume_id_idx" ON "public"."ats_scores" USING "btree" ("resume_id");



CREATE INDEX "ats_scores_user_id_idx" ON "public"."ats_scores" USING "btree" ("user_id");



CREATE INDEX "ava_memory_activity_idx" ON "public"."ava_memory" USING "btree" ("last_active_date" DESC, "jobs_applied" DESC);



CREATE INDEX "ava_memory_perf_idx" ON "public"."ava_memory" USING "btree" ("current_score" DESC, "weekly_progress" DESC);



CREATE INDEX "career_insights_generated_at_idx" ON "public"."career_insights" USING "btree" ("generated_at" DESC);



CREATE INDEX "career_insights_user_id_idx" ON "public"."career_insights" USING "btree" ("user_id");



CREATE INDEX "career_simulations_created_at_idx" ON "public"."career_simulations" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "career_simulations_user_id_idx" ON "public"."career_simulations" USING "btree" ("user_id");



CREATE INDEX "chi_generated_at_idx" ON "public"."career_health_index" USING "btree" ("generated_at" DESC);



CREATE INDEX "chi_user_id_idx" ON "public"."career_health_index" USING "btree" ("user_id");



CREATE INDEX "conversion_aggregates_intent_idx" ON "public"."conversion_aggregates" USING "btree" ("total_intent_score" DESC);



CREATE INDEX "idx_acdu_tier" ON "public"."ai_cost_daily_usage" USING "btree" ("tier");



CREATE INDEX "idx_acdu_usage_date" ON "public"."ai_cost_daily_usage" USING "btree" ("usage_date" DESC);



CREATE INDEX "idx_acdu_user_id" ON "public"."ai_cost_daily_usage" USING "btree" ("user_id");



CREATE INDEX "idx_activity_events_user_created_event" ON "public"."activity_events" USING "btree" ("user_id", "created_at" DESC, "event_type") WHERE ("event_type" = ANY (ARRAY['skill_added'::"text", 'course_started'::"text"]));



CREATE INDEX "idx_admin_logs_action_created" ON "public"."admin_logs" USING "btree" ("action", "created_at" DESC);



CREATE INDEX "idx_admin_logs_admin_created" ON "public"."admin_logs" USING "btree" ("admin_id", "created_at" DESC);



CREATE INDEX "idx_admin_logs_entity" ON "public"."admin_logs" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_admin_principals_active" ON "public"."admin_principals" USING "btree" ("is_active", "verified_at" DESC);



CREATE INDEX "idx_admin_users_user_id" ON "public"."admin_users" USING "btree" ("user_id");



CREATE INDEX "idx_ai_alerts_created_at" ON "public"."ai_alerts" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_ai_alerts_resolved" ON "public"."ai_alerts" USING "btree" ("resolved") WHERE ("resolved" = false);



CREATE INDEX "idx_ai_alerts_type" ON "public"."ai_alerts" USING "btree" ("type");



CREATE INDEX "idx_ai_cost_tracking_date_range" ON "public"."ai_cost_tracking" USING "btree" ("date" DESC) WHERE ("is_deleted" = false);



CREATE INDEX "idx_ai_cost_tracking_user_date" ON "public"."ai_cost_tracking" USING "btree" ("user_id", "date" DESC);



CREATE INDEX "idx_ai_jobs_pending_active_user" ON "public"."ai_jobs" USING "btree" ("user_id", "status") WHERE ("soft_deleted" IS NOT TRUE);



CREATE INDEX "idx_ai_jobs_processing_started_at" ON "public"."ai_jobs" USING "btree" ("started_at") WHERE ("status" = 'processing'::"text");



CREATE INDEX "idx_ai_jobs_status_created_at" ON "public"."ai_jobs" USING "btree" ("status", "created_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text"]));



CREATE INDEX "idx_ai_usage_logs_feature" ON "public"."ai_usage_logs" USING "btree" ("feature");



CREATE INDEX "idx_ai_usage_logs_success" ON "public"."ai_usage_logs" USING "btree" ("success") WHERE ("success" = false);



CREATE INDEX "idx_ai_usage_logs_user_created" ON "public"."ai_usage_logs" USING "btree" ("user_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_alerts_user_dedup" ON "public"."career_alerts" USING "btree" ("user_id", "dedup_key") WHERE ("dedup_key" IS NOT NULL);



CREATE INDEX "idx_alerts_user_feed" ON "public"."career_alerts" USING "btree" ("user_id", "alert_priority", "created_at" DESC);



CREATE INDEX "idx_alerts_user_unread" ON "public"."career_alerts" USING "btree" ("user_id", "alert_priority", "created_at" DESC) WHERE ("is_read" = false);



CREATE INDEX "idx_automation_jobs_active" ON "public"."automation_jobs" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_automation_jobs_dead_failed_at" ON "public"."automation_jobs" USING "btree" ("failed_at" DESC) WHERE (("status" = 'dead'::"text") AND ("deleted_at" IS NULL));



CREATE INDEX "idx_automation_jobs_user_idempotency" ON "public"."automation_jobs" USING "btree" ("user_id", "idempotency_key", "created_at" DESC);



CREATE INDEX "idx_automation_jobs_user_status_active" ON "public"."automation_jobs" USING "btree" ("user_id", "status", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_behavior_events_cleanup" ON "public"."user_behavior_events" USING "btree" ("timestamp");



CREATE INDEX "idx_behavior_events_entity" ON "public"."user_behavior_events" USING "btree" ("user_id", "entity_type", "entity_id");



CREATE INDEX "idx_behavior_events_type" ON "public"."user_behavior_events" USING "btree" ("user_id", "event_type", "timestamp" DESC);



CREATE INDEX "idx_behavior_events_user_time" ON "public"."user_behavior_events" USING "btree" ("user_id", "timestamp" DESC);



CREATE INDEX "idx_career_health_index_user_generated" ON "public"."career_health_index" USING "btree" ("user_id", "generated_at" DESC);



CREATE INDEX "idx_career_metrics_user_recorded_desc" ON "public"."career_metrics" USING "btree" ("user_id", "recorded_at" DESC);



CREATE INDEX "idx_career_predictions_probability_desc" ON "public"."lmi_career_predictions" USING "btree" ("student_id", "success_probability" DESC);



CREATE INDEX "idx_career_role_skills_role" ON "public"."career_role_skills" USING "btree" ("role_id", "importance");



CREATE INDEX "idx_career_role_skills_skill" ON "public"."career_role_skills" USING "btree" ("skill_id", "importance");



CREATE INDEX "idx_career_role_transitions_demand" ON "public"."career_role_transitions" USING "btree" ("demand_score" DESC, "difficulty_score") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_role_transitions_from" ON "public"."career_role_transitions" USING "btree" ("from_role_id", "transition_type", "difficulty_score") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_role_transitions_to" ON "public"."career_role_transitions" USING "btree" ("to_role_id", "transition_type", "difficulty_score") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_roles_alt_titles_gin" ON "public"."career_roles" USING "gin" ("alternative_titles") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_roles_demand" ON "public"."career_roles" USING "btree" ("demand_score" DESC) WHERE (("soft_deleted" = false) AND ("is_active" = true));



CREATE INDEX "idx_career_roles_family" ON "public"."career_roles" USING "btree" ("role_family", "track", "seniority_rank") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_roles_family_rank" ON "public"."career_roles" USING "btree" ("role_family", "seniority_rank") WHERE (("soft_deleted" = false) AND ("is_active" = true));



CREATE INDEX "idx_career_roles_name_trgm" ON "public"."career_roles" USING "gin" ("normalized_name" "public"."gin_trgm_ops") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_roles_search_vector" ON "public"."career_roles" USING "gin" ("search_vector") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_simulations_salary_desc" ON "public"."edu_career_simulations" USING "btree" ("student_id", "salary_10_year" DESC NULLS LAST);



CREATE INDEX "idx_career_simulations_user_id" ON "public"."career_simulations" USING "btree" ("user_id");



CREATE INDEX "idx_career_skills_registry_category" ON "public"."career_skills_registry" USING "btree" ("skill_category", "demand_score" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_skills_registry_emerging" ON "public"."career_skills_registry" USING "btree" ("demand_score" DESC) WHERE (("soft_deleted" = false) AND ("is_emerging" = true));



CREATE INDEX "idx_career_skills_registry_name_trgm" ON "public"."career_skills_registry" USING "gin" ("normalized_name" "public"."gin_trgm_ops") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_career_skills_registry_search_vector" ON "public"."career_skills_registry" USING "gin" ("search_vector") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_certifications_related_skills" ON "public"."certifications" USING "gin" ("related_skills");



CREATE INDEX "idx_certifications_soft_deleted" ON "public"."certifications" USING "btree" ("soft_deleted") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_change_logs_document_history" ON "public"."change_logs" USING "btree" ("collection_name", "document_id", "timestamp" DESC);



CREATE INDEX "idx_change_logs_recent" ON "public"."change_logs" USING "btree" ("timestamp" DESC);



CREATE INDEX "idx_change_logs_user_activity" ON "public"."change_logs" USING "btree" ("user_id", "timestamp" DESC);



CREATE INDEX "idx_chi_scores_user_chi" ON "public"."chi_scores" USING "btree" ("user_id", "chi_score" DESC);



CREATE INDEX "idx_chi_scores_user_role" ON "public"."chi_scores" USING "btree" ("user_id", "role_id");



CREATE INDEX "idx_chi_user_recent" ON "public"."career_health_index" USING "btree" ("user_id", "generated_at" DESC);



CREATE UNIQUE INDEX "idx_clusters_normalized_name" ON "public"."cms_skill_clusters" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_agency" ON "public"."cms_roles" USING "btree" ("source_agency") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_agency_family" ON "public"."cms_roles" USING "btree" ("source_agency", "job_family_id") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "idx_cms_roles_composite_key" ON "public"."cms_roles" USING "btree" ("normalized_composite_key") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_created_at" ON "public"."cms_roles" USING "btree" ("created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_domain_active" ON "public"."cms_roles" USING "btree" ("domain_id", "market_demand" DESC) WHERE (("soft_deleted" = false) AND ("status" = 'active'::"text"));



CREATE INDEX "idx_cms_roles_family" ON "public"."cms_roles" USING "btree" ("job_family_id") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_family_status" ON "public"."cms_roles" USING "btree" ("job_family_id", "status") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_market_demand_active" ON "public"."cms_roles" USING "btree" ("job_family_id", "market_demand" DESC) WHERE (("soft_deleted" = false) AND ("status" = 'active'::"text"));



CREATE INDEX "idx_cms_roles_name_trgm" ON "public"."cms_roles" USING "gin" ("name" "public"."gin_trgm_ops") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_normalized" ON "public"."cms_roles" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_normalized_name_trgm" ON "public"."cms_roles" USING "gin" ("normalized_name" "public"."gin_trgm_ops") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_status" ON "public"."cms_roles" USING "btree" ("status") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_roles_status_created" ON "public"."cms_roles" USING "btree" ("status", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_salary_benchmarks_name_trgm" ON "public"."cms_salary_benchmarks" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_cms_salary_benchmarks_normalized_name_trgm" ON "public"."cms_salary_benchmarks" USING "gin" ("normalized_name" "public"."gin_trgm_ops");



CREATE INDEX "idx_cms_skills_category" ON "public"."cms_skills" USING "btree" ("category") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_skills_normalized" ON "public"."cms_skills" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_cms_skills_status" ON "public"."cms_skills" USING "btree" ("status") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_conv_agg_event_counts_gin" ON "public"."conversion_aggregates" USING "gin" ("event_counts");



CREATE INDEX "idx_conv_agg_last_event_at" ON "public"."conversion_aggregates" USING "btree" ("last_event_at" DESC);



CREATE INDEX "idx_conv_agg_total_intent_score" ON "public"."conversion_aggregates" USING "btree" ("total_intent_score" DESC NULLS LAST);



CREATE UNIQUE INDEX "idx_conversation_turn_unique" ON "public"."copilot_conversations" USING "btree" ("conversation_id", "turn_index");



CREATE INDEX "idx_conversion_dedup" ON "public"."conversion_events" USING "btree" ("user_id", "event_type", "idempotency_key", "timestamp" DESC);



CREATE UNIQUE INDEX "idx_conversion_events_dedup" ON "public"."conversion_events" USING "btree" ("user_id", "event_type", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "idx_conversion_events_summary" ON "public"."conversion_events" USING "btree" ("timestamp" DESC, "event_type");



CREATE INDEX "idx_copilot_convos_session" ON "public"."copilot_conversations" USING "btree" ("conversation_id", "turn_index");



CREATE INDEX "idx_copilot_convos_user" ON "public"."copilot_conversations" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_credit_operation_costs_is_active" ON "public"."credit_operation_costs" USING "btree" ("is_active");



CREATE INDEX "idx_credit_operation_costs_operation_key" ON "public"."credit_operation_costs" USING "btree" ("operation_key");



CREATE INDEX "idx_crs_candidate_role_time" ON "public"."career_readiness_scores" USING "btree" ("candidate_id", "role_id", "scored_at" DESC);



CREATE INDEX "idx_daily_metric_snapshots_date" ON "public"."daily_metric_snapshots" USING "btree" ("date" DESC);



CREATE INDEX "idx_demand_country" ON "public"."role_market_demand" USING "btree" ("country");



CREATE INDEX "idx_demand_role_id" ON "public"."role_market_demand" USING "btree" ("role_id");



CREATE UNIQUE INDEX "idx_demand_unique" ON "public"."role_market_demand" USING "btree" ("role_id", "country");



CREATE UNIQUE INDEX "idx_domains_normalized_name" ON "public"."cms_career_domains" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_edu_academic_records_student_id" ON "public"."edu_academic_records" USING "btree" ("student_id");



CREATE INDEX "idx_edu_career_conversations_created_desc" ON "public"."edu_career_conversations" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_edu_career_conversations_student_created_desc" ON "public"."edu_career_conversations" USING "btree" ("student_id", "created_at" DESC);



CREATE INDEX "idx_edu_career_predictions_student_id" ON "public"."edu_career_predictions" USING "btree" ("student_id");



CREATE INDEX "idx_edu_career_simulations_student_id" ON "public"."edu_career_simulations" USING "btree" ("student_id");



CREATE INDEX "idx_edu_cognitive_results_student_id" ON "public"."edu_cognitive_results" USING "btree" ("student_id");



CREATE INDEX "idx_edu_education_roi_student_id" ON "public"."edu_education_roi" USING "btree" ("student_id");



CREATE INDEX "idx_edu_extracurricular_student_id" ON "public"."edu_extracurricular" USING "btree" ("student_id");



CREATE INDEX "idx_edu_skill_recs_skills_gin" ON "public"."edu_skill_recommendations" USING "gin" ("skills");



CREATE INDEX "idx_edu_stream_scores_student_id" ON "public"."edu_stream_scores" USING "btree" ("student_id");



CREATE INDEX "idx_edu_student_skills_proficiency" ON "public"."edu_student_skills" USING "btree" ("student_id", "proficiency_level");



CREATE INDEX "idx_edu_student_skills_student_id" ON "public"."edu_student_skills" USING "btree" ("student_id");



CREATE INDEX "idx_edu_students_education_level" ON "public"."edu_students" USING "btree" ("education_level");



CREATE INDEX "idx_edu_students_skills" ON "public"."edu_students" USING "gin" ("skills");



CREATE UNIQUE INDEX "idx_education_normalized_name" ON "public"."cms_education_levels" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_education_roi_score_desc" ON "public"."edu_education_roi" USING "btree" ("student_id", "roi_score" DESC NULLS LAST);



CREATE INDEX "idx_emp_employer_users_employer_id" ON "public"."emp_employer_users" USING "btree" ("employer_id");



CREATE INDEX "idx_emp_employer_users_user_id" ON "public"."emp_employer_users" USING "btree" ("user_id");



CREATE INDEX "idx_emp_employers_created_by" ON "public"."emp_employers" USING "btree" ("created_by");



CREATE INDEX "idx_emp_job_roles_active" ON "public"."emp_job_roles" USING "btree" ("active") WHERE ("active" = true);



CREATE INDEX "idx_emp_job_roles_active_created" ON "public"."emp_job_roles" USING "btree" ("active", "created_at" DESC);



CREATE INDEX "idx_emp_job_roles_employer_active" ON "public"."emp_job_roles" USING "btree" ("employer_id", "active");



CREATE INDEX "idx_emp_job_roles_employer_id" ON "public"."emp_job_roles" USING "btree" ("employer_id");



CREATE INDEX "idx_emp_job_roles_required_skills_gin" ON "public"."emp_job_roles" USING "gin" ("required_skills");



CREATE INDEX "idx_emp_job_roles_streams_gin" ON "public"."emp_job_roles" USING "gin" ("streams");



CREATE INDEX "idx_emp_talent_signals_employer_id" ON "public"."emp_talent_signals" USING "btree" ("employer_id");



CREATE INDEX "idx_emp_talent_signals_job_role_id" ON "public"."emp_talent_signals" USING "btree" ("job_role_id");



CREATE INDEX "idx_emp_talent_signals_signal_type" ON "public"."emp_talent_signals" USING "btree" ("signal_type");



CREATE INDEX "idx_emp_talent_signals_student_id" ON "public"."emp_talent_signals" USING "btree" ("student_id");



CREATE INDEX "idx_event_outbox_event_id" ON "public"."event_outbox" USING "btree" ("event_id");



CREATE INDEX "idx_event_outbox_failed" ON "public"."event_outbox" USING "btree" ("published_at") WHERE (("processed_at" IS NULL) AND ("retry_count" >= 5));



CREATE UNIQUE INDEX "idx_event_outbox_idempotency" ON "public"."event_outbox" USING "btree" ("idempotency_key");



CREATE INDEX "idx_event_outbox_pending_route" ON "public"."event_outbox" USING "btree" ("route", "published_at") WHERE ("processed_at" IS NULL);



CREATE INDEX "idx_event_outbox_unprocessed" ON "public"."event_outbox" USING "btree" ("published_at") WHERE ("processed_at" IS NULL);



CREATE INDEX "idx_external_salary_apis_active_sync" ON "public"."external_salary_apis" USING "btree" ("enabled", "soft_deleted", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_gcid_cache_computed_at" ON "public"."gcid_aggregated_cache" USING "btree" ("computed_at" DESC);



CREATE INDEX "idx_gcid_snapshots_metric_region_date" ON "public"."gcid_analytics_snapshots" USING "btree" ("metric_name", "region", "snapshot_date" DESC);



CREATE INDEX "idx_gcv_cache_hit" ON "public"."generated_cvs" USING "btree" ("cache_hit") WHERE ("cache_hit" = true);



CREATE INDEX "idx_gcv_created_at" ON "public"."generated_cvs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_gcv_cv_content_gin" ON "public"."generated_cvs" USING "gin" ("cv_content");



CREATE INDEX "idx_gcv_model_version" ON "public"."generated_cvs" USING "btree" ("model_version");



CREATE INDEX "idx_gcv_user_id" ON "public"."generated_cvs" USING "btree" ("user_id");



CREATE INDEX "idx_grounding_failures_missing" ON "public"."copilot_grounding_failures" USING "gin" ("missing_sources");



CREATE INDEX "idx_grounding_failures_user" ON "public"."copilot_grounding_failures" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_health_user" ON "public"."career_health_results" USING "btree" ("user_id", "computed_at" DESC);



CREATE INDEX "idx_ik_created_at" ON "public"."idempotency_keys" USING "btree" ("created_at");



CREATE INDEX "idx_ik_user_id" ON "public"."idempotency_keys" USING "btree" ("user_id");



CREATE INDEX "idx_import_logs_entity_type" ON "public"."import_logs" USING "btree" ("entity_type", "imported_at" DESC);



CREATE INDEX "idx_import_logs_imported_at" ON "public"."import_logs" USING "btree" ("imported_at" DESC);



CREATE INDEX "idx_ingestion_runs_created_at_desc" ON "public"."lmi_ingestion_runs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_insights_user_feed" ON "public"."daily_career_insights" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_insights_user_type_feed" ON "public"."daily_career_insights" USING "btree" ("user_id", "insight_type", "created_at" DESC);



CREATE INDEX "idx_insights_user_unread_feed" ON "public"."daily_career_insights" USING "btree" ("user_id", "is_read", "created_at" DESC);



CREATE INDEX "idx_jd_analysis_logs_created_score" ON "public"."jd_analysis_logs" USING "btree" ("created_at" DESC, "match_score");



CREATE INDEX "idx_job_analyses_user_created" ON "public"."job_analyses" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_job_applications_active" ON "public"."job_applications" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_job_embedding" ON "public"."job_embeddings" USING "ivfflat" ("embedding_vector" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "idx_job_families_name" ON "public"."job_families" USING "btree" ("name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_job_listings_cache_expiry" ON "public"."job_listings_cache" USING "btree" ("expires_at");



CREATE INDEX "idx_job_market_posting_date" ON "public"."lmi_job_market_data" USING "btree" ("posting_date" DESC);



CREATE INDEX "idx_job_market_source" ON "public"."lmi_job_market_data" USING "btree" ("source");



CREATE INDEX "idx_job_market_source_posting_date" ON "public"."lmi_job_market_data" USING "btree" ("source", "posting_date" DESC);



CREATE INDEX "idx_job_match_results_user_latest" ON "public"."job_match_results" USING "btree" ("user_id", "computed_at" DESC);



CREATE INDEX "idx_jobapps_active_user_created" ON "public"."job_applications" USING "btree" ("user_id", "created_at" DESC, "id" DESC) WHERE ("deleted" = false);



CREATE UNIQUE INDEX "idx_jobfamilies_normalized_name" ON "public"."cms_job_families" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_jobs_attempts" ON "public"."automation_jobs" USING "btree" ("attempts");



CREATE INDEX "idx_jobs_status" ON "public"."automation_jobs" USING "btree" ("status");



CREATE INDEX "idx_learning_skill" ON "public"."learning_resources" USING "btree" ("skill");



CREATE INDEX "idx_lmi_career_predictions_student_id" ON "public"."lmi_career_predictions" USING "btree" ("student_id");



CREATE INDEX "idx_lmi_career_scores_salary" ON "public"."lmi_career_market_scores" USING "btree" ("avg_entry_salary" DESC);



CREATE INDEX "idx_lmi_career_scores_trend_score" ON "public"."lmi_career_market_scores" USING "btree" ("trend_score" DESC);



CREATE INDEX "idx_market_sync_synced_at_desc" ON "public"."market_intelligence_sync" USING "btree" ("synced_at" DESC);



CREATE INDEX "idx_most_clicked_roles_agency" ON "public"."most_clicked_roles" USING "btree" ("agency", "click_count" DESC);



CREATE INDEX "idx_most_clicked_roles_click_count" ON "public"."most_clicked_roles" USING "btree" ("click_count" DESC);



CREATE INDEX "idx_most_clicked_roles_last_clicked" ON "public"."most_clicked_roles" USING "btree" ("last_clicked_at" DESC);



CREATE INDEX "idx_most_clicked_roles_recent_agency" ON "public"."most_clicked_roles_recent" USING "btree" ("agency", "click_count" DESC);



CREATE INDEX "idx_most_clicked_roles_recent_click_count" ON "public"."most_clicked_roles_recent" USING "btree" ("click_count" DESC);



CREATE INDEX "idx_most_clicked_roles_recent_last_clicked" ON "public"."most_clicked_roles_recent" USING "btree" ("last_clicked_at" DESC);



CREATE UNIQUE INDEX "idx_most_clicked_roles_recent_role_agency" ON "public"."most_clicked_roles_recent" USING "btree" ("role_id", "agency");



CREATE UNIQUE INDEX "idx_most_clicked_roles_role_agency" ON "public"."most_clicked_roles" USING "btree" ("role_id", "agency");



CREATE INDEX "idx_notifications_expires_at" ON "public"."notifications" USING "btree" ("expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX "idx_notifications_user_id" ON "public"."notifications" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_onboarding_abandon_scan" ON "public"."onboarding_progress" USING "btree" ("last_active_at") WHERE ("onboarding_completed" = false);



CREATE INDEX "idx_onboarding_progress_updated_step" ON "public"."onboarding_progress" USING "btree" ("updated_at" DESC, "step") WHERE ("soft_deleted" IS NOT TRUE);



CREATE INDEX "idx_opp_signals_date" ON "public"."career_opportunity_signals" USING "btree" ("signal_date" DESC);



CREATE INDEX "idx_opp_signals_role" ON "public"."career_opportunity_signals" USING "btree" ("role_name");



CREATE INDEX "idx_opp_signals_score" ON "public"."career_opportunity_signals" USING "btree" ("opportunity_score" DESC);



CREATE INDEX "idx_opportunity_radar_results_user_computed" ON "public"."opportunity_radar_results" USING "btree" ("user_id", "computed_at" DESC);



CREATE UNIQUE INDEX "idx_payment_logs_subscription_activated" ON "public"."payment_logs" USING "btree" ("subscription_id", "status") WHERE ("status" = 'activated'::"text");



CREATE INDEX "idx_pending_entries_entity_type" ON "public"."pending_entries" USING "btree" ("entity_type", "status");



CREATE UNIQUE INDEX "idx_pending_entries_id" ON "public"."pending_entries" USING "btree" ("id");



CREATE INDEX "idx_pending_entries_live_id" ON "public"."pending_entries" USING "btree" ("live_id") WHERE ("live_id" IS NOT NULL);



CREATE INDEX "idx_pending_entries_status" ON "public"."pending_entries" USING "btree" ("status", "submitted_at" DESC);



CREATE INDEX "idx_pending_entries_status_submitted_at" ON "public"."pending_entries" USING "btree" ("status", "submitted_at" DESC);



CREATE INDEX "idx_pending_entries_submitted_by" ON "public"."pending_entries" USING "btree" ("submitted_by");



CREATE INDEX "idx_pending_entries_submitted_by_status" ON "public"."pending_entries" USING "btree" ("submitted_by", "status");



CREATE INDEX "idx_personalized_recs_cleanup" ON "public"."personalized_recommendations" USING "btree" ("expires_at");



CREATE INDEX "idx_personalized_recs_user" ON "public"."personalized_recommendations" USING "btree" ("user_id", "expires_at" DESC);



CREATE INDEX "idx_personalized_user" ON "public"."personalized_recommendations" USING "btree" ("user_id", "computed_at" DESC);



CREATE INDEX "idx_pi_ai_prompts_name_version" ON "public"."pi_ai_prompts" USING "btree" ("prompt_name", "version");



CREATE INDEX "idx_pi_ai_usage_logs_created_at" ON "public"."pi_ai_usage_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_pi_ai_usage_logs_user_id" ON "public"."pi_ai_usage_logs" USING "btree" ("user_id");



CREATE INDEX "idx_pi_career_datasets_type" ON "public"."pi_career_datasets" USING "btree" ("dataset_type");



CREATE INDEX "idx_pi_career_paths_from_role" ON "public"."pi_career_paths" USING "btree" ("from_role");



CREATE INDEX "idx_pi_career_paths_required_skills" ON "public"."pi_career_paths" USING "gin" ("required_skills");



CREATE INDEX "idx_pi_career_paths_to_role" ON "public"."pi_career_paths" USING "btree" ("to_role");



CREATE INDEX "idx_pi_feature_flags_feature_name" ON "public"."pi_feature_flags" USING "btree" ("feature_name");



CREATE INDEX "idx_pi_skill_taxonomy_parent" ON "public"."pi_skill_taxonomy" USING "btree" ("parent_skill_id");



CREATE INDEX "idx_pi_training_sources_mapped_skill" ON "public"."pi_training_sources" USING "btree" ("mapped_skill");



CREATE INDEX "idx_pipeline_jobs_cleanup" ON "public"."ai_pipeline_jobs" USING "btree" ("expires_at");



CREATE INDEX "idx_pipeline_jobs_event" ON "public"."ai_pipeline_jobs" USING "btree" ("event_type", "status");



CREATE INDEX "idx_pipeline_jobs_status" ON "public"."ai_pipeline_jobs" USING "btree" ("status", "queued_at" DESC);



CREATE INDEX "idx_pipeline_jobs_user" ON "public"."ai_pipeline_jobs" USING "btree" ("user_id", "queued_at" DESC);



CREATE INDEX "idx_pipeline_jobs_user_status" ON "public"."ai_pipeline_jobs" USING "btree" ("user_id", "status", "queued_at" DESC);



CREATE INDEX "idx_profiles_role_promoted_at" ON "public"."profiles" USING "btree" ("role", "promoted_at" DESC);



CREATE INDEX "idx_progress_user_history" ON "public"."career_progress_history" USING "btree" ("user_id", "recorded_at");



CREATE INDEX "idx_progress_user_latest" ON "public"."career_progress_history" USING "btree" ("user_id", "recorded_at" DESC);



CREATE INDEX "idx_qualifications_active_level" ON "public"."qualifications" USING "btree" ("is_active", "level", "name");



CREATE INDEX "idx_ra_ai_model_version" ON "public"."resume_analyses" USING "btree" ("ai_model_version");



CREATE INDEX "idx_ra_cache_hit" ON "public"."resume_analyses" USING "btree" ("cache_hit") WHERE ("cache_hit" = true);



CREATE INDEX "idx_ra_career_roadmap_gin" ON "public"."resume_analyses" USING "gin" ("career_roadmap");



CREATE INDEX "idx_ra_weighted_career_context_gin" ON "public"."resume_analyses" USING "gin" ("weighted_career_context");



CREATE INDEX "idx_rag_context_lookup" ON "public"."copilot_rag_contexts" USING "btree" ("user_id", "conversation_id", "turn_index");



CREATE INDEX "idx_rag_contexts_cleanup" ON "public"."copilot_rag_contexts" USING "btree" ("created_at");



CREATE INDEX "idx_rag_contexts_conversation" ON "public"."copilot_rag_contexts" USING "btree" ("conversation_id", "turn_index");



CREATE INDEX "idx_rag_contexts_user" ON "public"."copilot_rag_contexts" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_required_skills_gin" ON "public"."career_opportunity_signals" USING "gin" ("required_skills");



CREATE INDEX "idx_resume_analyses_breakdown_gin" ON "public"."resume_analyses" USING "gin" ("breakdown");



CREATE INDEX "idx_resume_analyses_created_at" ON "public"."resume_analyses" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_resume_analyses_dimensions_gin" ON "public"."resume_analyses" USING "gin" ("dimensions");



CREATE INDEX "idx_resume_analyses_engine" ON "public"."resume_analyses" USING "btree" ("engine");



CREATE INDEX "idx_resume_analyses_growth_insights_gin" ON "public"."resume_analyses" USING "gin" ("growth_insights");



CREATE INDEX "idx_resume_analyses_market_position_gin" ON "public"."resume_analyses" USING "gin" ("market_position");



CREATE INDEX "idx_resume_analyses_operation_type_created_at" ON "public"."resume_analyses" USING "btree" ("operation_type", "created_at" DESC);



CREATE INDEX "idx_resume_analyses_resume_engine_created" ON "public"."resume_analyses" USING "btree" ("resume_id", "engine", "created_at" DESC);



CREATE INDEX "idx_resume_analyses_resume_id" ON "public"."resume_analyses" USING "btree" ("resume_id");



CREATE INDEX "idx_resume_analyses_user_id" ON "public"."resume_analyses" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_resume_analysis_unique" ON "public"."resume_analyses" USING "btree" ("resume_id", "operation_type", "engine");



CREATE INDEX "idx_resume_growth_user_role_created_desc" ON "public"."resume_growth_signals" USING "btree" ("user_id", "role_id", "created_at" DESC);



CREATE INDEX "idx_resume_scores_user_resume" ON "public"."resume_scores" USING "btree" ("user_id", "resume_id");



CREATE INDEX "idx_resume_scores_user_scored" ON "public"."resume_scores" USING "btree" ("user_id", "scored_at" DESC);



CREATE INDEX "idx_resumes_user_active_created" ON "public"."resumes" USING "btree" ("user_id", "soft_deleted", "created_at" DESC);



CREATE INDEX "idx_resumes_user_active_primary" ON "public"."resumes" USING "btree" ("user_id", "soft_deleted", "is_primary");



CREATE INDEX "idx_resumes_user_created" ON "public"."resumes" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_resumes_user_latest" ON "public"."resumes" USING "btree" ("user_id", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_risk_analysis_results_user_computed" ON "public"."risk_analysis_results" USING "btree" ("user_id", "computed_at" DESC);



CREATE INDEX "idx_risk_analysis_results_user_latest" ON "public"."risk_analysis_results" USING "btree" ("user_id", "computed_at" DESC);



CREATE INDEX "idx_role_aliases_role_id" ON "public"."role_aliases" USING "btree" ("roleId") WHERE ("softDeleted" = false);



CREATE INDEX "idx_role_edu_role_id" ON "public"."role_education" USING "btree" ("role_id");



CREATE UNIQUE INDEX "idx_role_edu_unique" ON "public"."role_education" USING "btree" ("role_id", "education_level");



CREATE UNIQUE INDEX "idx_role_market_demand_role_country" ON "public"."role_market_demand" USING "btree" ("role_id", "country");



CREATE INDEX "idx_role_market_demand_updated_at" ON "public"."role_market_demand" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_role_skills_role_id" ON "public"."role_skills" USING "btree" ("role_id");



CREATE INDEX "idx_role_skills_role_priority" ON "public"."role_skills" USING "btree" ("role_id", "importance_weight");



CREATE INDEX "idx_role_skills_skill" ON "public"."role_skills" USING "btree" ("skill_id");



CREATE INDEX "idx_role_skills_skill_id" ON "public"."role_skills" USING "btree" ("skill_id");



CREATE UNIQUE INDEX "idx_role_skills_unique_typed" ON "public"."role_skills" USING "btree" ("role_id", "skill_id", "skill_type");



CREATE INDEX "idx_role_trans_from" ON "public"."role_transitions" USING "btree" ("from_role_id");



CREATE INDEX "idx_role_trans_to" ON "public"."role_transitions" USING "btree" ("to_role_id");



CREATE UNIQUE INDEX "idx_role_trans_unique" ON "public"."role_transitions" USING "btree" ("from_role_id", "to_role_id");



CREATE INDEX "idx_role_transitions_from_role" ON "public"."role_transitions" USING "btree" ("from_role_id");



CREATE INDEX "idx_role_transitions_to_role" ON "public"."role_transitions" USING "btree" ("to_role_id");



CREATE INDEX "idx_roles_active" ON "public"."roles" USING "btree" ("agency", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_active_only" ON "public"."roles" USING "btree" ("role_id") WHERE ("soft_deleted" IS NOT TRUE);



CREATE INDEX "idx_roles_agency_active" ON "public"."roles" USING "btree" ("agency") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_agency_created" ON "public"."roles" USING "btree" ("agency", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_agency_cursor" ON "public"."roles" USING "btree" ("agency", "created_at" DESC, "role_id" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_agency_family_cursor" ON "public"."roles" USING "btree" ("agency", "role_family", "created_at" DESC, "role_id" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_agency_search" ON "public"."roles" USING "btree" ("agency", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_alt_titles_gin" ON "public"."roles" USING "gin" ("alternative_titles") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_alternative_titles" ON "public"."roles" USING "gin" ("alternative_titles");



CREATE INDEX "idx_roles_created_at" ON "public"."roles" USING "btree" ("created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_created_by" ON "public"."roles" USING "btree" ("created_by") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_embedding" ON "public"."roles" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "idx_roles_family" ON "public"."roles" USING "btree" ("role_family");



CREATE INDEX "idx_roles_family_created" ON "public"."roles" USING "btree" ("role_family", "created_at" DESC) WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_family_level" ON "public"."roles" USING "btree" ("role_family", "seniority_level");



CREATE INDEX "idx_roles_family_seniority" ON "public"."roles" USING "btree" ("role_family", "seniority_level") WHERE ("soft_deleted" IS NOT TRUE);



CREATE INDEX "idx_roles_industry" ON "public"."roles" USING "btree" ("role_family");



CREATE INDEX "idx_roles_job_family_composite" ON "public"."roles" USING "btree" ("role_family", "composite_key") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_job_family_level_track_title" ON "public"."roles" USING "btree" ("job_family_id", "level", "track", "title") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_level" ON "public"."roles" USING "btree" ("seniority_level");



CREATE INDEX "idx_roles_name" ON "public"."roles" USING "btree" ("role_name");



CREATE INDEX "idx_roles_name_pattern" ON "public"."roles" USING "btree" ("role_name" "text_pattern_ops") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "idx_roles_normalized_name" ON "public"."cms_roles" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "idx_roles_normalized_name_agency" ON "public"."roles" USING "btree" ("normalized_name", "agency") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "idx_roles_normalized_name_unique" ON "public"."roles" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_role_family" ON "public"."roles" USING "btree" ("role_family") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "idx_roles_role_id_unique" ON "public"."roles" USING "btree" ("role_id");



CREATE INDEX "idx_roles_role_name_lower" ON "public"."roles" USING "btree" ("agency", "lower"("role_name") "text_pattern_ops") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_role_name_trgm" ON "public"."roles" USING "gin" ("role_name" "public"."gin_trgm_ops") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_search_vector" ON "public"."roles" USING "gin" ("search_vector") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_search_vector_gin" ON "public"."roles" USING "gin" ("search_vector") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_roles_seniority" ON "public"."roles" USING "btree" ("seniority_level");



CREATE UNIQUE INDEX "idx_roles_unique_name_agency" ON "public"."roles" USING "btree" ("lower"("role_name"), "agency") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_rotation_log_secret_rotated" ON "public"."secrets_rotation_log" USING "btree" ("secret_name", "rotated_at" DESC);



CREATE INDEX "idx_salary_bands_region_updated" ON "public"."salary_bands" USING "btree" ("lower"("role_id"), "experience_band", "region", "updated_at" DESC) WHERE (("soft_deleted" = false) OR ("soft_deleted" IS NULL));



CREATE INDEX "idx_salary_bands_role_level" ON "public"."salary_bands" USING "btree" ("lower"("role_id"), "experience_band") WHERE (("soft_deleted" = false) OR ("soft_deleted" IS NULL));



CREATE INDEX "idx_salary_bands_role_level_updated" ON "public"."salary_bands" USING "btree" ("lower"("role_id"), "experience_band", "updated_at" DESC) WHERE (("soft_deleted" = false) OR ("soft_deleted" IS NULL));



CREATE INDEX "idx_salary_country" ON "public"."role_salary_market" USING "btree" ("country");



CREATE INDEX "idx_salary_data_role_filters" ON "public"."salary_data" USING "btree" ("role_id", "location", "experience_level", "industry") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_salary_data_source_type_active" ON "public"."salary_data" USING "btree" ("source_type") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_salary_role_id" ON "public"."role_salary_market" USING "btree" ("role_id");



CREATE UNIQUE INDEX "idx_salary_unique" ON "public"."role_salary_market" USING "btree" ("role_id", "country");



CREATE INDEX "idx_search_events_agency" ON "public"."search_events" USING "btree" ("agency");



CREATE INDEX "idx_search_events_agency_created" ON "public"."search_events" USING "btree" ("agency", "created_at" DESC);



CREATE INDEX "idx_search_events_clicks" ON "public"."search_events" USING "btree" ("agency", "role_id", "created_at" DESC) WHERE ("event_type" = 'click'::"text");



CREATE INDEX "idx_search_events_created_at" ON "public"."search_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_search_events_event_type" ON "public"."search_events" USING "btree" ("event_type");



CREATE INDEX "idx_search_events_normalized_query" ON "public"."search_events" USING "btree" ("normalized_query");



CREATE INDEX "idx_search_events_role_id" ON "public"."search_events" USING "btree" ("role_id") WHERE ("role_id" IS NOT NULL);



CREATE INDEX "idx_search_events_type_query" ON "public"."search_events" USING "btree" ("event_type", "normalized_query");



CREATE INDEX "idx_semantic_match_expiry" ON "public"."semantic_match_cache" USING "btree" ("expires_at");



CREATE INDEX "idx_semantic_match_lookup" ON "public"."semantic_match_cache" USING "btree" ("user_id", "job_id");



CREATE INDEX "idx_skill_clusters_domain_active" ON "public"."cms_skill_clusters" USING "btree" ("domain_id", "status") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_skill_demand_skill" ON "public"."skill_demand" USING "btree" ("skill");



CREATE INDEX "idx_skill_demand_user_recent" ON "public"."skill_demand_analyses" USING "btree" ("user_id", "analyzed_at" DESC);

ALTER TABLE "public"."skill_demand_analyses" CLUSTER ON "idx_skill_demand_user_recent";



CREATE INDEX "idx_skill_embeddings_vector" ON "public"."skill_embeddings" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "idx_skill_keywords_active" ON "public"."skill_keywords" USING "btree" ("is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_skill_keywords_category" ON "public"."skill_keywords" USING "btree" ("category");



CREATE INDEX "idx_skill_relationships_related" ON "public"."skill_relationships" USING "btree" ("related_skill_id");



CREATE INDEX "idx_skill_relationships_skill" ON "public"."skill_relationships" USING "btree" ("skill_id");



CREATE INDEX "idx_skill_rels_skill_id" ON "public"."skill_relationships" USING "btree" ("skill_id");



CREATE UNIQUE INDEX "idx_skill_rels_unique" ON "public"."skill_relationships" USING "btree" ("skill_id", "related_skill_id");



CREATE INDEX "idx_skills_category" ON "public"."skills" USING "btree" ("skill_category");



CREATE UNIQUE INDEX "idx_skills_normalized_name" ON "public"."skills" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "idx_skills_normalized_name_unique" ON "public"."cms_skills" USING "btree" ("normalized_name");



CREATE UNIQUE INDEX "idx_skills_skill_id_unique" ON "public"."skills" USING "btree" ("skill_id");



CREATE INDEX "idx_student_career_profiles_career_curiosities_gin" ON "public"."student_career_profiles" USING "gin" ("career_curiosities") WHERE ("career_curiosities" IS NOT NULL);



CREATE INDEX "idx_student_career_profiles_interests_gin" ON "public"."student_career_profiles" USING "gin" ("interests") WHERE ("interests" IS NOT NULL);



CREATE INDEX "idx_student_career_profiles_user_id" ON "public"."student_career_profiles" USING "btree" ("user_id");



CREATE INDEX "idx_student_onboarding_drafts_user_id" ON "public"."student_onboarding_drafts" USING "btree" ("user_id");



CREATE INDEX "idx_sub_events_user_id" ON "public"."subscription_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_subscription_credit_plans_is_active" ON "public"."subscription_credit_plans" USING "btree" ("is_active");



CREATE INDEX "idx_subscription_credit_plans_plan_amount_inr" ON "public"."subscription_credit_plans" USING "btree" ("plan_amount_inr");



CREATE UNIQUE INDEX "idx_subscription_events_idempotency_key" ON "public"."subscription_events" USING "btree" ("idempotency_key");



CREATE INDEX "idx_subscriptions_status" ON "public"."subscriptions" USING "btree" ("status", "expires_at");



CREATE INDEX "idx_subscriptions_user_id" ON "public"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "idx_sync_locks_active" ON "public"."sync_locks" USING "btree" ("locked_at" DESC NULLS LAST) WHERE ("released_at" IS NULL);



CREATE INDEX "idx_sync_locks_active_expiry" ON "public"."sync_locks" USING "btree" ("expires_at") WHERE (("released_at" IS NULL) AND ("expires_at" IS NOT NULL));



CREATE INDEX "idx_sync_locks_locked_at_desc" ON "public"."sync_locks" USING "btree" ("locked_at" DESC NULLS LAST);



CREATE INDEX "idx_sync_locks_status" ON "public"."sync_locks" USING "btree" ("status");



CREATE INDEX "idx_sync_logs_created_at_desc" ON "public"."sync_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sync_logs_failures" ON "public"."sync_logs" USING "btree" ("created_at" DESC) WHERE ("fail_count" > 0);



CREATE INDEX "idx_sync_logs_source_created" ON "public"."sync_logs" USING "btree" ("source_type", "created_at" DESC);



CREATE INDEX "idx_sync_logs_source_type_created_at" ON "public"."sync_logs" USING "btree" ("source_type", "created_at" DESC);



CREATE UNIQUE INDEX "idx_top_searches_agency_query" ON "public"."top_searches" USING "btree" ("agency", "normalized_query");



CREATE INDEX "idx_uni_programs_university_id" ON "public"."uni_programs" USING "btree" ("university_id");



CREATE INDEX "idx_uni_student_matches_program_id" ON "public"."uni_student_matches" USING "btree" ("program_id");



CREATE INDEX "idx_uni_student_matches_student_id" ON "public"."uni_student_matches" USING "btree" ("student_id");



CREATE INDEX "idx_uni_university_users_university_id" ON "public"."uni_university_users" USING "btree" ("university_id");



CREATE INDEX "idx_uni_university_users_user_id" ON "public"."uni_university_users" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_unique_normalized_name" ON "public"."cms_skills" USING "btree" ("normalized_name") WHERE ("soft_deleted" = false);



CREATE INDEX "idx_ur_role" ON "public"."user_roles" USING "btree" ("role");



CREATE INDEX "idx_ur_user_id" ON "public"."user_roles" USING "btree" ("user_id");



CREATE INDEX "idx_usage_logs_created_at" ON "public"."usage_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_usage_logs_feature" ON "public"."usage_logs" USING "btree" ("feature", "created_at" DESC);



CREATE INDEX "idx_usage_logs_user_created" ON "public"."usage_logs" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_usage_logs_user_date" ON "public"."usage_logs" USING "btree" ("user_id", "created_at");



CREATE INDEX "idx_usage_logs_user_id" ON "public"."usage_logs" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_user_fcm_tokens_user_id" ON "public"."user_fcm_tokens" USING "btree" ("user_id");



CREATE INDEX "idx_user_profiles_id_covering" ON "public"."user_profiles" USING "btree" ("id") INCLUDE ("display_name", "photo_url", "onboarding_completed");



CREATE INDEX "idx_user_profiles_student_profile_gin" ON "public"."user_profiles" USING "gin" ("student_profile") WHERE ("student_profile" IS NOT NULL);



CREATE INDEX "idx_user_profiles_updated_at" ON "public"."user_profiles" USING "btree" ("updated_at" DESC) WHERE ("soft_deleted" IS NOT TRUE);



CREATE INDEX "idx_user_profiles_user_id" ON "public"."user_profiles" USING "btree" ("user_id");



CREATE INDEX "idx_user_quota_lookup" ON "public"."user_quota" USING "btree" ("user_id", "month_key", "feature");



CREATE INDEX "idx_user_vector" ON "public"."user_vectors" USING "ivfflat" ("embedding_vector" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "idx_user_vectors_embedding" ON "public"."user_vectors" USING "ivfflat" ("embedding_vector" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "idx_users_contributor_created_at" ON "public"."users" USING "btree" ("created_at" DESC) WHERE ("role" = 'contributor'::"text");



CREATE INDEX "idx_users_id" ON "public"."users" USING "btree" ("id");



CREATE INDEX "idx_users_user_type" ON "public"."users" USING "btree" ("user_type");



CREATE INDEX "job_cache_expires_idx" ON "public"."job_listings_cache" USING "btree" ("expires_at");



CREATE INDEX "job_cache_user_key_idx" ON "public"."job_listings_cache" USING "btree" ("user_id", "cache_key");



CREATE UNIQUE INDEX "jobs_external_source_uq" ON "public"."jobs" USING "btree" ("external_id", "source") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "jobs_fetched_at_idx" ON "public"."jobs" USING "btree" ("fetched_at" DESC);



CREATE INDEX "jobs_source_idx" ON "public"."jobs" USING "btree" ("source");



CREATE INDEX "jobs_title_idx" ON "public"."jobs" USING "btree" ("title");



CREATE INDEX "notification_jobs_scheduled_idx" ON "public"."notification_jobs" USING "btree" ("scheduled_at");



CREATE INDEX "notification_jobs_status_idx" ON "public"."notification_jobs" USING "btree" ("status");



CREATE INDEX "notification_jobs_user_id_idx" ON "public"."notification_jobs" USING "btree" ("user_id");



CREATE UNIQUE INDEX "professional_career_profiles_user_id_idx" ON "public"."professional_career_profiles" USING "btree" ("user_id");



CREATE INDEX "resume_exports_user_id_idx" ON "public"."resume_exports" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "resume_scores_resume_id_idx" ON "public"."resume_scores" USING "btree" ("resume_id");



CREATE INDEX "resume_scores_scored_at_idx" ON "public"."resume_scores" USING "btree" ("scored_at" DESC);



CREATE INDEX "resume_scores_user_id_idx" ON "public"."resume_scores" USING "btree" ("user_id");



CREATE INDEX "resume_versions_resume_id_idx" ON "public"."resume_versions" USING "btree" ("resume_id", "version_number" DESC);



CREATE INDEX "resume_versions_user_id_idx" ON "public"."resume_versions" USING "btree" ("user_id");



CREATE INDEX "resumes_created_at_idx" ON "public"."resumes" USING "btree" ("created_at" DESC);



CREATE INDEX "resumes_user_id_idx" ON "public"."resumes" USING "btree" ("user_id");



CREATE INDEX "resumes_user_primary_idx" ON "public"."resumes" USING "btree" ("user_id", "is_primary") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "resumes_user_primary_uq" ON "public"."resumes" USING "btree" ("user_id", "is_primary") WHERE (("is_primary" = true) AND ("soft_deleted" = false));



CREATE INDEX "salary_bands_role_id_idx" ON "public"."salary_bands" USING "btree" ("role_id");



CREATE INDEX "skill_demand_analyses_analyzed_at_idx" ON "public"."skill_demand_analyses" USING "btree" ("user_id", "analyzed_at" DESC);



CREATE INDEX "skill_demand_analyses_user_id_idx" ON "public"."skill_demand_analyses" USING "btree" ("user_id");



CREATE UNIQUE INDEX "student_career_profiles_user_id_idx" ON "public"."student_career_profiles" USING "btree" ("user_id");



CREATE UNIQUE INDEX "student_onboarding_drafts_user_id_idx" ON "public"."student_onboarding_drafts" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_career_advice_results_user_id" ON "public"."career_advice_results" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_career_health_results_user_id" ON "public"."career_health_results" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_career_predictions_student_career" ON "public"."lmi_career_predictions" USING "btree" ("student_id", "career_name");



CREATE UNIQUE INDEX "uq_career_simulations_student_career" ON "public"."edu_career_simulations" USING "btree" ("student_id", "career_name");



CREATE UNIQUE INDEX "uq_education_roi_student_path" ON "public"."edu_education_roi" USING "btree" ("student_id", "education_path");



CREATE UNIQUE INDEX "uq_ingestion_runs_run_id" ON "public"."lmi_ingestion_runs" USING "btree" ("run_id");



CREATE UNIQUE INDEX "uq_job_match_results_user_id" ON "public"."job_match_results" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_opportunity_radar_results_user_id" ON "public"."opportunity_radar_results" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_ra_resume_engine_hash" ON "public"."resume_analyses" USING "btree" ("resume_id", "analysis_hash", "engine") WHERE ("analysis_hash" IS NOT NULL);



CREATE UNIQUE INDEX "uq_risk_analysis_results_user_id" ON "public"."risk_analysis_results" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_role_aliases_normalized_active" ON "public"."role_aliases" USING "btree" ("normalizedAlias") WHERE ("softDeleted" = false);



CREATE UNIQUE INDEX "uq_roles_composite_key" ON "public"."roles" USING "btree" ("composite_key") WHERE ("soft_deleted" = false);



CREATE UNIQUE INDEX "uq_salary_data_dedupe_key" ON "public"."salary_data" USING "btree" ("dedupe_key");



CREATE INDEX "user_activity_events_user_id_idx" ON "public"."user_activity_events" USING "btree" ("user_id");



CREATE INDEX "users_email_idx" ON "public"."users" USING "btree" ("email");



CREATE INDEX "users_onboarding_idx" ON "public"."users" USING "btree" ("id", "onboarding_completed");



CREATE INDEX "users_role_idx" ON "public"."users" USING "btree" ("role");



CREATE INDEX "users_user_type_idx" ON "public"."users" USING "btree" ("user_type");



ALTER INDEX "public"."ai_observability_logs_pkey1" ATTACH PARTITION "public"."ai_observability_logs_2025_q1_pkey";



ALTER INDEX "public"."ai_observability_logs_pkey1" ATTACH PARTITION "public"."ai_observability_logs_2025_q2_pkey";



ALTER INDEX "public"."ai_observability_logs_pkey1" ATTACH PARTITION "public"."ai_observability_logs_2025_q3_pkey";



ALTER INDEX "public"."ai_observability_logs_pkey1" ATTACH PARTITION "public"."ai_observability_logs_2025_q4_pkey";



ALTER INDEX "public"."ai_observability_logs_pkey1" ATTACH PARTITION "public"."ai_observability_logs_2026_q1_pkey";



ALTER INDEX "public"."ai_observability_logs_pkey1" ATTACH PARTITION "public"."ai_observability_logs_2026_q2_pkey";



CREATE OR REPLACE TRIGGER "resumes_updated_at" BEFORE UPDATE ON "public"."resumes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "roles_search_vector_update" BEFORE INSERT OR UPDATE ON "public"."roles" FOR EACH ROW EXECUTE FUNCTION "public"."roles_search_vector_trigger"();



CREATE OR REPLACE TRIGGER "set_admin_principals_updated_at" BEFORE UPDATE ON "public"."admin_principals" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_career_advice_updated_at" BEFORE UPDATE ON "public"."career_advice_results" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_career_health_updated_at" BEFORE UPDATE ON "public"."career_health_results" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_cms_education_levels_updated_at" BEFORE UPDATE ON "public"."cms_education_levels" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_cms_job_families_updated_at" BEFORE UPDATE ON "public"."cms_job_families" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_cms_roles_updated_at" BEFORE UPDATE ON "public"."cms_roles" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_cms_salary_benchmarks_updated_at" BEFORE UPDATE ON "public"."cms_salary_benchmarks" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_cms_skills_updated_at" BEFORE UPDATE ON "public"."cms_skills" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_job_match_updated_at" BEFORE UPDATE ON "public"."job_match_results" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_opp_radar_updated_at" BEFORE UPDATE ON "public"."opportunity_radar_results" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_opp_signals_updated_at" BEFORE UPDATE ON "public"."career_opportunity_signals" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_pending_entries_updated_at" BEFORE UPDATE ON "public"."pending_entries" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_personalization_profile_updated_at" BEFORE UPDATE ON "public"."user_personalization_profile" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_risk_analysis_updated_at" BEFORE UPDATE ON "public"."risk_analysis_results" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ai_cost_daily_usage_updated_at" BEFORE UPDATE ON "public"."ai_cost_daily_usage" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_career_roles_search_vector" BEFORE INSERT OR UPDATE ON "public"."career_roles" FOR EACH ROW EXECUTE FUNCTION "public"."trg_fn_career_roles_search_vector"();



CREATE OR REPLACE TRIGGER "trg_career_skills_search_vector" BEFORE INSERT OR UPDATE ON "public"."career_skills_registry" FOR EACH ROW EXECUTE FUNCTION "public"."trg_fn_career_skills_search_vector"();



CREATE OR REPLACE TRIGGER "trg_edu_cognitive_results_updated_at" BEFORE UPDATE ON "public"."edu_cognitive_results" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_edu_stream_scores_updated_at" BEFORE UPDATE ON "public"."edu_stream_scores" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_edu_students_updated_at" BEFORE UPDATE ON "public"."edu_students" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_emp_employer_users_updated_at" BEFORE UPDATE ON "public"."emp_employer_users" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_emp_employers_updated_at" BEFORE UPDATE ON "public"."emp_employers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_emp_job_roles_updated_at" BEFORE UPDATE ON "public"."emp_job_roles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_emp_talent_signals_updated_at" BEFORE UPDATE ON "public"."emp_talent_signals" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_external_salary_apis_updated_at" BEFORE UPDATE ON "public"."external_salary_apis" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_lmi_career_scores_updated_at" BEFORE UPDATE ON "public"."lmi_career_market_scores" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_ai_model_settings_updated_at" BEFORE UPDATE ON "public"."pi_ai_model_settings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_ai_prompts_updated_at" BEFORE UPDATE ON "public"."pi_ai_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_career_datasets_updated_at" BEFORE UPDATE ON "public"."pi_career_datasets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_career_paths_updated_at" BEFORE UPDATE ON "public"."pi_career_paths" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_chi_weights_updated_at" BEFORE UPDATE ON "public"."pi_chi_weights" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_feature_flags_updated_at" BEFORE UPDATE ON "public"."pi_feature_flags" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_market_data_sources_updated_at" BEFORE UPDATE ON "public"."pi_market_data_sources" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_skill_taxonomy_updated_at" BEFORE UPDATE ON "public"."pi_skill_taxonomy" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_subscription_plans_updated_at" BEFORE UPDATE ON "public"."pi_subscription_plans" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pi_training_sources_updated_at" BEFORE UPDATE ON "public"."pi_training_sources" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_qualifications_updated_at" BEFORE UPDATE ON "public"."qualifications" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_resume_analyses_updated_at" BEFORE UPDATE ON "public"."resume_analyses" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sch_schools_updated_at" BEFORE UPDATE ON "public"."sch_schools" FOR EACH ROW EXECUTE FUNCTION "public"."sch_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_skill_recommendations_updated_at" BEFORE UPDATE ON "public"."edu_skill_recommendations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_student_career_profiles_updated_at" BEFORE UPDATE ON "public"."student_career_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_student_onboarding_drafts_updated_at" BEFORE UPDATE ON "public"."student_onboarding_drafts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_student_skills_updated_at" BEFORE UPDATE ON "public"."edu_student_skills" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sync_locks_updated_at" BEFORE UPDATE ON "public"."sync_locks" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_uni_programs_updated_at" BEFORE UPDATE ON "public"."uni_programs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_uni_universities_updated_at" BEFORE UPDATE ON "public"."uni_universities" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_user_profiles_updated_at" BEFORE UPDATE ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trig_roles_search_vector" BEFORE INSERT OR UPDATE ON "public"."roles" FOR EACH ROW EXECUTE FUNCTION "public"."roles_search_vector_update"();



CREATE OR REPLACE TRIGGER "trig_roles_updated_at" BEFORE UPDATE ON "public"."roles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "users_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."ats_scores"
    ADD CONSTRAINT "ats_scores_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."career_advice_results"
    ADD CONSTRAINT "career_advice_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_pipeline_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."career_health_results"
    ADD CONSTRAINT "career_health_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_pipeline_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."career_metrics"
    ADD CONSTRAINT "career_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."career_role_skills"
    ADD CONSTRAINT "career_role_skills_role_fk" FOREIGN KEY ("role_id") REFERENCES "public"."career_roles"("role_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."career_role_skills"
    ADD CONSTRAINT "career_role_skills_skill_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."career_skills_registry"("skill_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."career_role_transitions"
    ADD CONSTRAINT "career_role_transitions_from_fk" FOREIGN KEY ("from_role_id") REFERENCES "public"."career_roles"("role_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."career_role_transitions"
    ADD CONSTRAINT "career_role_transitions_to_fk" FOREIGN KEY ("to_role_id") REFERENCES "public"."career_roles"("role_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."certifications"
    ADD CONSTRAINT "certifications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."certifications"
    ADD CONSTRAINT "certifications_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."copilot_conversations"
    ADD CONSTRAINT "copilot_conversations_rag_context_id_fkey" FOREIGN KEY ("rag_context_id") REFERENCES "public"."copilot_rag_contexts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."edu_career_conversations"
    ADD CONSTRAINT "edu_career_conversations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edu_cognitive_results"
    ADD CONSTRAINT "edu_cognitive_results_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."edu_students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edu_skill_recommendations"
    ADD CONSTRAINT "edu_skill_recommendations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edu_stream_scores"
    ADD CONSTRAINT "edu_stream_scores_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."edu_students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edu_student_skills"
    ADD CONSTRAINT "edu_student_skills_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edu_students"
    ADD CONSTRAINT "edu_students_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emp_employer_users"
    ADD CONSTRAINT "emp_employer_users_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "public"."emp_employers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emp_job_roles"
    ADD CONSTRAINT "emp_job_roles_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "public"."emp_employers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emp_talent_signals"
    ADD CONSTRAINT "emp_talent_signals_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "public"."emp_employers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emp_talent_signals"
    ADD CONSTRAINT "emp_talent_signals_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "public"."emp_job_roles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emp_employer_users"
    ADD CONSTRAINT "fk_emp_employer_users_employer" FOREIGN KEY ("employer_id") REFERENCES "public"."emp_employers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "fk_roles_job_family" FOREIGN KEY ("job_family_id") REFERENCES "public"."job_families"("id");



ALTER TABLE ONLY "public"."job_match_results"
    ADD CONSTRAINT "job_match_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_pipeline_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."opportunity_radar_results"
    ADD CONSTRAINT "opportunity_radar_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_pipeline_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pi_skill_taxonomy"
    ADD CONSTRAINT "pi_skill_taxonomy_parent_skill_id_fkey" FOREIGN KEY ("parent_skill_id") REFERENCES "public"."pi_skill_taxonomy"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."resume_exports"
    ADD CONSTRAINT "resume_exports_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."resume_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."resume_scores"
    ADD CONSTRAINT "resume_scores_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."risk_analysis_results"
    ADD CONSTRAINT "risk_analysis_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_pipeline_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sch_school_students"
    ADD CONSTRAINT "sch_school_students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."sch_schools"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sch_school_users"
    ADD CONSTRAINT "sch_school_users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."sch_schools"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."uni_programs"
    ADD CONSTRAINT "uni_programs_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "public"."uni_universities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."uni_student_matches"
    ADD CONSTRAINT "uni_student_matches_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."uni_programs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."uni_university_users"
    ADD CONSTRAINT "uni_university_users_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "public"."uni_universities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can do anything" ON "public"."users" USING ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND (("u"."role" = 'admin'::"text") OR ("u"."role" = 'super_admin'::"text"))))));



CREATE POLICY "Service only sync locks" ON "public"."sync_locks" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "User onboarding access" ON "public"."onboarding_progress" TO "authenticated" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "User recommendations access" ON "public"."personalized_recommendations" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "User resumes access" ON "public"."resumes" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "Users can access own profile" ON "public"."profiles" USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can access their own data" ON "public"."users" USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert own data" ON "public"."users" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert own events" ON "public"."activity_events" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can manage own job applications" ON "public"."job_applications" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read own data" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can read own events" ON "public"."activity_events" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own data" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."activity_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."activity_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."adaptive_weights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_principals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admins_full_access_credit_operations" ON "public"."credit_operation_costs" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admins_full_access_credit_plans" ON "public"."subscription_credit_plans" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admins_manage_keywords" ON "public"."skill_keywords" TO "authenticated" USING (((("auth"."jwt"() -> 'app_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins_read_all_analyses" ON "public"."resume_analyses" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."user_id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



CREATE POLICY "admins_read_all_cvs" ON "public"."generated_cvs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."user_id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



CREATE POLICY "admins_read_all_usage" ON "public"."ai_cost_daily_usage" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."user_id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



ALTER TABLE "public"."ai_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_cost_daily_usage" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_cost_tracking" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_daily_costs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs_2025_q1" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs_2025_q2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs_2025_q3" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs_2025_q4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs_2026_q1" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_observability_logs_2026_q2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_pipeline_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_usage_self" ON "public"."ai_usage" USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "all_users_read_active_keywords" ON "public"."skill_keywords" FOR SELECT TO "authenticated" USING (("is_active" = true));



ALTER TABLE "public"."ats_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ats_scores_self" ON "public"."ats_scores" USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."automation_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ava_memory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_advice_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_advice_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_health_index" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_health_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_insights" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "career_insights_self" ON "public"."career_insights" USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."career_metrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "career_metrics_delete_own" ON "public"."career_metrics" FOR DELETE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "career_metrics_insert_own" ON "public"."career_metrics" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "career_metrics_select_own" ON "public"."career_metrics" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "career_metrics_update_own" ON "public"."career_metrics" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."career_opportunity_signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_paths" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_progress_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_readiness_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_role_skills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_role_transitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_simulations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."career_skills_registry" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."certifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."change_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chi_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_career_domains" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_education_levels" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_job_families" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_salary_benchmarks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_skill_clusters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cms_skills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consent_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversion_aggregates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversion_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_grounding_failures" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_rag_contexts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."courses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."credit_operation_costs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_career_insights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_metric_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drafts_delete_own" ON "public"."student_onboarding_drafts" FOR DELETE USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "drafts_insert_own" ON "public"."student_onboarding_drafts" FOR INSERT WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "drafts_select_own" ON "public"."student_onboarding_drafts" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "drafts_update_own" ON "public"."student_onboarding_drafts" FOR UPDATE USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."edu_academic_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_career_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_career_predictions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edu_career_predictions_delete" ON "public"."edu_career_predictions" FOR DELETE TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_career_predictions_insert" ON "public"."edu_career_predictions" FOR INSERT TO "authenticated" WITH CHECK (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_career_predictions_select" ON "public"."edu_career_predictions" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_career_predictions_update" ON "public"."edu_career_predictions" FOR UPDATE TO "authenticated" USING (("student_id" = "auth"."uid"())) WITH CHECK (("student_id" = "auth"."uid"()));



ALTER TABLE "public"."edu_career_simulations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_cognitive_results" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edu_cognitive_results_delete" ON "public"."edu_cognitive_results" FOR DELETE TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_cognitive_results_insert" ON "public"."edu_cognitive_results" FOR INSERT TO "authenticated" WITH CHECK (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_cognitive_results_select" ON "public"."edu_cognitive_results" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_cognitive_results_update" ON "public"."edu_cognitive_results" FOR UPDATE TO "authenticated" USING (("student_id" = "auth"."uid"())) WITH CHECK (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_conversations_delete_own" ON "public"."edu_career_conversations" FOR DELETE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "student_id"));



CREATE POLICY "edu_conversations_insert_own" ON "public"."edu_career_conversations" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "student_id"));



CREATE POLICY "edu_conversations_select_own" ON "public"."edu_career_conversations" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "student_id"));



CREATE POLICY "edu_conversations_update_own" ON "public"."edu_career_conversations" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "student_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "student_id"));



ALTER TABLE "public"."edu_education_roi" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_extracurricular" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_skill_recommendations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_stream_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edu_stream_scores_delete" ON "public"."edu_stream_scores" FOR DELETE TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_stream_scores_insert" ON "public"."edu_stream_scores" FOR INSERT TO "authenticated" WITH CHECK (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_stream_scores_select" ON "public"."edu_stream_scores" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "edu_stream_scores_update" ON "public"."edu_stream_scores" FOR UPDATE TO "authenticated" USING (("student_id" = "auth"."uid"())) WITH CHECK (("student_id" = "auth"."uid"()));



ALTER TABLE "public"."edu_student_skills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."edu_students" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edu_students_delete" ON "public"."edu_students" FOR DELETE TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "edu_students_insert" ON "public"."edu_students" FOR INSERT TO "authenticated" WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "edu_students_select" ON "public"."edu_students" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "edu_students_update" ON "public"."edu_students" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."emp_employer_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emp_employer_users_member_select" ON "public"."emp_employer_users" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."emp_employer_users" "eu"
  WHERE (("eu"."employer_id" = "emp_employer_users"."employer_id") AND ("eu"."user_id" = ("auth"."uid"())::"text")))));



CREATE POLICY "emp_employer_users_owner_insert" ON "public"."emp_employer_users" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."emp_employers" "e"
  WHERE (("e"."id" = "emp_employer_users"."employer_id") AND ("e"."created_by" = ("auth"."uid"())::"text")))));



CREATE POLICY "emp_employer_users_owner_or_self_delete" ON "public"."emp_employer_users" FOR DELETE USING ((("user_id" = ("auth"."uid"())::"text") OR (EXISTS ( SELECT 1
   FROM "public"."emp_employers" "e"
  WHERE (("e"."id" = "emp_employer_users"."employer_id") AND ("e"."created_by" = ("auth"."uid"())::"text"))))));



CREATE POLICY "emp_employer_users_owner_update" ON "public"."emp_employer_users" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."emp_employers" "e"
  WHERE (("e"."id" = "emp_employer_users"."employer_id") AND ("e"."created_by" = ("auth"."uid"())::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."emp_employers" "e"
  WHERE (("e"."id" = "emp_employer_users"."employer_id") AND ("e"."created_by" = ("auth"."uid"())::"text")))));



CREATE POLICY "emp_employer_users_service_role_full_access" ON "public"."emp_employer_users" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."emp_employers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emp_employers_owner_delete" ON "public"."emp_employers" FOR DELETE USING (("created_by" = ("auth"."uid"())::"text"));



CREATE POLICY "emp_employers_owner_insert" ON "public"."emp_employers" FOR INSERT WITH CHECK (("created_by" = ("auth"."uid"())::"text"));



CREATE POLICY "emp_employers_owner_select" ON "public"."emp_employers" FOR SELECT USING (("created_by" = ("auth"."uid"())::"text"));



CREATE POLICY "emp_employers_owner_update" ON "public"."emp_employers" FOR UPDATE USING (("created_by" = ("auth"."uid"())::"text")) WITH CHECK (("created_by" = ("auth"."uid"())::"text"));



CREATE POLICY "emp_employers_service_role_full_access" ON "public"."emp_employers" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."emp_job_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emp_job_roles_member_all" ON "public"."emp_job_roles" USING ((EXISTS ( SELECT 1
   FROM "public"."emp_employer_users" "eu"
  WHERE (("eu"."employer_id" = "emp_job_roles"."employer_id") AND ("eu"."user_id" = ("auth"."uid"())::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."emp_employer_users" "eu"
  WHERE (("eu"."employer_id" = "emp_job_roles"."employer_id") AND ("eu"."user_id" = ("auth"."uid"())::"text")))));



CREATE POLICY "emp_job_roles_public_read_active" ON "public"."emp_job_roles" FOR SELECT USING (("active" = true));



CREATE POLICY "emp_job_roles_service_role_full_access" ON "public"."emp_job_roles" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."emp_talent_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emp_talent_signals_candidate_read" ON "public"."emp_talent_signals" FOR SELECT USING (("student_id" = ("auth"."uid"())::"text"));



CREATE POLICY "emp_talent_signals_member_all" ON "public"."emp_talent_signals" USING ((EXISTS ( SELECT 1
   FROM "public"."emp_employer_users" "eu"
  WHERE (("eu"."employer_id" = "emp_talent_signals"."employer_id") AND ("eu"."user_id" = ("auth"."uid"())::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."emp_employer_users" "eu"
  WHERE (("eu"."employer_id" = "emp_talent_signals"."employer_id") AND ("eu"."user_id" = ("auth"."uid"())::"text")))));



CREATE POLICY "emp_talent_signals_service_role_full_access" ON "public"."emp_talent_signals" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."event_outbox" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."external_salary_apis" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gcid_aggregated_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gcid_analytics_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."generated_cvs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_check" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ik_delete_own" ON "public"."idempotency_keys" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "ik_insert_own" ON "public"."idempotency_keys" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "ik_select_own" ON "public"."idempotency_keys" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "ik_update_own" ON "public"."idempotency_keys" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."import_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jd_analysis_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_applications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_cache_self" ON "public"."job_listings_cache" USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."job_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_families" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_listings_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_match_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "jobs_read" ON "public"."jobs" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."learning_paths_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."learning_resources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lmi_career_market_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lmi_career_predictions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lmi_ingestion_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lmi_job_market_data" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."market_intelligence_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."market_intelligence_sync" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."metrics_daily_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_delivery" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."onboarding_progress" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."opportunity_radar_results" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "own_advice_results" ON "public"."career_advice_results" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_behavior_events" ON "public"."user_behavior_events" USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_copilot_convos" ON "public"."copilot_conversations" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_grounding_failures" ON "public"."copilot_grounding_failures" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_health_results" ON "public"."career_health_results" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_match_results" ON "public"."job_match_results" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_personalization_profile" ON "public"."user_personalization_profile" USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_pipeline_jobs" ON "public"."ai_pipeline_jobs" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_radar_results" ON "public"."opportunity_radar_results" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_rag_contexts" ON "public"."copilot_rag_contexts" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "own_risk_results" ON "public"."risk_analysis_results" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."payment_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personalized_recommendations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_ai_model_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_ai_prompts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_ai_usage_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_career_datasets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_career_paths" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_chi_weights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_feature_flags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_market_data_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_skill_taxonomy" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_subscription_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pi_training_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."professional_career_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "professional_profiles_select_own" ON "public"."professional_career_profiles" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_read_signals" ON "public"."career_opportunity_signals" FOR SELECT USING (true);



ALTER TABLE "public"."qualifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resume_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resume_exports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resume_growth_signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resume_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "resume_scores_self" ON "public"."resume_scores" USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."resume_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resumes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "resumes_self" ON "public"."resumes" USING (("user_id" = ("auth"."uid"())::"text")) WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."risk_analysis_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_aliases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_education" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_market_data" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_market_demand" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_salary_market" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_skills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_transitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "roles_delete" ON "public"."roles" FOR DELETE TO "authenticated" USING (("created_by" = ("auth"."uid"())::"text"));



CREATE POLICY "roles_insert" ON "public"."roles" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = ("auth"."uid"())::"text"));



CREATE POLICY "roles_select" ON "public"."roles" FOR SELECT TO "authenticated" USING (("soft_deleted" = false));



CREATE POLICY "roles_update" ON "public"."roles" FOR UPDATE TO "authenticated" USING (("created_by" = ("auth"."uid"())::"text")) WITH CHECK (("created_by" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."salary_bands" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."salary_data" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sch_school_students" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sch_school_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sch_schools" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."search_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "search_events_insert" ON "public"."search_events" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "search_events_select" ON "public"."search_events" FOR SELECT TO "authenticated" USING (("agency" = ("auth"."jwt"() ->> 'agency'::"text")));



CREATE POLICY "search_events_service_role" ON "public"."search_events" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."secrets_rotation_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."semantic_match_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service role full access" ON "public"."conversion_aggregates" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role full access" ON "public"."ai_cost_tracking" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role full access" ON "public"."change_logs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_full_access_admin_users" ON "public"."admin_users" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."skill_demand" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."skill_demand_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."skill_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."skill_keywords" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."skill_relationships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."skills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."student_career_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."student_onboarding_drafts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "student_profiles_select_own" ON "public"."student_career_profiles" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."subscription_credit_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sync_locks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sync_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."uni_programs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."uni_student_matches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."uni_universities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."uni_university_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."userProfiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_activity_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_behavior_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_fcm_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_personalization_profile" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles_select_own" ON "public"."user_profiles" FOR SELECT TO "authenticated" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "user_profiles_update_own" ON "public"."user_profiles" FOR UPDATE TO "authenticated" USING ((("auth"."uid"())::"text" = "user_id"));



ALTER TABLE "public"."user_quota" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_vectors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_insert_own_analyses" ON "public"."resume_analyses" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users_insert_own_cvs" ON "public"."generated_cvs" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users_insert_own_usage" ON "public"."ai_cost_daily_usage" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users_own_resume_exports" ON "public"."resume_exports" USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "users_own_resume_versions" ON "public"."resume_versions" USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "users_read_own_analyses" ON "public"."resume_analyses" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users_read_own_cvs" ON "public"."generated_cvs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users_read_own_usage" ON "public"."ai_cost_daily_usage" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users_update_own_analyses" ON "public"."resume_analyses" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users_update_own_usage" ON "public"."ai_cost_daily_usage" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."acquire_sync_lock"("p_lock_key" "text", "p_instance_id" "text", "p_stale_cutoff" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."acquire_sync_lock"("p_lock_key" "text", "p_instance_id" "text", "p_stale_cutoff" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."acquire_sync_lock"("p_lock_key" "text", "p_instance_id" "text", "p_stale_cutoff" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."activate_subscription_tx"("p_user_id" "text", "p_tier" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_credits" integer, "p_subscription_id" "text", "p_provider" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone, "p_expires_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."activate_subscription_tx"("p_user_id" "text", "p_tier" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_credits" integer, "p_subscription_id" "text", "p_provider" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone, "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."activate_subscription_tx"("p_user_id" "text", "p_tier" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_credits" integer, "p_subscription_id" "text", "p_provider" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone, "p_expires_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."add_skills_to_profile"("p_user_id" "text", "p_skills" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."add_skills_to_profile"("p_user_id" "text", "p_skills" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_skills_to_profile"("p_user_id" "text", "p_skills" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."aggregate_daily_metrics"("start_date" timestamp with time zone, "end_date" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."aggregate_daily_metrics"("start_date" timestamp with time zone, "end_date" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."aggregate_daily_metrics"("start_date" timestamp with time zone, "end_date" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_pending_entry_transaction"("p_pending_id" "uuid", "p_admin_uid" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_pending_entry_transaction"("p_pending_id" "uuid", "p_admin_uid" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_pending_entry_transaction"("p_pending_id" "uuid", "p_admin_uid" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_pending_entry_transaction"("p_pending_id" "uuid", "p_admin_uid" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."autocomplete_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."autocomplete_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."autocomplete_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."bulk_import_dataset"("p_dataset" "text", "p_rows" "jsonb", "p_admin_id" "uuid", "p_agency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."bulk_import_dataset"("p_dataset" "text", "p_rows" "jsonb", "p_admin_id" "uuid", "p_agency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_import_dataset"("p_dataset" "text", "p_rows" "jsonb", "p_admin_id" "uuid", "p_agency" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_import_graph"("p_dataset" "text", "p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."bulk_import_skills"("p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."bulk_import_skills"("p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_import_skills"("p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_subscription_tx"("p_user_id" "text", "p_provider" "text", "p_subscription_id" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_reason" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_subscription_tx"("p_user_id" "text", "p_provider" "text", "p_subscription_id" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_reason" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_subscription_tx"("p_user_id" "text", "p_provider" "text", "p_subscription_id" "text", "p_external_event_id" "text", "p_previous_tier" "text", "p_reason" "text", "p_plan_amount" numeric, "p_plan_currency" "text", "p_idempotency_key" "text", "p_now" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."check_and_increment_ai_usage"("p_user_id" "uuid", "p_limit" integer, "p_now" timestamp with time zone, "p_next_reset" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."check_and_increment_ai_usage"("p_user_id" "uuid", "p_limit" integer, "p_now" timestamp with time zone, "p_next_reset" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_and_increment_ai_usage"("p_user_id" "uuid", "p_limit" integer, "p_now" timestamp with time zone, "p_next_reset" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."check_rate_limit"("p_key" "text", "p_limit" integer, "p_window_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."check_rate_limit"("p_key" "text", "p_limit" integer, "p_window_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_rate_limit"("p_key" "text", "p_limit" integer, "p_window_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_ai_job_for_processing"("p_job_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_ai_job_for_processing"("p_job_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_ai_job_for_processing"("p_job_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_automation_job"("p_job_id" "text", "p_worker_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_automation_job"("p_job_id" "text", "p_worker_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_automation_job"("p_job_id" "text", "p_worker_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_job"("p_job_id" "uuid", "p_worker_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_job"("p_job_id" "uuid", "p_worker_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_job"("p_job_id" "uuid", "p_worker_id" "text") TO "service_role";



GRANT ALL ON TABLE "public"."event_outbox" TO "anon";
GRANT ALL ON TABLE "public"."event_outbox" TO "authenticated";
GRANT ALL ON TABLE "public"."event_outbox" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_outbox_events"("p_route" "text", "p_batch_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_outbox_events"("p_route" "text", "p_batch_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_outbox_events"("p_route" "text", "p_batch_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_old_search_events"("p_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_old_search_events"("p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_search_events"("p_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_professional_onboarding"("p_user_id" "text", "p_job_title" "text", "p_years_experience" double precision, "p_industry" "text", "p_education_level" "text", "p_country" "text", "p_city" "text", "p_salary_range" "text", "p_career_goals" "jsonb", "p_skills" "jsonb", "p_cv_uploaded" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_professional_onboarding"("p_user_id" "text", "p_job_title" "text", "p_years_experience" double precision, "p_industry" "text", "p_education_level" "text", "p_country" "text", "p_city" "text", "p_salary_range" "text", "p_career_goals" "jsonb", "p_skills" "jsonb", "p_cv_uploaded" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_professional_onboarding"("p_user_id" "text", "p_job_title" "text", "p_years_experience" double precision, "p_industry" "text", "p_education_level" "text", "p_country" "text", "p_city" "text", "p_salary_range" "text", "p_career_goals" "jsonb", "p_skills" "jsonb", "p_cv_uploaded" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_resume_onboarding"("p_user_id" "uuid", "p_resume_data" "jsonb", "p_profile_strength" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_resume_onboarding"("p_user_id" "uuid", "p_resume_data" "jsonb", "p_profile_strength" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_resume_onboarding"("p_user_id" "uuid", "p_resume_data" "jsonb", "p_profile_strength" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."complete_student_onboarding"("p_user_id" "text", "p_profile" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."complete_student_onboarding"("p_user_id" "text", "p_profile" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_student_onboarding"("p_user_id" "text", "p_profile" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_ai_credits"("p_user_id" "uuid", "p_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."create_cms_role"("p_name" "text", "p_job_family_id" "text", "p_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "jsonb", "p_admin_id" "uuid", "p_agency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_cms_role"("p_name" "text", "p_job_family_id" "text", "p_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "jsonb", "p_admin_id" "uuid", "p_agency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_cms_role"("p_name" "text", "p_job_family_id" "text", "p_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "jsonb", "p_admin_id" "uuid", "p_agency" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_employer_with_admin"("p_user_id" "text", "p_company_name" "text", "p_industry" "text", "p_website" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_employer_with_admin"("p_user_id" "text", "p_company_name" "text", "p_industry" "text", "p_website" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_next_quarterly_partition"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_next_quarterly_partition"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_next_quarterly_partition"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_role"("p_role_name" "text", "p_role_family" "text", "p_seniority_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "text"[], "p_created_by" "text", "p_agency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_role"("p_role_name" "text", "p_role_family" "text", "p_seniority_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "text"[], "p_created_by" "text", "p_agency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_role"("p_role_name" "text", "p_role_family" "text", "p_seniority_level" "text", "p_track" "text", "p_description" "text", "p_alternative_titles" "text"[], "p_created_by" "text", "p_agency" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."deduct_credits"("user_id" "uuid", "amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deduct_credits"("user_id" "uuid", "amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_credits"("user_id" "uuid", "amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_role"("p_role_id" "text", "p_deleted_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_role"("p_role_id" "text", "p_deleted_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_role"("p_role_id" "text", "p_deleted_by" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_user_data"("p_user_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_user_data"("p_user_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fail_automation_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."fail_automation_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fail_automation_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "text", "p_error_code" "text", "p_error_message" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."find_similar_skills"("query_vector" "public"."vector", "top_k" integer, "min_score" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."find_similar_skills"("query_vector" "public"."vector", "top_k" integer, "min_score" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_similar_skills"("query_vector" "public"."vector", "top_k" integer, "min_score" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_adaptive_weights"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_adaptive_weights"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_adaptive_weights"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ai_daily_cost"("p_user_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_ai_daily_cost"("p_user_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ai_daily_cost"("p_user_id" "text") TO "service_role";



GRANT ALL ON TABLE "public"."ava_memory" TO "anon";
GRANT ALL ON TABLE "public"."ava_memory" TO "authenticated";
GRANT ALL ON TABLE "public"."ava_memory" TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ava_memory_users_due"("limit_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_ava_memory_users_due"("limit_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ava_memory_users_due"("limit_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_onboarding_funnel_analytics"("p_limit" integer, "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_onboarding_funnel_analytics"("p_limit" integer, "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_onboarding_funnel_analytics"("p_limit" integer, "p_from" timestamp with time zone, "p_to" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_opportunity_radar"("p_user_id" "uuid", "p_top_n" integer, "p_min_opportunity_score" integer, "p_min_match_score" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_opportunity_radar"("p_user_id" "uuid", "p_top_n" integer, "p_min_opportunity_score" integer, "p_min_match_score" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_opportunity_radar"("p_user_id" "uuid", "p_top_n" integer, "p_min_opportunity_score" integer, "p_min_match_score" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_opportunity_radar_ai"("user_skills" "text"[], "top_n" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_opportunity_radar_ai"("user_skills" "text"[], "top_n" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_opportunity_radar_ai"("user_skills" "text"[], "top_n" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_rag_context_v1"("p_user_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_rag_context_v1"("p_user_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_salary_band"("p_role_id" "text", "p_level" "text", "p_region" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_salary_band"("p_role_id" "text", "p_level" "text", "p_region" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_salary_band"("p_role_id" "text", "p_level" "text", "p_region" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."health_check"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."health_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."health_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."health_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."immutable_unaccent"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."immutable_unaccent"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."immutable_unaccent"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_ai_cost"("p_user_id" "text", "p_cost" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_ai_cost"("p_user_id" "text", "p_cost" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_ai_cost"("p_user_id" "text", "p_cost" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_ai_usage"("user_id" "text", "user_tier" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_ai_usage"("user_id" "text", "user_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_ai_usage"("user_id" "text", "user_tier" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_ava_memory_jobs"("p_user_id" "text", "p_delta" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_ava_memory_jobs"("p_user_id" "text", "p_delta" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_ava_memory_jobs"("p_user_id" "text", "p_delta" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_ava_memory_jobs"("p_user_id" "text", "p_delta" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_ava_memory_skills"("p_user_id" "text", "p_delta" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_ava_memory_skills"("p_user_id" "text", "p_delta" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_ava_memory_skills"("p_user_id" "text", "p_delta" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_ava_memory_skills"("p_user_id" "text", "p_delta" integer) TO "service_role";



GRANT ALL ON TABLE "public"."conversion_aggregates" TO "anon";
GRANT ALL ON TABLE "public"."conversion_aggregates" TO "authenticated";
GRANT ALL ON TABLE "public"."conversion_aggregates" TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_conversion_aggregate"("p_user_id" "text", "p_event_type" "text", "p_hard_limit" integer, "p_score_version" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_conversion_aggregate"("p_user_id" "text", "p_event_type" "text", "p_hard_limit" integer, "p_score_version" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_conversion_aggregate"("p_user_id" "text", "p_event_type" "text", "p_hard_limit" integer, "p_score_version" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_conversion_event_count"("p_id" "text", "p_event_type" "text", "p_hard_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_conversion_event_count"("p_id" "text", "p_event_type" "text", "p_hard_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_conversion_event_count"("p_id" "text", "p_event_type" "text", "p_hard_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_rate_limit"("p_id" "text", "p_limit" integer, "p_expires_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_rate_limit"("p_id" "text", "p_limit" integer, "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_rate_limit"("p_id" "text", "p_limit" integer, "p_expires_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_user_quota"("p_user_id" "text", "p_month_key" "text", "p_feature" "text", "p_increment" integer, "p_expires_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_user_quota"("p_user_id" "text", "p_month_key" "text", "p_feature" "text", "p_increment" integer, "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_user_quota"("p_user_id" "text", "p_month_key" "text", "p_feature" "text", "p_increment" integer, "p_expires_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."list_roles"("p_agency" "text", "p_limit" integer, "p_role_family" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."list_roles"("p_agency" "text", "p_limit" integer, "p_role_family" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_roles"("p_agency" "text", "p_limit" integer, "p_role_family" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_jobs_by_embedding"("query_vector" "public"."vector", "min_score" numeric, "top_k" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_jobs_by_embedding"("query_vector" "public"."vector", "min_score" numeric, "top_k" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_jobs_by_embedding"("query_vector" "public"."vector", "min_score" numeric, "top_k" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_roles"("query_embedding" "public"."vector", "match_count" integer, "min_similarity" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."match_roles"("query_embedding" "public"."vector", "match_count" integer, "min_similarity" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_roles"("query_embedding" "public"."vector", "match_count" integer, "min_similarity" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_skills"("input_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."match_skills"("input_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_skills"("input_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."match_skills_semantic"("input_skills" "text"[], "top_k" integer, "min_score" double precision) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."match_skills_semantic"("input_skills" "text"[], "top_k" integer, "min_score" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_skills_semantic"("input_skills" "text"[], "top_k" integer, "min_score" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."merge_notification_delivery_status"("p_notification_id" "text", "p_channel" "text", "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."merge_notification_delivery_status"("p_notification_id" "text", "p_channel" "text", "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."merge_notification_delivery_status"("p_notification_id" "text", "p_channel" "text", "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."next_resume_version"("p_resume_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."next_resume_version"("p_resume_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_resume_version"("p_resume_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_query"("p_query" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_query"("p_query" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_query"("p_query" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_role_name"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_role_name"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_role_name"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."normalize_text"("p_input" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."normalize_text"("p_input" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_text"("p_input" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_text"("p_input" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."prune_old_agent_results"("retain_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."prune_old_agent_results"("retain_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_old_agent_results"("retain_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."record_adaptive_outcome"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text", "p_predicted_score" numeric, "p_actual_outcome" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."record_adaptive_outcome"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text", "p_predicted_score" numeric, "p_actual_outcome" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_adaptive_outcome"("p_role_family" "text", "p_experience_bucket" "text", "p_industry_tag" "text", "p_predicted_score" numeric, "p_actual_outcome" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_click_popularity"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_click_popularity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_click_popularity"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refund_ai_credits"("p_user_id" "uuid", "p_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."release_sync_lock"("p_lock_key" "text", "p_instance_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."release_sync_lock"("p_lock_key" "text", "p_instance_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_sync_lock"("p_lock_key" "text", "p_instance_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_user_skills"("p_user_id" "text", "p_skill_names" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_user_skills"("p_user_id" "text", "p_skill_names" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."remove_user_skills"("p_user_id" "text", "p_skill_names" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_user_skills"("p_user_id" "text", "p_skill_names" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "text", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_career_predictions"("p_student_id" "uuid", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "text", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_career_simulations"("p_student_id" "uuid", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "text", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_education_roi"("p_student_id" "uuid", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_student_academic_records"("p_student_id" "text", "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_student_activities"("p_student_id" "text", "p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_search_weights"("p_weights" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_search_weights"("p_weights" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_search_weights"("p_weights" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."retry_outbox_event"("p_id" "uuid", "p_error" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."retry_outbox_event"("p_id" "uuid", "p_error" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."retry_outbox_event"("p_id" "uuid", "p_error" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."roles_search_vector_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."roles_search_vector_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."roles_search_vector_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."roles_search_vector_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."roles_search_vector_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."roles_search_vector_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sch_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."sch_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sch_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."search_cms_roles"("p_query" "text", "p_limit" integer, "p_agency" "text", "p_job_family_id" "text", "p_status" "text", "p_threshold" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."search_cms_roles"("p_query" "text", "p_limit" integer, "p_agency" "text", "p_job_family_id" "text", "p_status" "text", "p_threshold" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_cms_roles"("p_query" "text", "p_limit" integer, "p_agency" "text", "p_job_family_id" "text", "p_status" "text", "p_threshold" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_roles"("p_query" "text", "p_agency" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_roles_hybrid"("p_query" "text", "p_agency" "text", "p_limit" integer, "p_threshold" double precision, "p_weights" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."search_roles_hybrid"("p_query" "text", "p_agency" "text", "p_limit" integer, "p_threshold" double precision, "p_weights" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_roles_hybrid"("p_query" "text", "p_agency" "text", "p_limit" integer, "p_threshold" double precision, "p_weights" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_consent_versions"("versions" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."seed_consent_versions"("versions" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_consent_versions"("versions" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_user_and_profile"("p_user_id" "text", "p_email" "text", "p_display_name" "text", "p_photo_url" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."seed_user_and_profile"("p_user_id" "text", "p_email" "text", "p_display_name" "text", "p_photo_url" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_user_and_profile"("p_user_id" "text", "p_email" "text", "p_display_name" "text", "p_photo_url" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_career_predictions"("p_student_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."sync_career_predictions"("p_student_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_career_predictions"("p_student_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_user_display_fields"("p_user_id" "uuid", "p_display_name" "text", "p_photo_url" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."sync_user_display_fields"("p_user_id" "uuid", "p_display_name" "text", "p_photo_url" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_user_display_fields"("p_user_id" "uuid", "p_display_name" "text", "p_photo_url" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_user_tier_plan"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_user_tier_plan"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_user_tier_plan"() TO "service_role";



GRANT ALL ON FUNCTION "public"."track_click_event"("p_query" "text", "p_role_id" "text", "p_role_name" "text", "p_position" integer, "p_match_type" "text", "p_agency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."track_click_event"("p_query" "text", "p_role_id" "text", "p_role_name" "text", "p_position" integer, "p_match_type" "text", "p_agency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."track_click_event"("p_query" "text", "p_role_id" "text", "p_role_name" "text", "p_position" integer, "p_match_type" "text", "p_agency" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."track_search_event"("p_query" "text", "p_agency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."track_search_event"("p_query" "text", "p_agency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."track_search_event"("p_query" "text", "p_agency" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_fn_career_roles_search_vector"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_fn_career_roles_search_vector"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_fn_career_roles_search_vector"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_fn_career_skills_search_vector"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_fn_career_skills_search_vector"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_fn_career_skills_search_vector"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_role"("p_role_id" "text", "p_updates" "jsonb", "p_updated_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."update_role"("p_role_id" "text", "p_updates" "jsonb", "p_updated_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_role"("p_role_id" "text", "p_updates" "jsonb", "p_updated_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_ai_cost_tracking_atomic"("p_user_id" "uuid", "p_feature" "text", "p_date" "date", "p_total_cost_usd" numeric, "p_input_tokens" bigint, "p_output_tokens" bigint, "p_retention_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_ai_cost_tracking_atomic"("p_user_id" "uuid", "p_feature" "text", "p_date" "date", "p_total_cost_usd" numeric, "p_input_tokens" bigint, "p_output_tokens" bigint, "p_retention_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_ai_cost_tracking_atomic"("p_user_id" "uuid", "p_feature" "text", "p_date" "date", "p_total_cost_usd" numeric, "p_input_tokens" bigint, "p_output_tokens" bigint, "p_retention_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_search_weights"("p_weights" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_search_weights"("p_weights" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_search_weights"("p_weights" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."activity_events" TO "anon";
GRANT ALL ON TABLE "public"."activity_events" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_events" TO "service_role";



GRANT ALL ON TABLE "public"."activity_logs" TO "anon";
GRANT ALL ON TABLE "public"."activity_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_logs" TO "service_role";



GRANT ALL ON TABLE "public"."adaptive_weights" TO "anon";
GRANT ALL ON TABLE "public"."adaptive_weights" TO "authenticated";
GRANT ALL ON TABLE "public"."adaptive_weights" TO "service_role";



GRANT ALL ON TABLE "public"."admin_logs" TO "anon";
GRANT ALL ON TABLE "public"."admin_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_logs" TO "service_role";



GRANT ALL ON TABLE "public"."admin_principals" TO "anon";
GRANT ALL ON TABLE "public"."admin_principals" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_principals" TO "service_role";



GRANT ALL ON TABLE "public"."admin_secrets" TO "anon";
GRANT ALL ON TABLE "public"."admin_secrets" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."admin_users" TO "anon";
GRANT ALL ON TABLE "public"."admin_users" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_users" TO "service_role";



GRANT ALL ON SEQUENCE "public"."admin_users_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."admin_users_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."admin_users_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ai_alerts" TO "anon";
GRANT ALL ON TABLE "public"."ai_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_alerts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ai_alerts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ai_alerts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ai_alerts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ai_cost_daily_usage" TO "anon";
GRANT ALL ON TABLE "public"."ai_cost_daily_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_cost_daily_usage" TO "service_role";



GRANT ALL ON TABLE "public"."ai_cost_tracking" TO "anon";
GRANT ALL ON TABLE "public"."ai_cost_tracking" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_cost_tracking" TO "service_role";



GRANT ALL ON TABLE "public"."ai_daily_costs" TO "anon";
GRANT ALL ON TABLE "public"."ai_daily_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_daily_costs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_jobs" TO "anon";
GRANT ALL ON TABLE "public"."ai_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q1" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q1" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q1" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q2" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q2" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q2" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q3" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q3" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q3" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q4" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q4" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs_2025_q4" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs_2026_q1" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs_2026_q1" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs_2026_q1" TO "service_role";



GRANT ALL ON TABLE "public"."ai_observability_logs_2026_q2" TO "anon";
GRANT ALL ON TABLE "public"."ai_observability_logs_2026_q2" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_observability_logs_2026_q2" TO "service_role";



GRANT ALL ON TABLE "public"."ai_pipeline_jobs" TO "anon";
GRANT ALL ON TABLE "public"."ai_pipeline_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_pipeline_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage_logs" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ai_usage_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ai_usage_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ai_usage_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ats_scores" TO "anon";
GRANT ALL ON TABLE "public"."ats_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."ats_scores" TO "service_role";



GRANT ALL ON TABLE "public"."automation_jobs" TO "anon";
GRANT ALL ON TABLE "public"."automation_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."career_advice_cache" TO "anon";
GRANT ALL ON TABLE "public"."career_advice_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."career_advice_cache" TO "service_role";



GRANT ALL ON TABLE "public"."career_advice_results" TO "anon";
GRANT ALL ON TABLE "public"."career_advice_results" TO "authenticated";
GRANT ALL ON TABLE "public"."career_advice_results" TO "service_role";



GRANT ALL ON TABLE "public"."career_alerts" TO "anon";
GRANT ALL ON TABLE "public"."career_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."career_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."career_health_index" TO "anon";
GRANT ALL ON TABLE "public"."career_health_index" TO "authenticated";
GRANT ALL ON TABLE "public"."career_health_index" TO "service_role";



GRANT ALL ON TABLE "public"."career_health_results" TO "anon";
GRANT ALL ON TABLE "public"."career_health_results" TO "authenticated";
GRANT ALL ON TABLE "public"."career_health_results" TO "service_role";



GRANT ALL ON TABLE "public"."career_insights" TO "anon";
GRANT ALL ON TABLE "public"."career_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."career_insights" TO "service_role";



GRANT ALL ON TABLE "public"."career_metrics" TO "anon";
GRANT ALL ON TABLE "public"."career_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."career_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."career_opportunity_signals" TO "anon";
GRANT ALL ON TABLE "public"."career_opportunity_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."career_opportunity_signals" TO "service_role";



GRANT ALL ON TABLE "public"."career_paths" TO "anon";
GRANT ALL ON TABLE "public"."career_paths" TO "authenticated";
GRANT ALL ON TABLE "public"."career_paths" TO "service_role";



GRANT ALL ON TABLE "public"."career_progress_history" TO "anon";
GRANT ALL ON TABLE "public"."career_progress_history" TO "authenticated";
GRANT ALL ON TABLE "public"."career_progress_history" TO "service_role";



GRANT ALL ON TABLE "public"."career_readiness_scores" TO "anon";
GRANT ALL ON TABLE "public"."career_readiness_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."career_readiness_scores" TO "service_role";



GRANT ALL ON SEQUENCE "public"."career_readiness_scores_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."career_readiness_scores_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."career_readiness_scores_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."career_role_skills" TO "service_role";



GRANT ALL ON TABLE "public"."career_role_transitions" TO "service_role";



GRANT ALL ON TABLE "public"."career_roles" TO "service_role";



GRANT ALL ON TABLE "public"."career_simulations" TO "anon";
GRANT ALL ON TABLE "public"."career_simulations" TO "authenticated";
GRANT ALL ON TABLE "public"."career_simulations" TO "service_role";



GRANT ALL ON TABLE "public"."career_skills_registry" TO "service_role";



GRANT ALL ON TABLE "public"."certifications" TO "anon";
GRANT ALL ON TABLE "public"."certifications" TO "authenticated";
GRANT ALL ON TABLE "public"."certifications" TO "service_role";



GRANT ALL ON TABLE "public"."change_logs" TO "anon";
GRANT ALL ON TABLE "public"."change_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."change_logs" TO "service_role";



GRANT ALL ON TABLE "public"."chi_scores" TO "anon";
GRANT ALL ON TABLE "public"."chi_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."chi_scores" TO "service_role";



GRANT ALL ON TABLE "public"."cms_career_domains" TO "anon";
GRANT ALL ON TABLE "public"."cms_career_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_career_domains" TO "service_role";



GRANT ALL ON TABLE "public"."cms_education_levels" TO "anon";
GRANT ALL ON TABLE "public"."cms_education_levels" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_education_levels" TO "service_role";



GRANT ALL ON TABLE "public"."cms_job_families" TO "anon";
GRANT ALL ON TABLE "public"."cms_job_families" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_job_families" TO "service_role";



GRANT ALL ON TABLE "public"."cms_roles" TO "anon";
GRANT ALL ON TABLE "public"."cms_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_roles" TO "service_role";



GRANT ALL ON TABLE "public"."cms_salary_benchmarks" TO "anon";
GRANT ALL ON TABLE "public"."cms_salary_benchmarks" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_salary_benchmarks" TO "service_role";



GRANT ALL ON TABLE "public"."cms_skill_clusters" TO "anon";
GRANT ALL ON TABLE "public"."cms_skill_clusters" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_skill_clusters" TO "service_role";



GRANT ALL ON TABLE "public"."cms_skills" TO "anon";
GRANT ALL ON TABLE "public"."cms_skills" TO "authenticated";
GRANT ALL ON TABLE "public"."cms_skills" TO "service_role";



GRANT ALL ON TABLE "public"."consent_versions" TO "anon";
GRANT ALL ON TABLE "public"."consent_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."consent_versions" TO "service_role";



GRANT ALL ON TABLE "public"."conversion_events" TO "anon";
GRANT ALL ON TABLE "public"."conversion_events" TO "authenticated";
GRANT ALL ON TABLE "public"."conversion_events" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_conversations" TO "anon";
GRANT ALL ON TABLE "public"."copilot_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_grounding_failures" TO "anon";
GRANT ALL ON TABLE "public"."copilot_grounding_failures" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_grounding_failures" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_rag_contexts" TO "anon";
GRANT ALL ON TABLE "public"."copilot_rag_contexts" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_rag_contexts" TO "service_role";



GRANT ALL ON TABLE "public"."courses" TO "anon";
GRANT ALL ON TABLE "public"."courses" TO "authenticated";
GRANT ALL ON TABLE "public"."courses" TO "service_role";



GRANT ALL ON TABLE "public"."credit_operation_costs" TO "anon";
GRANT ALL ON TABLE "public"."credit_operation_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."credit_operation_costs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."credit_operation_costs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."credit_operation_costs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."credit_operation_costs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."daily_career_insights" TO "anon";
GRANT ALL ON TABLE "public"."daily_career_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_career_insights" TO "service_role";



GRANT ALL ON TABLE "public"."daily_metric_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."daily_metric_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_metric_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."edu_academic_records" TO "anon";
GRANT ALL ON TABLE "public"."edu_academic_records" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_academic_records" TO "service_role";



GRANT ALL ON SEQUENCE "public"."edu_academic_records_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."edu_academic_records_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."edu_academic_records_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."edu_career_conversations" TO "anon";
GRANT ALL ON TABLE "public"."edu_career_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_career_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."edu_career_predictions" TO "anon";
GRANT ALL ON TABLE "public"."edu_career_predictions" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_career_predictions" TO "service_role";



GRANT ALL ON TABLE "public"."edu_career_simulations" TO "anon";
GRANT ALL ON TABLE "public"."edu_career_simulations" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_career_simulations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."edu_career_simulations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."edu_career_simulations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."edu_career_simulations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."edu_cognitive_results" TO "anon";
GRANT ALL ON TABLE "public"."edu_cognitive_results" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_cognitive_results" TO "service_role";



GRANT ALL ON TABLE "public"."edu_education_roi" TO "anon";
GRANT ALL ON TABLE "public"."edu_education_roi" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_education_roi" TO "service_role";



GRANT ALL ON SEQUENCE "public"."edu_education_roi_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."edu_education_roi_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."edu_education_roi_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."edu_extracurricular" TO "anon";
GRANT ALL ON TABLE "public"."edu_extracurricular" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_extracurricular" TO "service_role";



GRANT ALL ON SEQUENCE "public"."edu_extracurricular_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."edu_extracurricular_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."edu_extracurricular_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."edu_skill_recommendations" TO "anon";
GRANT ALL ON TABLE "public"."edu_skill_recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_skill_recommendations" TO "service_role";



GRANT ALL ON TABLE "public"."edu_stream_scores" TO "anon";
GRANT ALL ON TABLE "public"."edu_stream_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_stream_scores" TO "service_role";



GRANT ALL ON TABLE "public"."edu_student_skills" TO "anon";
GRANT ALL ON TABLE "public"."edu_student_skills" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_student_skills" TO "service_role";



GRANT ALL ON TABLE "public"."edu_students" TO "anon";
GRANT ALL ON TABLE "public"."edu_students" TO "authenticated";
GRANT ALL ON TABLE "public"."edu_students" TO "service_role";



GRANT ALL ON TABLE "public"."emp_employer_users" TO "anon";
GRANT ALL ON TABLE "public"."emp_employer_users" TO "authenticated";
GRANT ALL ON TABLE "public"."emp_employer_users" TO "service_role";



GRANT ALL ON TABLE "public"."emp_employers" TO "anon";
GRANT ALL ON TABLE "public"."emp_employers" TO "authenticated";
GRANT ALL ON TABLE "public"."emp_employers" TO "service_role";



GRANT ALL ON TABLE "public"."emp_job_roles" TO "anon";
GRANT ALL ON TABLE "public"."emp_job_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."emp_job_roles" TO "service_role";



GRANT ALL ON TABLE "public"."emp_talent_signals" TO "anon";
GRANT ALL ON TABLE "public"."emp_talent_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."emp_talent_signals" TO "service_role";



GRANT ALL ON TABLE "public"."external_salary_apis" TO "anon";
GRANT ALL ON TABLE "public"."external_salary_apis" TO "authenticated";
GRANT ALL ON TABLE "public"."external_salary_apis" TO "service_role";



GRANT ALL ON TABLE "public"."gcid_aggregated_cache" TO "anon";
GRANT ALL ON TABLE "public"."gcid_aggregated_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."gcid_aggregated_cache" TO "service_role";



GRANT ALL ON TABLE "public"."gcid_analytics_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."gcid_analytics_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."gcid_analytics_snapshots" TO "service_role";



GRANT ALL ON SEQUENCE "public"."gcid_analytics_snapshots_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."gcid_analytics_snapshots_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."gcid_analytics_snapshots_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."generated_cvs" TO "anon";
GRANT ALL ON TABLE "public"."generated_cvs" TO "authenticated";
GRANT ALL ON TABLE "public"."generated_cvs" TO "service_role";



GRANT ALL ON TABLE "public"."role_skills" TO "anon";
GRANT ALL ON TABLE "public"."role_skills" TO "authenticated";
GRANT ALL ON TABLE "public"."role_skills" TO "service_role";



GRANT ALL ON TABLE "public"."role_transitions" TO "anon";
GRANT ALL ON TABLE "public"."role_transitions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_transitions" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."skill_relationships" TO "anon";
GRANT ALL ON TABLE "public"."skill_relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."skill_relationships" TO "service_role";



GRANT ALL ON TABLE "public"."skills" TO "anon";
GRANT ALL ON TABLE "public"."skills" TO "authenticated";
GRANT ALL ON TABLE "public"."skills" TO "service_role";



GRANT ALL ON TABLE "public"."graph_metrics" TO "anon";
GRANT ALL ON TABLE "public"."graph_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."graph_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."health_check" TO "anon";
GRANT ALL ON TABLE "public"."health_check" TO "authenticated";
GRANT ALL ON TABLE "public"."health_check" TO "service_role";



GRANT ALL ON TABLE "public"."idempotency_keys" TO "anon";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "service_role";



GRANT ALL ON TABLE "public"."import_logs" TO "anon";
GRANT ALL ON TABLE "public"."import_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."import_logs" TO "service_role";



GRANT ALL ON TABLE "public"."jd_analysis_logs" TO "anon";
GRANT ALL ON TABLE "public"."jd_analysis_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."jd_analysis_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."jd_analysis_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."jd_analysis_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."jd_analysis_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."job_analyses" TO "anon";
GRANT ALL ON TABLE "public"."job_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."job_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."job_applications" TO "anon";
GRANT ALL ON TABLE "public"."job_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."job_applications" TO "service_role";



GRANT ALL ON TABLE "public"."job_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."job_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."job_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."job_families" TO "anon";
GRANT ALL ON TABLE "public"."job_families" TO "authenticated";
GRANT ALL ON TABLE "public"."job_families" TO "service_role";



GRANT ALL ON TABLE "public"."job_listings_cache" TO "anon";
GRANT ALL ON TABLE "public"."job_listings_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."job_listings_cache" TO "service_role";



GRANT ALL ON TABLE "public"."job_match_results" TO "anon";
GRANT ALL ON TABLE "public"."job_match_results" TO "authenticated";
GRANT ALL ON TABLE "public"."job_match_results" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."learning_paths_cache" TO "anon";
GRANT ALL ON TABLE "public"."learning_paths_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."learning_paths_cache" TO "service_role";



GRANT ALL ON TABLE "public"."learning_resources" TO "anon";
GRANT ALL ON TABLE "public"."learning_resources" TO "authenticated";
GRANT ALL ON TABLE "public"."learning_resources" TO "service_role";



GRANT ALL ON TABLE "public"."lmi_career_market_scores" TO "anon";
GRANT ALL ON TABLE "public"."lmi_career_market_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."lmi_career_market_scores" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lmi_career_market_scores_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lmi_career_market_scores_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lmi_career_market_scores_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lmi_career_predictions" TO "anon";
GRANT ALL ON TABLE "public"."lmi_career_predictions" TO "authenticated";
GRANT ALL ON TABLE "public"."lmi_career_predictions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lmi_career_predictions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lmi_career_predictions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lmi_career_predictions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lmi_ingestion_runs" TO "anon";
GRANT ALL ON TABLE "public"."lmi_ingestion_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."lmi_ingestion_runs" TO "service_role";



GRANT ALL ON TABLE "public"."lmi_job_market_data" TO "anon";
GRANT ALL ON TABLE "public"."lmi_job_market_data" TO "authenticated";
GRANT ALL ON TABLE "public"."lmi_job_market_data" TO "service_role";



GRANT ALL ON TABLE "public"."market_intelligence_cache" TO "anon";
GRANT ALL ON TABLE "public"."market_intelligence_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."market_intelligence_cache" TO "service_role";



GRANT ALL ON TABLE "public"."market_intelligence_sync" TO "anon";
GRANT ALL ON TABLE "public"."market_intelligence_sync" TO "authenticated";
GRANT ALL ON TABLE "public"."market_intelligence_sync" TO "service_role";



GRANT ALL ON SEQUENCE "public"."market_intelligence_sync_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."market_intelligence_sync_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."market_intelligence_sync_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."metrics_daily_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."metrics_daily_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."metrics_daily_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."search_events" TO "anon";
GRANT ALL ON TABLE "public"."search_events" TO "authenticated";
GRANT ALL ON TABLE "public"."search_events" TO "service_role";



GRANT ALL ON TABLE "public"."most_clicked_roles" TO "anon";
GRANT ALL ON TABLE "public"."most_clicked_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."most_clicked_roles" TO "service_role";



GRANT ALL ON TABLE "public"."most_clicked_roles_recent" TO "anon";
GRANT ALL ON TABLE "public"."most_clicked_roles_recent" TO "authenticated";
GRANT ALL ON TABLE "public"."most_clicked_roles_recent" TO "service_role";



GRANT ALL ON TABLE "public"."notification_delivery" TO "anon";
GRANT ALL ON TABLE "public"."notification_delivery" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_delivery" TO "service_role";



GRANT ALL ON TABLE "public"."notification_jobs" TO "anon";
GRANT ALL ON TABLE "public"."notification_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_progress" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_progress" TO "service_role";



GRANT ALL ON TABLE "public"."opportunity_radar_results" TO "anon";
GRANT ALL ON TABLE "public"."opportunity_radar_results" TO "authenticated";
GRANT ALL ON TABLE "public"."opportunity_radar_results" TO "service_role";



GRANT ALL ON TABLE "public"."payment_logs" TO "anon";
GRANT ALL ON TABLE "public"."payment_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_logs" TO "service_role";



GRANT ALL ON TABLE "public"."pending_entries" TO "anon";
GRANT ALL ON TABLE "public"."pending_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_entries" TO "service_role";



GRANT ALL ON TABLE "public"."personalized_recommendations" TO "anon";
GRANT ALL ON TABLE "public"."personalized_recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."personalized_recommendations" TO "service_role";



GRANT ALL ON TABLE "public"."pi_ai_model_settings" TO "anon";
GRANT ALL ON TABLE "public"."pi_ai_model_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_ai_model_settings" TO "service_role";



GRANT ALL ON TABLE "public"."pi_ai_prompts" TO "anon";
GRANT ALL ON TABLE "public"."pi_ai_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_ai_prompts" TO "service_role";



GRANT ALL ON TABLE "public"."pi_ai_usage_logs" TO "anon";
GRANT ALL ON TABLE "public"."pi_ai_usage_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_ai_usage_logs" TO "service_role";



GRANT ALL ON TABLE "public"."pi_career_datasets" TO "anon";
GRANT ALL ON TABLE "public"."pi_career_datasets" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_career_datasets" TO "service_role";



GRANT ALL ON TABLE "public"."pi_career_paths" TO "anon";
GRANT ALL ON TABLE "public"."pi_career_paths" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_career_paths" TO "service_role";



GRANT ALL ON TABLE "public"."pi_chi_weights" TO "anon";
GRANT ALL ON TABLE "public"."pi_chi_weights" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_chi_weights" TO "service_role";



GRANT ALL ON TABLE "public"."pi_feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."pi_feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_feature_flags" TO "service_role";



GRANT ALL ON TABLE "public"."pi_market_data_sources" TO "anon";
GRANT ALL ON TABLE "public"."pi_market_data_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_market_data_sources" TO "service_role";



GRANT ALL ON TABLE "public"."pi_skill_taxonomy" TO "anon";
GRANT ALL ON TABLE "public"."pi_skill_taxonomy" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_skill_taxonomy" TO "service_role";



GRANT ALL ON TABLE "public"."pi_subscription_plans" TO "anon";
GRANT ALL ON TABLE "public"."pi_subscription_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_subscription_plans" TO "service_role";



GRANT ALL ON TABLE "public"."pi_training_sources" TO "anon";
GRANT ALL ON TABLE "public"."pi_training_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."pi_training_sources" TO "service_role";



GRANT ALL ON TABLE "public"."professional_career_profiles" TO "anon";
GRANT ALL ON TABLE "public"."professional_career_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."professional_career_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."qualifications" TO "anon";
GRANT ALL ON TABLE "public"."qualifications" TO "authenticated";
GRANT ALL ON TABLE "public"."qualifications" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."resume_analyses" TO "anon";
GRANT ALL ON TABLE "public"."resume_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."resume_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."resume_exports" TO "anon";
GRANT ALL ON TABLE "public"."resume_exports" TO "authenticated";
GRANT ALL ON TABLE "public"."resume_exports" TO "service_role";



GRANT ALL ON TABLE "public"."resume_growth_signals" TO "anon";
GRANT ALL ON TABLE "public"."resume_growth_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."resume_growth_signals" TO "service_role";



GRANT ALL ON TABLE "public"."resume_scores" TO "anon";
GRANT ALL ON TABLE "public"."resume_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."resume_scores" TO "service_role";



GRANT ALL ON TABLE "public"."resume_versions" TO "anon";
GRANT ALL ON TABLE "public"."resume_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."resume_versions" TO "service_role";



GRANT ALL ON TABLE "public"."resumes" TO "anon";
GRANT ALL ON TABLE "public"."resumes" TO "authenticated";
GRANT ALL ON TABLE "public"."resumes" TO "service_role";



GRANT ALL ON TABLE "public"."risk_analysis_results" TO "anon";
GRANT ALL ON TABLE "public"."risk_analysis_results" TO "authenticated";
GRANT ALL ON TABLE "public"."risk_analysis_results" TO "service_role";



GRANT ALL ON TABLE "public"."role_aliases" TO "anon";
GRANT ALL ON TABLE "public"."role_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."role_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."role_education" TO "anon";
GRANT ALL ON TABLE "public"."role_education" TO "authenticated";
GRANT ALL ON TABLE "public"."role_education" TO "service_role";



GRANT ALL ON TABLE "public"."role_market_data" TO "anon";
GRANT ALL ON TABLE "public"."role_market_data" TO "authenticated";
GRANT ALL ON TABLE "public"."role_market_data" TO "service_role";



GRANT ALL ON TABLE "public"."role_market_demand" TO "anon";
GRANT ALL ON TABLE "public"."role_market_demand" TO "authenticated";
GRANT ALL ON TABLE "public"."role_market_demand" TO "service_role";



GRANT ALL ON TABLE "public"."role_salary_market" TO "anon";
GRANT ALL ON TABLE "public"."role_salary_market" TO "authenticated";
GRANT ALL ON TABLE "public"."role_salary_market" TO "service_role";



GRANT ALL ON TABLE "public"."salary_bands" TO "anon";
GRANT ALL ON TABLE "public"."salary_bands" TO "authenticated";
GRANT ALL ON TABLE "public"."salary_bands" TO "service_role";



GRANT ALL ON TABLE "public"."salary_data" TO "anon";
GRANT ALL ON TABLE "public"."salary_data" TO "authenticated";
GRANT ALL ON TABLE "public"."salary_data" TO "service_role";



GRANT ALL ON TABLE "public"."sch_school_students" TO "anon";
GRANT ALL ON TABLE "public"."sch_school_students" TO "authenticated";
GRANT ALL ON TABLE "public"."sch_school_students" TO "service_role";



GRANT ALL ON TABLE "public"."sch_school_users" TO "anon";
GRANT ALL ON TABLE "public"."sch_school_users" TO "authenticated";
GRANT ALL ON TABLE "public"."sch_school_users" TO "service_role";



GRANT ALL ON TABLE "public"."sch_schools" TO "anon";
GRANT ALL ON TABLE "public"."sch_schools" TO "authenticated";
GRANT ALL ON TABLE "public"."sch_schools" TO "service_role";



GRANT ALL ON TABLE "public"."secrets_rotation_log" TO "anon";
GRANT ALL ON TABLE "public"."secrets_rotation_log" TO "authenticated";
GRANT ALL ON TABLE "public"."secrets_rotation_log" TO "service_role";



GRANT ALL ON TABLE "public"."semantic_match_cache" TO "anon";
GRANT ALL ON TABLE "public"."semantic_match_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."semantic_match_cache" TO "service_role";



GRANT ALL ON TABLE "public"."skill_demand" TO "anon";
GRANT ALL ON TABLE "public"."skill_demand" TO "authenticated";
GRANT ALL ON TABLE "public"."skill_demand" TO "service_role";



GRANT ALL ON TABLE "public"."skill_demand_analyses" TO "anon";
GRANT ALL ON TABLE "public"."skill_demand_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."skill_demand_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."skill_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."skill_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."skill_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."skill_keywords" TO "anon";
GRANT ALL ON TABLE "public"."skill_keywords" TO "authenticated";
GRANT ALL ON TABLE "public"."skill_keywords" TO "service_role";



GRANT ALL ON SEQUENCE "public"."skill_keywords_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."skill_keywords_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."skill_keywords_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."student_career_profiles" TO "anon";
GRANT ALL ON TABLE "public"."student_career_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."student_career_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."student_onboarding_drafts" TO "anon";
GRANT ALL ON TABLE "public"."student_onboarding_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."student_onboarding_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_credit_plans" TO "anon";
GRANT ALL ON TABLE "public"."subscription_credit_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_credit_plans" TO "service_role";



GRANT ALL ON SEQUENCE "public"."subscription_credit_plans_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."subscription_credit_plans_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."subscription_credit_plans_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_events" TO "anon";
GRANT ALL ON TABLE "public"."subscription_events" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_events" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."sync_locks" TO "anon";
GRANT ALL ON TABLE "public"."sync_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_locks" TO "service_role";



GRANT ALL ON TABLE "public"."sync_logs" TO "anon";
GRANT ALL ON TABLE "public"."sync_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_logs" TO "service_role";



GRANT ALL ON TABLE "public"."top_searches" TO "anon";
GRANT ALL ON TABLE "public"."top_searches" TO "authenticated";
GRANT ALL ON TABLE "public"."top_searches" TO "service_role";



GRANT ALL ON TABLE "public"."uni_programs" TO "anon";
GRANT ALL ON TABLE "public"."uni_programs" TO "authenticated";
GRANT ALL ON TABLE "public"."uni_programs" TO "service_role";



GRANT ALL ON TABLE "public"."uni_student_matches" TO "anon";
GRANT ALL ON TABLE "public"."uni_student_matches" TO "authenticated";
GRANT ALL ON TABLE "public"."uni_student_matches" TO "service_role";



GRANT ALL ON TABLE "public"."uni_universities" TO "anon";
GRANT ALL ON TABLE "public"."uni_universities" TO "authenticated";
GRANT ALL ON TABLE "public"."uni_universities" TO "service_role";



GRANT ALL ON TABLE "public"."uni_university_users" TO "anon";
GRANT ALL ON TABLE "public"."uni_university_users" TO "authenticated";
GRANT ALL ON TABLE "public"."uni_university_users" TO "service_role";



GRANT ALL ON TABLE "public"."usage_logs" TO "anon";
GRANT ALL ON TABLE "public"."usage_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."usage_logs" TO "service_role";



GRANT ALL ON TABLE "public"."userProfiles" TO "anon";
GRANT ALL ON TABLE "public"."userProfiles" TO "authenticated";
GRANT ALL ON TABLE "public"."userProfiles" TO "service_role";



GRANT ALL ON TABLE "public"."user_activity_events" TO "anon";
GRANT ALL ON TABLE "public"."user_activity_events" TO "authenticated";
GRANT ALL ON TABLE "public"."user_activity_events" TO "service_role";



GRANT ALL ON TABLE "public"."user_behavior_events" TO "anon";
GRANT ALL ON TABLE "public"."user_behavior_events" TO "authenticated";
GRANT ALL ON TABLE "public"."user_behavior_events" TO "service_role";



GRANT ALL ON TABLE "public"."user_fcm_tokens" TO "anon";
GRANT ALL ON TABLE "public"."user_fcm_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."user_fcm_tokens" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_fcm_tokens_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_fcm_tokens_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_fcm_tokens_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_personalization_profile" TO "anon";
GRANT ALL ON TABLE "public"."user_personalization_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."user_personalization_profile" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."user_quota" TO "anon";
GRANT ALL ON TABLE "public"."user_quota" TO "authenticated";
GRANT ALL ON TABLE "public"."user_quota" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_vectors" TO "anon";
GRANT ALL ON TABLE "public"."user_vectors" TO "authenticated";
GRANT ALL ON TABLE "public"."user_vectors" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";











