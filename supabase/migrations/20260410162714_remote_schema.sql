create extension if not exists "pg_cron" with schema "pg_catalog";

drop extension if exists "pg_net";

drop policy "Users can manage own job applications" on "public"."job_applications";

revoke delete on table "public"."career_role_skills" from "anon";

revoke insert on table "public"."career_role_skills" from "anon";

revoke references on table "public"."career_role_skills" from "anon";

revoke select on table "public"."career_role_skills" from "anon";

revoke trigger on table "public"."career_role_skills" from "anon";

revoke truncate on table "public"."career_role_skills" from "anon";

revoke update on table "public"."career_role_skills" from "anon";

revoke delete on table "public"."career_role_skills" from "authenticated";

revoke insert on table "public"."career_role_skills" from "authenticated";

revoke references on table "public"."career_role_skills" from "authenticated";

revoke select on table "public"."career_role_skills" from "authenticated";

revoke trigger on table "public"."career_role_skills" from "authenticated";

revoke truncate on table "public"."career_role_skills" from "authenticated";

revoke update on table "public"."career_role_skills" from "authenticated";

revoke delete on table "public"."career_role_transitions" from "anon";

revoke insert on table "public"."career_role_transitions" from "anon";

revoke references on table "public"."career_role_transitions" from "anon";

revoke select on table "public"."career_role_transitions" from "anon";

revoke trigger on table "public"."career_role_transitions" from "anon";

revoke truncate on table "public"."career_role_transitions" from "anon";

revoke update on table "public"."career_role_transitions" from "anon";

revoke delete on table "public"."career_role_transitions" from "authenticated";

revoke insert on table "public"."career_role_transitions" from "authenticated";

revoke references on table "public"."career_role_transitions" from "authenticated";

revoke select on table "public"."career_role_transitions" from "authenticated";

revoke trigger on table "public"."career_role_transitions" from "authenticated";

revoke truncate on table "public"."career_role_transitions" from "authenticated";

revoke update on table "public"."career_role_transitions" from "authenticated";

revoke delete on table "public"."career_roles" from "anon";

revoke insert on table "public"."career_roles" from "anon";

revoke references on table "public"."career_roles" from "anon";

revoke select on table "public"."career_roles" from "anon";

revoke trigger on table "public"."career_roles" from "anon";

revoke truncate on table "public"."career_roles" from "anon";

revoke update on table "public"."career_roles" from "anon";

revoke delete on table "public"."career_roles" from "authenticated";

revoke insert on table "public"."career_roles" from "authenticated";

revoke references on table "public"."career_roles" from "authenticated";

revoke select on table "public"."career_roles" from "authenticated";

revoke trigger on table "public"."career_roles" from "authenticated";

revoke truncate on table "public"."career_roles" from "authenticated";

revoke update on table "public"."career_roles" from "authenticated";

revoke delete on table "public"."career_skills_registry" from "anon";

revoke insert on table "public"."career_skills_registry" from "anon";

revoke references on table "public"."career_skills_registry" from "anon";

revoke select on table "public"."career_skills_registry" from "anon";

revoke trigger on table "public"."career_skills_registry" from "anon";

revoke truncate on table "public"."career_skills_registry" from "anon";

revoke update on table "public"."career_skills_registry" from "anon";

revoke delete on table "public"."career_skills_registry" from "authenticated";

revoke insert on table "public"."career_skills_registry" from "authenticated";

revoke references on table "public"."career_skills_registry" from "authenticated";

revoke select on table "public"."career_skills_registry" from "authenticated";

revoke trigger on table "public"."career_skills_registry" from "authenticated";

revoke truncate on table "public"."career_skills_registry" from "authenticated";

revoke update on table "public"."career_skills_registry" from "authenticated";

alter table "public"."career_metrics" drop constraint "chk_activity_score_range";

alter table "public"."career_metrics" drop constraint "chk_ats_score_range";

alter table "public"."career_metrics" drop constraint "chk_composite_range";

alter table "public"."career_metrics" drop constraint "chk_interview_score_range";

alter table "public"."career_metrics" drop constraint "chk_job_match_range";

drop materialized view if exists "public"."chi_weekly_rollups_mv";

alter table "public"."chi_scores" drop constraint "chi_scores_pkey";

drop index if exists "public"."chi_scores_pkey";

drop index if exists "public"."idx_chi_scores_user_chi";

drop index if exists "public"."idx_chi_scores_user_role";


  create table "public"."chi_scores_2026_04" partition of "public"."chi_scores" FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');



  create table "public"."chi_scores_2026_05" partition of "public"."chi_scores" FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');



  create table "public"."chi_scores_2026_06" partition of "public"."chi_scores" FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');



  create table "public"."chi_scores_default" partition of "public"."chi_scores" DEFAULT;



  create table "public"."chi_scores_legacy" (
    "id" text not null,
    "user_id" text not null,
    "role_id" text not null,
    "skill_match" numeric(5,2) not null default 0,
    "experience_fit" numeric(5,2) not null default 0,
    "market_demand" numeric(5,2) not null default 0,
    "learning_progress" numeric(5,2) not null default 0,
    "chi_score" numeric(5,2) not null default 0,
    "last_updated" timestamp with time zone not null default now()
      );


alter table "public"."chi_scores_legacy" enable row level security;

drop table "public"."chi_scores";


  create table "public"."chi_scores" (
    "id" text not null,
    "user_id" text not null,
    "role_id" text not null,
    "skill_match" numeric not null,
    "experience_fit" numeric not null,
    "market_demand" numeric not null,
    "learning_progress" numeric not null,
    "chi_score" numeric not null,
    "last_updated" timestamp with time zone not null
      ) partition by RANGE (last_updated);


alter table "public"."chi_scores" alter column "chi_score" drop default;

alter table "public"."chi_scores" alter column "chi_score" set data type numeric using "chi_score"::numeric;

alter table "public"."chi_scores" alter column "experience_fit" drop default;

alter table "public"."chi_scores" alter column "experience_fit" set data type numeric using "experience_fit"::numeric;

alter table "public"."chi_scores" alter column "last_updated" drop default;

alter table "public"."chi_scores" alter column "learning_progress" drop default;

alter table "public"."chi_scores" alter column "learning_progress" set data type numeric using "learning_progress"::numeric;

alter table "public"."chi_scores" alter column "market_demand" drop default;

alter table "public"."chi_scores" alter column "market_demand" set data type numeric using "market_demand"::numeric;

alter table "public"."chi_scores" alter column "skill_match" drop default;

alter table "public"."chi_scores" alter column "skill_match" set data type numeric using "skill_match"::numeric;

alter table "public"."chi_scores" disable row level security;

CREATE UNIQUE INDEX chi_scores_2026_04_pkey ON public.chi_scores_2026_04 USING btree (id, last_updated);

CREATE INDEX chi_scores_2026_04_role_idx ON public.chi_scores_2026_04 USING btree (role_id);

CREATE INDEX chi_scores_2026_04_user_id_chi_score_idx ON public.chi_scores_2026_04 USING btree (user_id, chi_score DESC);

CREATE INDEX chi_scores_2026_04_user_id_last_updated_idx ON public.chi_scores_2026_04 USING btree (user_id, last_updated DESC);

CREATE INDEX chi_scores_2026_04_user_id_role_id_idx ON public.chi_scores_2026_04 USING btree (user_id, role_id);

CREATE INDEX chi_scores_2026_04_user_last_updated_idx ON public.chi_scores_2026_04 USING btree (user_id, last_updated DESC);

CREATE UNIQUE INDEX chi_scores_2026_05_pkey ON public.chi_scores_2026_05 USING btree (id, last_updated);

CREATE INDEX chi_scores_2026_05_role_idx ON public.chi_scores_2026_05 USING btree (role_id);

CREATE INDEX chi_scores_2026_05_user_id_chi_score_idx ON public.chi_scores_2026_05 USING btree (user_id, chi_score DESC);

CREATE INDEX chi_scores_2026_05_user_id_last_updated_idx ON public.chi_scores_2026_05 USING btree (user_id, last_updated DESC);

CREATE INDEX chi_scores_2026_05_user_id_role_id_idx ON public.chi_scores_2026_05 USING btree (user_id, role_id);

CREATE INDEX chi_scores_2026_05_user_last_updated_idx ON public.chi_scores_2026_05 USING btree (user_id, last_updated DESC);

CREATE UNIQUE INDEX chi_scores_2026_06_pkey ON public.chi_scores_2026_06 USING btree (id, last_updated);

CREATE INDEX chi_scores_2026_06_role_idx ON public.chi_scores_2026_06 USING btree (role_id);

CREATE INDEX chi_scores_2026_06_user_id_chi_score_idx ON public.chi_scores_2026_06 USING btree (user_id, chi_score DESC);

CREATE INDEX chi_scores_2026_06_user_id_last_updated_idx ON public.chi_scores_2026_06 USING btree (user_id, last_updated DESC);

CREATE INDEX chi_scores_2026_06_user_id_role_id_idx ON public.chi_scores_2026_06 USING btree (user_id, role_id);

CREATE INDEX chi_scores_2026_06_user_last_updated_idx ON public.chi_scores_2026_06 USING btree (user_id, last_updated DESC);

CREATE UNIQUE INDEX chi_scores_default_pkey ON public.chi_scores_default USING btree (id, last_updated);

CREATE INDEX chi_scores_default_user_id_chi_score_idx ON public.chi_scores_default USING btree (user_id, chi_score DESC);

CREATE INDEX chi_scores_default_user_id_last_updated_idx ON public.chi_scores_default USING btree (user_id, last_updated DESC);

CREATE INDEX chi_scores_default_user_id_role_id_idx ON public.chi_scores_default USING btree (user_id, role_id);

CREATE UNIQUE INDEX chi_scores_v2_pkey ON ONLY public.chi_scores USING btree (id, last_updated);

CREATE INDEX idx_chi_scores_v2_user_chi ON ONLY public.chi_scores USING btree (user_id, chi_score DESC);

CREATE INDEX idx_chi_scores_v2_user_last_updated ON ONLY public.chi_scores USING btree (user_id, last_updated DESC);

CREATE INDEX idx_chi_scores_v2_user_role ON ONLY public.chi_scores USING btree (user_id, role_id);

CREATE UNIQUE INDEX chi_scores_pkey ON public.chi_scores_legacy USING btree (id);

CREATE INDEX idx_chi_scores_user_chi ON public.chi_scores_legacy USING btree (user_id, chi_score DESC);

CREATE INDEX idx_chi_scores_user_role ON public.chi_scores_legacy USING btree (user_id, role_id);

alter table "public"."chi_scores" add constraint "chi_scores_v2_pkey" PRIMARY KEY using index "chi_scores_v2_pkey";

alter table "public"."chi_scores_2026_04" add constraint "chi_scores_2026_04_pkey" PRIMARY KEY using index "chi_scores_2026_04_pkey";

alter table "public"."chi_scores_2026_05" add constraint "chi_scores_2026_05_pkey" PRIMARY KEY using index "chi_scores_2026_05_pkey";

alter table "public"."chi_scores_2026_06" add constraint "chi_scores_2026_06_pkey" PRIMARY KEY using index "chi_scores_2026_06_pkey";

alter table "public"."chi_scores_default" add constraint "chi_scores_default_pkey" PRIMARY KEY using index "chi_scores_default_pkey";

alter table "public"."chi_scores_legacy" add constraint "chi_scores_pkey" PRIMARY KEY using index "chi_scores_pkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.cleanup_old_chi_scores_partitions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    r record;
    v_cutoff date := date_trunc('month', now() - interval '18 months')::date;
    v_partition_date date;
BEGIN
    FOR r IN
        SELECT inhrelid::regclass::text AS partition_name
        FROM pg_inherits
        WHERE inhparent = 'public.chi_scores'::regclass
    LOOP
        BEGIN
            v_partition_date := to_date(
                substring(r.partition_name from '(\d{4}_\d{2})$'),
                'YYYY_MM'
            );

            IF v_partition_date < v_cutoff THEN
                EXECUTE format(
                    'DROP TABLE IF EXISTS public.%I',
                    r.partition_name
                );
            END IF;
        EXCEPTION
            WHEN others THEN
                NULL;
        END;
    END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.compute_learning_progress(p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_skills_added integer := 0;
  v_courses_started integer := 0;
  v_result integer := 0;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'skill_added'),
    COUNT(*) FILTER (WHERE event_type = 'course_started')
  INTO v_skills_added, v_courses_started
  FROM activity_events
  WHERE user_id = p_user_id
    AND created_at >= NOW() - INTERVAL '30 days'
    AND event_type IN ('skill_added', 'course_started');

  v_result :=
    LEAST(100,
      ROUND(LEAST(v_skills_added / 5.0, 1) * 50 +
            LEAST(v_courses_started / 3.0, 1) * 50)
    );

  RETURN COALESCE(v_result, 0);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.create_resume_analysis_snapshot(p_payload jsonb)
 RETURNS SETOF public.resume_analyses
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_row resume_analyses;
BEGIN
  INSERT INTO resume_analyses (
    resume_id,
    user_id,
    engine,
    analysis_hash,
    score,
    tier,
    summary,
    breakdown,
    strengths,
    improvements,
    top_skills,
    estimated_experience_years,
    chi_score,
    dimensions,
    market_position,
    peer_comparison,
    growth_insights,
    salary_estimate,
    roadmap,
    ai_model_version,
    projected_level_up_months,
    current_estimated_salary_lpa,
    next_level_estimated_salary_lpa,
    career_roadmap,
    weighted_career_context,
    token_input_count,
    token_output_count,
    ai_cost_usd,
    cache_hit,
    cache_source,
    latency_ms,
    operation_type
  )
  VALUES (
    (p_payload->>'resume_id')::uuid,
    (p_payload->>'user_id')::uuid,
    p_payload->>'engine',
    p_payload->>'analysis_hash',
    NULLIF(p_payload->>'score', '')::integer,
    p_payload->>'tier',
    p_payload->>'summary',
    p_payload->'breakdown',
    p_payload->'strengths',
    p_payload->'improvements',
    ARRAY(
      SELECT jsonb_array_elements_text(
        COALESCE(p_payload->'top_skills', '[]'::jsonb)
      )
    ),
    NULLIF(p_payload->>'estimated_experience_years', '')::integer,
    NULLIF(p_payload->>'chi_score', '')::integer,
    p_payload->'dimensions',
    p_payload->'market_position',
    p_payload->'peer_comparison',
    p_payload->'growth_insights',
    p_payload->'salary_estimate',
    p_payload->'roadmap',
    p_payload->>'ai_model_version',
    NULLIF(p_payload->>'projected_level_up_months', '')::integer,
    NULLIF(p_payload->>'current_estimated_salary_lpa', '')::numeric,
    NULLIF(p_payload->>'next_level_estimated_salary_lpa', '')::numeric,
    p_payload->'career_roadmap',
    p_payload->'weighted_career_context',
    NULLIF(p_payload->>'token_input_count', '')::integer,
    NULLIF(p_payload->>'token_output_count', '')::integer,
    NULLIF(p_payload->>'ai_cost_usd', '')::numeric,
    COALESCE((p_payload->>'cache_hit')::boolean, false),
    p_payload->>'cache_source',
    NULLIF(p_payload->>'latency_ms', '')::integer,
    COALESCE(p_payload->>'operation_type', 'chi_snapshot')
  )
  RETURNING *
  INTO v_row;

  RETURN NEXT v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_chi_scores_partition(p_target_date timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_start date;
    v_end date;
    v_partition_name text;
BEGIN
    v_start := date_trunc('month', p_target_date)::date;
    v_end := (v_start + interval '1 month')::date;

    v_partition_name := format(
        'chi_scores_%s',
        to_char(v_start, 'YYYY_MM')
    );

    -- create monthly partition if missing
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I
         PARTITION OF public.chi_scores
         FOR VALUES FROM (%L) TO (%L)',
        v_partition_name,
        v_start,
        v_end
    );

    -- latest score lookup index
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I
         ON public.%I (user_id, last_updated DESC)',
        v_partition_name || '_user_last_updated_idx',
        v_partition_name
    );

    -- role-based analytics lookup
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I
         ON public.%I (role_id)',
        v_partition_name || '_role_idx',
        v_partition_name
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_future_chi_scores_partitions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    i integer;
BEGIN
    FOR i IN 0..2 LOOP
        PERFORM public.ensure_chi_scores_partition(
            now() + (i || ' month')::interval
        );
    END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_chi_score(p_user_id text, p_role_id text)
 RETURNS TABLE(id text, user_id text, role_id text, skill_match integer, experience_fit integer, market_demand integer, learning_progress integer, chi_score integer, last_updated timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT
    cs.id,
    cs.user_id,
    cs.role_id,
    cs.skill_match,
    cs.experience_fit,
    cs.market_demand,
    cs.learning_progress,
    cs.chi_score,
    cs.last_updated
  FROM chi_scores cs
  WHERE cs.id = p_user_id || '_' || p_role_id
  LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.get_latest_resume_analysis(p_resume_id uuid)
 RETURNS SETOF public.resume_analyses
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT *
  FROM resume_analyses
  WHERE resume_id = p_resume_id
  ORDER BY created_at DESC
  LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.get_resume_analysis_by_hash(p_user_id uuid, p_analysis_hash text)
 RETURNS SETOF public.resume_analyses
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT *
  FROM resume_analyses
  WHERE user_id = p_user_id
    AND analysis_hash = p_analysis_hash
  ORDER BY created_at DESC
  LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_resume_analyses(p_user_id uuid, p_limit integer DEFAULT 10)
 RETURNS SETOF public.resume_analyses
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT *
  FROM resume_analyses
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$function$
;

CREATE OR REPLACE FUNCTION public.match_career_roles(p_domain_id text DEFAULT NULL::text, p_limit integer DEFAULT 10)
 RETURNS TABLE(id uuid, name text, required_skills jsonb, experience_min integer, experience_max integer, market_demand numeric)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT
    r.id,
    r.name,
    r.required_skills,
    r.experience_min,
    r.experience_max,
    r.market_demand
  FROM cms_roles r
  WHERE r.soft_deleted = false
    AND r.status = 'active'
    AND (
      p_domain_id IS NULL
      OR r.domain_id = p_domain_id
    )
  ORDER BY r.market_demand DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_chi_weekly_rollups_mv()
 RETURNS void
 LANGUAGE sql
AS $function$
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.chi_weekly_rollups_mv;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_credits(user_id uuid, amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_remaining integer;
BEGIN
  UPDATE users
  SET ai_credits_remaining =
    COALESCE(ai_credits_remaining, 0) + amount
  WHERE id = user_id
  RETURNING ai_credits_remaining
  INTO v_remaining;

  RETURN COALESCE(v_remaining, 0);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_family_ids_for_domain(p_domain_id text)
 RETURNS TABLE(id text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT DISTINCT r.job_family_id AS id
  FROM cms_roles r
  WHERE r.domain_id = p_domain_id
    AND r.soft_deleted = false
    AND r.job_family_id IS NOT NULL;
$function$
;

CREATE OR REPLACE FUNCTION public.update_resume_analysis_telemetry(p_id uuid, p_patch jsonb)
 RETURNS SETOF public.resume_analyses
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_row resume_analyses;
BEGIN
  UPDATE resume_analyses
  SET
    token_input_count =
      COALESCE(NULLIF(p_patch->>'token_input_count', '')::integer, token_input_count),
    token_output_count =
      COALESCE(NULLIF(p_patch->>'token_output_count', '')::integer, token_output_count),
    ai_cost_usd =
      COALESCE(NULLIF(p_patch->>'ai_cost_usd', '')::numeric, ai_cost_usd),
    latency_ms =
      COALESCE(NULLIF(p_patch->>'latency_ms', '')::integer, latency_ms),
    cache_hit =
      COALESCE((p_patch->>'cache_hit')::boolean, cache_hit),
    cache_source =
      COALESCE(p_patch->>'cache_source', cache_source),
    ai_model_version =
      COALESCE(p_patch->>'ai_model_version', ai_model_version),
    updated_at = NOW()
  WHERE id = p_id
  RETURNING *
  INTO v_row;

  RETURN NEXT v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_chi_score(p_user_id uuid, p_role_id uuid, p_skill_match integer, p_experience_fit integer, p_market_demand integer, p_learning_progress integer, p_chi_score integer)
 RETURNS TABLE(id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_id text := p_user_id::text || '_' || p_role_id::text;
BEGIN
  INSERT INTO chi_scores (
    id,
    user_id,
    role_id,
    skill_match,
    experience_fit,
    market_demand,
    learning_progress,
    chi_score,
    last_updated
  )
  VALUES (
    v_id,
    p_user_id,
    p_role_id,
    p_skill_match,
    p_experience_fit,
    p_market_demand,
    p_learning_progress,
    p_chi_score,
    NOW()
  )
  ON CONFLICT (id)
  DO UPDATE SET
    skill_match = EXCLUDED.skill_match,
    experience_fit = EXCLUDED.experience_fit,
    market_demand = EXCLUDED.market_demand,
    learning_progress = EXCLUDED.learning_progress,
    chi_score = EXCLUDED.chi_score,
    last_updated = NOW();

  RETURN QUERY SELECT v_id;
END;
$function$
;

create materialized view "public"."chi_weekly_rollups_mv" as  SELECT date_trunc('week'::text, last_updated) AS week_bucket,
    user_id,
    role_id AS cohort_key,
    count(*) AS samples,
    avg(chi_score) AS avg_score,
    min(chi_score) AS min_score,
    max(chi_score) AS max_score,
    max(last_updated) AS latest_point_at
   FROM public.chi_scores
  GROUP BY (date_trunc('week'::text, last_updated)), user_id, role_id;


CREATE OR REPLACE FUNCTION public.get_latest_chi_score(p_user_id text, p_lookback_days integer DEFAULT 45)
 RETURNS TABLE(id text, user_id text, role_id text, chi_score numeric, last_updated timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_cutoff timestamptz;
BEGIN
    v_cutoff := now() - (p_lookback_days || ' days')::interval;

    RETURN QUERY
    SELECT
        cs.id,
        cs.user_id,
        cs.role_id,
        cs.chi_score,
        cs.last_updated
    FROM public.chi_scores cs
    WHERE cs.user_id = p_user_id
      AND cs.last_updated >= v_cutoff
    ORDER BY cs.last_updated DESC
    LIMIT 1;
END;
$function$
;

create materialized view "public"."chi_cohort_benchmark_mv" as  WITH base AS (
         SELECT chi_weekly_rollups_mv.week_bucket,
            chi_weekly_rollups_mv.user_id,
            chi_weekly_rollups_mv.cohort_key,
            chi_weekly_rollups_mv.avg_score,
            chi_weekly_rollups_mv.samples
           FROM public.chi_weekly_rollups_mv
        ), cohort_stats AS (
         SELECT base.week_bucket,
            base.cohort_key,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((base.avg_score)::double precision)) AS cohort_median,
            percentile_cont((0.9)::double precision) WITHIN GROUP (ORDER BY ((base.avg_score)::double precision)) AS cohort_p90,
            count(*) AS cohort_size
           FROM base
          GROUP BY base.week_bucket, base.cohort_key
        ), ranked AS (
         SELECT b.week_bucket,
            b.user_id,
            b.cohort_key,
            b.avg_score,
            b.samples,
            c.cohort_median,
            c.cohort_p90,
            c.cohort_size,
            cume_dist() OVER (PARTITION BY b.week_bucket, b.cohort_key ORDER BY b.avg_score) AS percentile_rank,
            rank() OVER (PARTITION BY b.week_bucket, b.cohort_key ORDER BY b.avg_score DESC) AS cohort_rank
           FROM (base b
             JOIN cohort_stats c ON (((c.week_bucket = b.week_bucket) AND (c.cohort_key = b.cohort_key))))
        )
 SELECT week_bucket,
    user_id,
    cohort_key,
    avg_score,
    samples,
    cohort_median,
    cohort_p90,
    percentile_rank,
    cohort_rank,
    cohort_size,
    ((avg_score)::double precision - cohort_median) AS delta_vs_median,
    ((avg_score)::double precision - cohort_p90) AS delta_vs_top10
   FROM ranked;


CREATE INDEX idx_chi_cohort_benchmark_cohort_week ON public.chi_cohort_benchmark_mv USING btree (cohort_key, week_bucket DESC);

CREATE UNIQUE INDEX idx_chi_cohort_benchmark_unique ON public.chi_cohort_benchmark_mv USING btree (week_bucket, user_id, cohort_key);

CREATE INDEX idx_chi_cohort_benchmark_user_week ON public.chi_cohort_benchmark_mv USING btree (user_id, week_bucket DESC);

CREATE INDEX idx_chi_weekly_rollups_cohort_week ON public.chi_weekly_rollups_mv USING btree (cohort_key, week_bucket DESC);

CREATE UNIQUE INDEX idx_chi_weekly_rollups_unique ON public.chi_weekly_rollups_mv USING btree (week_bucket, user_id, cohort_key);

CREATE INDEX idx_chi_weekly_rollups_user_week ON public.chi_weekly_rollups_mv USING btree (user_id, week_bucket DESC);

grant delete on table "public"."chi_scores_2026_04" to "anon";

grant insert on table "public"."chi_scores_2026_04" to "anon";

grant references on table "public"."chi_scores_2026_04" to "anon";

grant select on table "public"."chi_scores_2026_04" to "anon";

grant trigger on table "public"."chi_scores_2026_04" to "anon";

grant truncate on table "public"."chi_scores_2026_04" to "anon";

grant update on table "public"."chi_scores_2026_04" to "anon";

grant delete on table "public"."chi_scores_2026_04" to "authenticated";

grant insert on table "public"."chi_scores_2026_04" to "authenticated";

grant references on table "public"."chi_scores_2026_04" to "authenticated";

grant select on table "public"."chi_scores_2026_04" to "authenticated";

grant trigger on table "public"."chi_scores_2026_04" to "authenticated";

grant truncate on table "public"."chi_scores_2026_04" to "authenticated";

grant update on table "public"."chi_scores_2026_04" to "authenticated";

grant delete on table "public"."chi_scores_2026_04" to "service_role";

grant insert on table "public"."chi_scores_2026_04" to "service_role";

grant references on table "public"."chi_scores_2026_04" to "service_role";

grant select on table "public"."chi_scores_2026_04" to "service_role";

grant trigger on table "public"."chi_scores_2026_04" to "service_role";

grant truncate on table "public"."chi_scores_2026_04" to "service_role";

grant update on table "public"."chi_scores_2026_04" to "service_role";

grant delete on table "public"."chi_scores_2026_05" to "anon";

grant insert on table "public"."chi_scores_2026_05" to "anon";

grant references on table "public"."chi_scores_2026_05" to "anon";

grant select on table "public"."chi_scores_2026_05" to "anon";

grant trigger on table "public"."chi_scores_2026_05" to "anon";

grant truncate on table "public"."chi_scores_2026_05" to "anon";

grant update on table "public"."chi_scores_2026_05" to "anon";

grant delete on table "public"."chi_scores_2026_05" to "authenticated";

grant insert on table "public"."chi_scores_2026_05" to "authenticated";

grant references on table "public"."chi_scores_2026_05" to "authenticated";

grant select on table "public"."chi_scores_2026_05" to "authenticated";

grant trigger on table "public"."chi_scores_2026_05" to "authenticated";

grant truncate on table "public"."chi_scores_2026_05" to "authenticated";

grant update on table "public"."chi_scores_2026_05" to "authenticated";

grant delete on table "public"."chi_scores_2026_05" to "service_role";

grant insert on table "public"."chi_scores_2026_05" to "service_role";

grant references on table "public"."chi_scores_2026_05" to "service_role";

grant select on table "public"."chi_scores_2026_05" to "service_role";

grant trigger on table "public"."chi_scores_2026_05" to "service_role";

grant truncate on table "public"."chi_scores_2026_05" to "service_role";

grant update on table "public"."chi_scores_2026_05" to "service_role";

grant delete on table "public"."chi_scores_2026_06" to "anon";

grant insert on table "public"."chi_scores_2026_06" to "anon";

grant references on table "public"."chi_scores_2026_06" to "anon";

grant select on table "public"."chi_scores_2026_06" to "anon";

grant trigger on table "public"."chi_scores_2026_06" to "anon";

grant truncate on table "public"."chi_scores_2026_06" to "anon";

grant update on table "public"."chi_scores_2026_06" to "anon";

grant delete on table "public"."chi_scores_2026_06" to "authenticated";

grant insert on table "public"."chi_scores_2026_06" to "authenticated";

grant references on table "public"."chi_scores_2026_06" to "authenticated";

grant select on table "public"."chi_scores_2026_06" to "authenticated";

grant trigger on table "public"."chi_scores_2026_06" to "authenticated";

grant truncate on table "public"."chi_scores_2026_06" to "authenticated";

grant update on table "public"."chi_scores_2026_06" to "authenticated";

grant delete on table "public"."chi_scores_2026_06" to "service_role";

grant insert on table "public"."chi_scores_2026_06" to "service_role";

grant references on table "public"."chi_scores_2026_06" to "service_role";

grant select on table "public"."chi_scores_2026_06" to "service_role";

grant trigger on table "public"."chi_scores_2026_06" to "service_role";

grant truncate on table "public"."chi_scores_2026_06" to "service_role";

grant update on table "public"."chi_scores_2026_06" to "service_role";

grant delete on table "public"."chi_scores_default" to "anon";

grant insert on table "public"."chi_scores_default" to "anon";

grant references on table "public"."chi_scores_default" to "anon";

grant select on table "public"."chi_scores_default" to "anon";

grant trigger on table "public"."chi_scores_default" to "anon";

grant truncate on table "public"."chi_scores_default" to "anon";

grant update on table "public"."chi_scores_default" to "anon";

grant delete on table "public"."chi_scores_default" to "authenticated";

grant insert on table "public"."chi_scores_default" to "authenticated";

grant references on table "public"."chi_scores_default" to "authenticated";

grant select on table "public"."chi_scores_default" to "authenticated";

grant trigger on table "public"."chi_scores_default" to "authenticated";

grant truncate on table "public"."chi_scores_default" to "authenticated";

grant update on table "public"."chi_scores_default" to "authenticated";

grant delete on table "public"."chi_scores_default" to "service_role";

grant insert on table "public"."chi_scores_default" to "service_role";

grant references on table "public"."chi_scores_default" to "service_role";

grant select on table "public"."chi_scores_default" to "service_role";

grant trigger on table "public"."chi_scores_default" to "service_role";

grant truncate on table "public"."chi_scores_default" to "service_role";

grant update on table "public"."chi_scores_default" to "service_role";

grant delete on table "public"."chi_scores_legacy" to "anon";

grant insert on table "public"."chi_scores_legacy" to "anon";

grant references on table "public"."chi_scores_legacy" to "anon";

grant select on table "public"."chi_scores_legacy" to "anon";

grant trigger on table "public"."chi_scores_legacy" to "anon";

grant truncate on table "public"."chi_scores_legacy" to "anon";

grant update on table "public"."chi_scores_legacy" to "anon";

grant delete on table "public"."chi_scores_legacy" to "authenticated";

grant insert on table "public"."chi_scores_legacy" to "authenticated";

grant references on table "public"."chi_scores_legacy" to "authenticated";

grant select on table "public"."chi_scores_legacy" to "authenticated";

grant trigger on table "public"."chi_scores_legacy" to "authenticated";

grant truncate on table "public"."chi_scores_legacy" to "authenticated";

grant update on table "public"."chi_scores_legacy" to "authenticated";

grant delete on table "public"."chi_scores_legacy" to "service_role";

grant insert on table "public"."chi_scores_legacy" to "service_role";

grant references on table "public"."chi_scores_legacy" to "service_role";

grant select on table "public"."chi_scores_legacy" to "service_role";

grant trigger on table "public"."chi_scores_legacy" to "service_role";

grant truncate on table "public"."chi_scores_legacy" to "service_role";

grant update on table "public"."chi_scores_legacy" to "service_role";


  create policy "job_applications_delete_own"
  on "public"."job_applications"
  as permissive
  for delete
  to authenticated
using ((auth.uid() = user_id));



  create policy "job_applications_insert_own"
  on "public"."job_applications"
  as permissive
  for insert
  to authenticated
with check ((auth.uid() = user_id));



  create policy "job_applications_select_own"
  on "public"."job_applications"
  as permissive
  for select
  to authenticated
using ((auth.uid() = user_id));



  create policy "job_applications_update_own"
  on "public"."job_applications"
  as permissive
  for update
  to authenticated
using ((auth.uid() = user_id))
with check ((auth.uid() = user_id));


CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


