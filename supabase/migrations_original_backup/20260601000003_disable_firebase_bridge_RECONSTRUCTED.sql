-- =============================================================================
-- HireRise Phase 1.6 Sprint 1
-- Migration: 20260601000003_disable_firebase_bridge.sql
--
-- FIREBASE IDENTITY BRIDGE — SAFE DEPRECATION
--
-- RECONSTRUCTION BASIS:
--   000004 lists this as a required predecessor in its header.
--   000004 itself contains no direct references to firebase_uid,
--   sync_firebase_uid_bridge, or uid_from_firebase. The bridge objects
--   are not dependencies of any code path in 000004.
--
-- BEHAVIOUR ON A CLEAN SUPABASE PROJECT:
--   On a clean project there are no Firebase bridge objects to disable.
--   All operations in this migration are guarded with IF EXISTS / DO blocks
--   so the migration is a safe no-op. It records itself in the migration
--   history, satisfying the dependency chain, and exits cleanly.
--
-- BEHAVIOUR ON A LEGACY PROJECT (Firebase migration history):
--   If the project previously used Firebase Auth and has:
--     - user_profiles.firebase_uid  column
--     - sync_firebase_uid_bridge()  trigger function
--     - trg_up_sync_firebase_uid    trigger
--     - uid_from_firebase()         lookup function
--   This migration disables them safely without destructive removal.
--   Full removal is deferred to Sprint 2 after confirming zero Firebase traffic.
--
-- SAFETY GUARANTEES:
--   1. No DROP TABLE, DROP COLUMN, or DROP FUNCTION on objects that may
--      still be referenced by application code in active sessions.
--   2. sync_firebase_uid_bridge() is replaced with a no-op (trigger stays bound).
--   3. uid_from_firebase() raises a hard exception to surface any stale callers.
--   4. firebase_uid column is deprecated via COMMENT only.
--   5. All operations are idempotent (CREATE OR REPLACE, IF EXISTS guards).
--
-- ROLLBACK: See inline ROLLBACK section at end of file (not executed here).
-- =============================================================================

BEGIN;

-- =============================================================================
-- PRE-FLIGHT CHECK
-- Count any users with firebase_uid != uid. Log as WARNING if found.
-- Does not abort — DBA should review before production deploy on legacy projects.
-- On a clean project, user_profiles may not exist; the DO block handles both cases.
-- =============================================================================

DO $$
DECLARE
  v_has_firebase_column   boolean := false;
  v_has_user_profiles     boolean := false;
  v_divergent_count       integer := 0;
  v_null_uid_count        integer := 0;
BEGIN
  -- Check if user_profiles table exists at all
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
  ) INTO v_has_user_profiles;

  IF NOT v_has_user_profiles THEN
    RAISE NOTICE 'FIREBASE BRIDGE PRE-FLIGHT: user_profiles table does not exist. '
                 'This is a clean Supabase project. No Firebase bridge to disable.';
    RETURN;
  END IF;

  -- Check if firebase_uid column exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'user_profiles'
      AND column_name  = 'firebase_uid'
  ) INTO v_has_firebase_column;

  IF NOT v_has_firebase_column THEN
    RAISE NOTICE 'FIREBASE BRIDGE PRE-FLIGHT: firebase_uid column does not exist on user_profiles. '
                 'No Firebase bridge to disable. Migration is a no-op.';
    RETURN;
  END IF;

  -- Count divergent UIDs
  EXECUTE '
    SELECT COUNT(*) FROM public.user_profiles
    WHERE firebase_uid IS NOT NULL
      AND uid IS NOT NULL
      AND firebase_uid != uid
  ' INTO v_divergent_count;

  EXECUTE '
    SELECT COUNT(*) FROM public.user_profiles
    WHERE uid IS NULL AND firebase_uid IS NOT NULL
  ' INTO v_null_uid_count;

  IF v_divergent_count > 0 THEN
    RAISE WARNING
      'FIREBASE BRIDGE PRE-FLIGHT: % user_profiles row(s) have firebase_uid != uid. '
      'These users may be affected by bridge disablement. '
      'Review before production deployment. '
      'Query: SELECT id, uid, firebase_uid FROM user_profiles WHERE firebase_uid != uid AND uid IS NOT NULL',
      v_divergent_count;
  END IF;

  IF v_null_uid_count > 0 THEN
    RAISE WARNING
      'FIREBASE BRIDGE PRE-FLIGHT: % user_profiles row(s) have uid IS NULL with '
      'non-null firebase_uid. These rows have no Supabase UUID identity. '
      'Investigate before Sprint 2 bridge removal.',
      v_null_uid_count;
  END IF;

  IF v_divergent_count = 0 AND v_null_uid_count = 0 THEN
    RAISE NOTICE 'FIREBASE BRIDGE PRE-FLIGHT: No divergent UIDs found. Safe to proceed.';
  END IF;
END;
$$;

-- =============================================================================
-- STEP 1: Replace sync_firebase_uid_bridge() with a no-op
-- Only executed if the function exists (legacy project guard).
-- On clean projects: this block is a no-op.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'sync_firebase_uid_bridge'
  ) THEN
    -- Replace with no-op. Trigger binding is preserved.
    -- Sprint 2 will DROP both the trigger and this function.
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION public.sync_firebase_uid_bridge()
      RETURNS trigger LANGUAGE plpgsql AS $inner$
      BEGIN
        RAISE DEBUG
          'sync_firebase_uid_bridge: DISABLED (Phase 1.6 Sprint 1). '
          'Firebase identity bridge is a no-op. firebase_uid=%, uid=%',
          NEW.firebase_uid, NEW.uid;
        RETURN NEW;
      END;
      $inner$
    $func$;

    COMMENT ON FUNCTION public.sync_firebase_uid_bridge() IS
      'DEPRECATED — Phase 1.6 Sprint 1. '
      'Firebase identity bridge function replaced with no-op. '
      'Trigger trg_up_sync_firebase_uid remains bound but is now effectively disabled. '
      'Scheduled for DROP in Sprint 2. DO NOT call from new code.';

    RAISE NOTICE 'sync_firebase_uid_bridge(): replaced with no-op.';
  ELSE
    RAISE NOTICE 'sync_firebase_uid_bridge(): function does not exist — clean project, no action needed.';
  END IF;
END;
$$;

-- =============================================================================
-- STEP 2: Replace uid_from_firebase() with a hard exception
-- Any caller of this function is using the deprecated Firebase lookup path.
-- Surfacing an error is preferable to silently returning stale data.
-- Only executed if the function exists.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'uid_from_firebase'
  ) THEN
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION public.uid_from_firebase(p_firebase_uid text)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $inner$
      BEGIN
        RAISE EXCEPTION
          'uid_from_firebase() has been disabled in Phase 1.6 Sprint 1. '
          'All code must use Supabase native auth.uid() (uuid) identity. '
          'Attempted lookup for firebase_uid: %. '
          'See migration 20260601000003_disable_firebase_bridge.sql.',
          p_firebase_uid;
      END;
      $inner$
    $func$;

    -- Revoke EXECUTE from all roles
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.uid_from_firebase(text) FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.uid_from_firebase(text) FROM anon';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.uid_from_firebase(text) FROM authenticated';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.uid_from_firebase(text) FROM service_role';

    COMMENT ON FUNCTION public.uid_from_firebase(text) IS
      'DEPRECATED — Phase 1.6 Sprint 1. NOW RAISES AN EXCEPTION. '
      'Firebase UID lookup function. All callers must migrate to auth.uid() (uuid). '
      'Scheduled for DROP in Sprint 2.';

    RAISE NOTICE 'uid_from_firebase(): replaced with exception-raising stub. EXECUTE revoked from all roles.';
  ELSE
    RAISE NOTICE 'uid_from_firebase(): function does not exist — clean project, no action needed.';
  END IF;
END;
$$;

-- =============================================================================
-- STEP 3: Deprecate firebase_uid column via COMMENT
-- Column is NOT dropped here. Sprint 2 drops it after confirming zero traffic.
-- Only executed if the column exists.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'user_profiles'
      AND column_name  = 'firebase_uid'
  ) THEN
    EXECUTE $func$
      COMMENT ON COLUMN public.user_profiles.firebase_uid IS
        'DEPRECATED — Phase 1.6 Sprint 1. '
        'Firebase UID bridge column. Will be dropped in Sprint 2. '
        'DO NOT write to this column from new code. '
        'Use auth.uid() (uuid) for all identity operations.'
    $func$;
    RAISE NOTICE 'user_profiles.firebase_uid: deprecation comment applied.';
  ELSE
    RAISE NOTICE 'user_profiles.firebase_uid: column does not exist — clean project, no action needed.';
  END IF;
END;
$$;

-- =============================================================================
-- STEP 4: Record migration completion notice
-- =============================================================================

DO $$
BEGIN
  RAISE NOTICE
    'Migration 20260601000003_disable_firebase_bridge completed. '
    'Firebase bridge objects disabled or confirmed absent. '
    'Full removal scheduled for Sprint 2 migration '
    '20260615000001_remove_firebase_bridge.sql.';
END;
$$;

COMMIT;

-- =============================================================================
-- ROLLBACK PROCEDURE (manual — NOT executed here)
-- Run this block manually if Sprint 1 deployment reveals Firebase auth issues.
-- =============================================================================
--
-- BEGIN;
--
-- -- Restore sync_firebase_uid_bridge() to original behaviour
-- CREATE OR REPLACE FUNCTION public.sync_firebase_uid_bridge()
-- RETURNS trigger LANGUAGE plpgsql AS $$
-- BEGIN
--   IF NEW.firebase_uid IS NOT NULL THEN
--     NEW.uid = NEW.firebase_uid;
--   ELSIF NEW.uid IS NOT NULL THEN
--     NEW.firebase_uid = NEW.uid;
--   END IF;
--   RETURN NEW;
-- END;
-- $$;
--
-- -- Restore uid_from_firebase() to original behaviour
-- CREATE OR REPLACE FUNCTION public.uid_from_firebase(p_firebase_uid text)
-- RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
--   SELECT id FROM public.user_profiles WHERE firebase_uid = p_firebase_uid LIMIT 1;
-- $$;
-- GRANT EXECUTE ON FUNCTION public.uid_from_firebase(text) TO service_role;
--
-- -- Remove deprecation comment from firebase_uid column
-- COMMENT ON COLUMN public.user_profiles.firebase_uid IS NULL;
--
-- COMMIT;
-- =============================================================================
