-- =============================================================================
-- Migration: 20260519000001_fix_handle_new_user_trigger.sql
--
-- BUG FIX: "Database error saving new user" on OAuth login
--
-- Root cause
-- ----------
-- The trigger on_auth_user_created fires AFTER INSERT on auth.users whenever
-- a new user signs up (email or OAuth). It calls public.handle_new_user(),
-- which inserts a row into public.profiles.
--
-- The original function has two problems:
--
--   1. No EXCEPTION handling.
--      Any error inside the trigger body (constraint violation, RLS rejection,
--      schema mismatch, etc.) propagates unhandled back to GoTrue, which wraps
--      it as "Database error saving new user" and aborts the entire auth.users
--      INSERT. The user is never created; the OAuth callback gets
--      ?error=server_error&error_code=unexpected_failure back.
--
--   2. Missing SET search_path.
--      SECURITY DEFINER functions without a pinned search_path are vulnerable
--      to search_path injection. Supabase also flags this as a linter warning.
--      In edge cases (e.g. supabase_admin role with a different search_path),
--      the unqualified table reference "profiles" can fail to resolve.
--
-- The public.profiles table is also a *legacy* stub — the app reads and writes
-- exclusively from public.users and public.user_profiles (seeded on first login
-- via the seed_user_and_profile RPC in user.registration.service.js). The
-- trigger insert into public.profiles serves no runtime purpose for the app.
--
-- Fix
-- ---
-- Replace handle_new_user() with a hardened version that:
--   • Pins SET search_path TO 'public' (security + reliability).
--   • Wraps the insert in EXCEPTION WHEN OTHERS … so that any failure is
--     logged (pg_log) but does NOT propagate — GoTrue completes the
--     auth.users insert successfully regardless of what happens in the trigger.
--   • Keeps the public.profiles insert intact (existing data contract).
--
-- Effect on auth flow
-- -------------------
-- After this migration:
--   OAuth callback → GoTrue inserts auth.users → trigger fires → profiles
--   insert may silently no-op on conflict or log a warning on other errors,
--   but auth.users row is ALWAYS committed → SIGNED_IN event fires in the
--   browser → /auth/callback redirects to / → app works.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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

EXCEPTION
  WHEN OTHERS THEN
    -- Log the error for observability but do NOT re-raise.
    -- Raising here would abort the auth.users INSERT (GoTrue rolls back
    -- the whole transaction and returns "Database error saving new user").
    -- Swallowing the exception lets auth proceed; the app seeds the real
    -- user rows (public.users + public.user_profiles) on first /app-entry
    -- call via the seed_user_and_profile RPC.
    RAISE WARNING '[handle_new_user] Non-fatal error seeding public.profiles for user %: % (SQLSTATE: %)',
      NEW.id, SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$$;
