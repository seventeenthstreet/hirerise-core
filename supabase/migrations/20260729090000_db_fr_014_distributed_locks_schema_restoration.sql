-- =============================================================================
-- HireRise Core Database Function Reconciliation (DB-FR)
-- Migration: 20260729090000_db_fr_014_distributed_locks_schema_restoration.sql
-- Work Package: WP-LOCK-03 — Distributed Lock Schema Restoration
--
-- CERTIFIED FOUNDATIONS (not re-evaluated by this migration)
--   WP-LOCK-01 — Distributed Locking Root Cause Investigation
--   WP-LOCK-02 — Locking Architecture Lineage Reconciliation
--
--   WP-LOCK-02 established:
--     - LockService (core/src/core/infrastructure/locking/lock.service.js) is
--       an active, governance-approved infrastructure primitive (explicitly
--       whitelisted in src/eslint-plugin-local/lib/rules/
--       no-service-importing-service.js as an APPROVED INFRASTRUCTURE
--       PRIMITIVE).
--     - Resume Score (src/services/resumeScore.service.js) was intentionally
--       built against LockService, using a per-user resource key
--       (`lock:${userId}`) — a shape that only a general-purpose,
--       arbitrary-resource lock table supports.
--     - `distributed_locks` never appears in any prior migration, in
--       pre_wp_db_005_schema.sql, post_wp_db_005_schema.sql, or
--       post_wp_db_006_schema.sql. It is not deprecated and was not replaced
--       by `sync_locks` (a separate, singleton-job-only table with no
--       architectural relationship to this one). Its absence is an omitted
--       migration, not a retired design.
--
-- ROOT CAUSE
--   `lock.service.js` performs all operations against `TABLE =
--   'distributed_locks'`, which does not exist in the schema. Every
--   acquire() call fails, so every executeWithLock() call — including
--   Resume Score's cache-miss path — throws RESOURCE_LOCKED.
--
--   The implementation's exact required schema, read directly from
--   lock.service.js:
--     - acquire(): INSERT { resource, lock_id, expires_at, acquired_at }.
--       Relies on the insert failing when a row for `resource` already
--       exists (fast path), which requires `resource` to be the unique/
--       primary key.
--     - acquire() takeover path: UPDATE { lock_id, expires_at, acquired_at }
--       WHERE resource = :resource AND expires_at < now() — an atomic
--       expired-lock takeover, filtered by the same `resource` key.
--     - release(): DELETE WHERE resource = :resource AND lock_id = :lockId
--       — ownership-scoped release, so a stale caller can't release a lock
--       that has since been taken over by someone else.
--   No other columns are read, written, or filtered on anywhere in the file.
--
-- WHAT THIS MIGRATION DOES
--   Creates the missing `public.distributed_locks` table with exactly the
--   four columns LockService's insert/update/delete statements require,
--   `resource` as the primary key (so the insert-then-takeover-on-conflict
--   pattern in acquire() behaves as written), and the same RLS/grant
--   convention already used for the sibling internal infrastructure lock
--   table `public.sync_locks` (RLS enabled, service-role-only policy, broad
--   table grants gated by that policy).
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - Does not modify lock.service.js, lock.utils.js, resumeScore.service.js,
--     or any other application code — none is required; the existing insert/
--     update/delete statements already target exactly this shape.
--   - Does not touch sync_locks, acquire_sync_lock, release_sync_lock,
--     SyncLockManager, or any job-sync code path.
--   - Does not add columns, triggers, or indexes beyond what acquire()/
--     release() actually query. In particular, no secondary index on
--     expires_at is added: every query filters on `resource` first (the
--     primary key), so the expires_at comparison in the takeover path is a
--     cheap filter over the single row already located by the PK lookup —
--     a standalone index on expires_at would not be used by any query this
--     table serves and would only add write overhead.
--   - Does not modify any existing migration.
--
-- WP-LOCK-03A — POLICY IDEMPOTENCY HARDENING
--   PostgreSQL has no `CREATE POLICY IF NOT EXISTS` syntax, so the RLS
--   policy below is created inside a `DO $$ ... $$` block that first checks
--   `pg_policies` for an existing policy of the same name on this table,
--   only issuing `CREATE POLICY` when none is found. This guards against
--   failure on accidental re-execution; it does not change the resulting
--   policy, its semantics, or anything else in this migration.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."distributed_locks" (
    "resource" "text" NOT NULL,
    "lock_id" "text" NOT NULL,
    "acquired_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."distributed_locks" OWNER TO "postgres";

COMMENT ON TABLE "public"."distributed_locks" IS 'Generic distributed advisory lock table backing LockService (core/src/core/infrastructure/locking/lock.service.js). One row per locked resource; arbitrary resource keys (e.g. lock:{userId} for Resume Score), unlike the job-sync-specific sync_locks table.';

COMMENT ON COLUMN "public"."distributed_locks"."resource" IS 'Logical lock key, e.g. lock:{userId}. Primary key: an insert against an already-locked resource fails, which is how LockService.acquire() detects an active lock (fast path) before attempting an expired-lock takeover.';

COMMENT ON COLUMN "public"."distributed_locks"."lock_id" IS 'Random UUID (crypto.randomUUID()) identifying the current holder of the lock. Used by release() to scope the DELETE to the caller that actually holds the lock, so a stale caller cannot release a lock already taken over by someone else.';

COMMENT ON COLUMN "public"."distributed_locks"."acquired_at" IS 'When the current holder acquired (or took over) the lock. Set on every insert and on every takeover UPDATE.';

COMMENT ON COLUMN "public"."distributed_locks"."expires_at" IS 'When the current holder''s lock becomes eligible for takeover. LockService''s takeover UPDATE only succeeds when expires_at < now(), so a new holder can only replace an expired lock, never an active one.';

ALTER TABLE ONLY "public"."distributed_locks"
    ADD CONSTRAINT "distributed_locks_pkey" PRIMARY KEY ("resource");

ALTER TABLE "public"."distributed_locks" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'distributed_locks'
          AND policyname = 'Service only distributed locks'
    ) THEN
        CREATE POLICY "Service only distributed locks" ON "public"."distributed_locks"
            USING (("auth"."role"() = 'service_role'::"text"));
    END IF;
END
$$;

GRANT ALL ON TABLE "public"."distributed_locks" TO "anon";
GRANT ALL ON TABLE "public"."distributed_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."distributed_locks" TO "service_role";

COMMIT;
