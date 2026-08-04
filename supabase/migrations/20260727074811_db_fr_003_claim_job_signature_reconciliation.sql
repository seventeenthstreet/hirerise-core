-- DB-FR-003 — claim_job Function Signature Reconciliation
--
-- Root cause:
--   public.claim_job declares p_job_id as uuid, but automation_jobs.id is text
--   (and always has been — see 000_initial_schema.sql line 6561; confirmed
--   identical in migrations_original_backup, pre_wp_db_005_schema.sql, and
--   post_wp_db_005_schema.sql, so there is no signature drift to reconcile
--   beyond this single parameter). The function body compares
--   automation_jobs.id = p_job_id, which PostgreSQL evaluates as text = uuid —
--   an operator that does not exist (SQLSTATE 42883).
--
-- Fix:
--   Change p_job_id from uuid to text. Every other attribute of the function
--   is preserved exactly as declared in the canonical definition
--   (000_initial_schema.sql lines 1712-1750): LANGUAGE plpgsql,
--   SECURITY DEFINER, identical body, identical RETURNS json. The canonical
--   definition declares no explicit volatility, parallel safety, cost, or
--   search_path — those remain at PostgreSQL's implicit defaults, unchanged,
--   exactly as before.
--
--   CREATE OR REPLACE FUNCTION cannot alter parameter types, so the
--   uuid-typed overload is dropped explicitly and the text-typed version is
--   created fresh via CREATE FUNCTION. Ownership and grants are re-applied
--   identically to what existed before.

BEGIN;

DROP FUNCTION "public"."claim_job"("p_job_id" "uuid", "p_worker_id" "text");

CREATE FUNCTION "public"."claim_job"("p_job_id" "text", "p_worker_id" "text") RETURNS json
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

ALTER FUNCTION "public"."claim_job"("p_job_id" "text", "p_worker_id" "text") OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."claim_job"("p_job_id" "text", "p_worker_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_job"("p_job_id" "text", "p_worker_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_job"("p_job_id" "text", "p_worker_id" "text") TO "service_role";

COMMIT;
