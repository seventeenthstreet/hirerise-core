-- =============================================================================
-- MIGRATION: 20260410_phase1_db_security.sql
-- PURPOSE:   Phase 1 DB security hardening — revoke unsafe anon grants and
--            add service_role-only / authenticated-only RLS policies on all
--            priority sensitive tables.
-- SAFE:      Additive only. Does NOT rewrite existing policies or drop tables.
--            Rollback: see 20260410_phase1_db_security.rollback.sql
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. REVOKE anon table grants on PII / financial / billing tables
--    These tables have RLS enabled but no anon-blocking policy — granting
--    anon SELECT lets anyone without a JWT read raw rows if RLS ever has a gap.
--    The backend only ever uses service_role. anon grants are not needed.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE public.users                FROM anon;
REVOKE ALL ON TABLE public.user_profiles        FROM anon;
REVOKE ALL ON TABLE public.user_vectors         FROM anon;
REVOKE ALL ON TABLE public.subscriptions        FROM anon;
REVOKE ALL ON TABLE public.subscription_events  FROM anon;
REVOKE ALL ON TABLE public.usage_logs           FROM anon;
REVOKE ALL ON TABLE public.salary_data          FROM anon;
REVOKE ALL ON TABLE public.admin_users          FROM anon;
REVOKE ALL ON TABLE public.admin_secrets        FROM anon;
REVOKE ALL ON TABLE public.admin_principals     FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. SUBSCRIPTIONS — no policies exist. Add authenticated (own) + service_role.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "subscriptions_select_own"  ON public.subscriptions;
DROP POLICY IF EXISTS "subscriptions_service_role" ON public.subscriptions;

CREATE POLICY "subscriptions_select_own"
  ON public.subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = (auth.uid())::text);

CREATE POLICY "subscriptions_service_role"
  ON public.subscriptions
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SUBSCRIPTION_EVENTS — immutable audit log. authenticated reads own rows.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "subscription_events_select_own"  ON public.subscription_events;
DROP POLICY IF EXISTS "subscription_events_service_role" ON public.subscription_events;

CREATE POLICY "subscription_events_select_own"
  ON public.subscription_events
  FOR SELECT
  TO authenticated
  USING (user_id = (auth.uid())::text);

CREATE POLICY "subscription_events_service_role"
  ON public.subscription_events
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. USER_VECTORS — embedding table. Only owner + service_role should access.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "user_vectors_own"          ON public.user_vectors;
DROP POLICY IF EXISTS "user_vectors_service_role" ON public.user_vectors;

CREATE POLICY "user_vectors_own"
  ON public.user_vectors
  USING (user_id = (auth.uid())::text)
  WITH CHECK (user_id = (auth.uid())::text);

CREATE POLICY "user_vectors_service_role"
  ON public.user_vectors
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. USAGE_LOGS — billing/cost data. authenticated reads own rows only.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "usage_logs_select_own"   ON public.usage_logs;
DROP POLICY IF EXISTS "usage_logs_insert_own"   ON public.usage_logs;
DROP POLICY IF EXISTS "usage_logs_service_role" ON public.usage_logs;

CREATE POLICY "usage_logs_select_own"
  ON public.usage_logs
  FOR SELECT
  TO authenticated
  USING (user_id = (auth.uid())::text);

-- Backend writes usage_logs via service_role; users cannot INSERT directly.
CREATE POLICY "usage_logs_service_role"
  ON public.usage_logs
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SALARY_DATA — admin-managed reference data.
--    Authenticated users can read (to display salary bands).
--    All mutations require service_role (backend admin routes use service_role).
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "salary_data_read_authenticated" ON public.salary_data;
DROP POLICY IF EXISTS "salary_data_service_role"       ON public.salary_data;

CREATE POLICY "salary_data_read_authenticated"
  ON public.salary_data
  FOR SELECT
  TO authenticated
  USING (soft_deleted = false);

CREATE POLICY "salary_data_service_role"
  ON public.salary_data
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ADMIN_USERS — lookup table used by is_admin() function.
--    No direct user access; service_role only.
-- ─────────────────────────────────────────────────────────────────────────────

-- Policy already exists for service_role — ensure no anon/authenticated policies open it.
DROP POLICY IF EXISTS "admin_users_authenticated" ON public.admin_users;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ADMIN_SECRETS — encrypted secrets table. MUST be service_role only.
--    FORCE ROW LEVEL SECURITY is already on. Add service_role policy.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admin_secrets_service_role" ON public.admin_secrets;

CREATE POLICY "admin_secrets_service_role"
  ON public.admin_secrets
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. ADMIN_PRINCIPALS — admin session table. service_role only.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admin_principals_service_role" ON public.admin_principals;

CREATE POLICY "admin_principals_service_role"
  ON public.admin_principals
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Ensure RLS is ENABLED (FORCE) on all priority tables
--     Most are already enabled; this is idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.users               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_vectors        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.usage_logs          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.salary_data         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_secrets       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_principals    FORCE ROW LEVEL SECURITY;

COMMIT;