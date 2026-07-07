-- ============================================================
-- HireRise Supabase Bootstrap SQL Fixes
-- ============================================================
-- Apply in the Supabase SQL Editor (Dashboard > SQL > New query)
-- or via supabase db push if using migrations.
--
-- PURPOSE:
--   1. Create the `profiles` table if missing
--   2. Fix/create the handle_new_user() trigger
--   3. Ensure correct RLS policies so authenticated users can
--      read and update their own profile
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. PROFILES TABLE (create if not exists)
-- ────────────────────────────────────────────────────────────
-- Adjust column types/names to match your actual schema.
-- This is the canonical shape expected by /api/v1/users/me.

CREATE TABLE IF NOT EXISTS public.profiles (
  id                               UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name                             TEXT,
  email                            TEXT,
  user_type                        TEXT        CHECK (user_type IN ('professional', 'student', 'market')),
  professional_onboarding_complete BOOLEAN     NOT NULL DEFAULT FALSE,
  student_onboarding_complete      BOOLEAN     NOT NULL DEFAULT FALSE,
  onboarding_completed             BOOLEAN     NOT NULL DEFAULT FALSE,
  resume_uploaded                  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- 2. RLS POLICIES
-- ────────────────────────────────────────────────────────────
-- Enable RLS — required for all Supabase tables in production.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Drop and recreate to ensure clean state (idempotent).

-- Users can SELECT their own profile row.
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own"
  ON public.profiles
  FOR SELECT
  USING (auth.uid() = id);

-- Users can INSERT their own profile row (used by handle_new_user).
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own"
  ON public.profiles
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Users can UPDATE their own profile row.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Service role bypasses RLS — the backend uses service-role key so these
-- policies only affect browser-side (anon key) queries.


-- ────────────────────────────────────────────────────────────
-- 3. UPDATED_AT TRIGGER FUNCTION
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ────────────────────────────────────────────────────────────
-- 4. handle_new_user() TRIGGER
-- ────────────────────────────────────────────────────────────
-- Automatically creates a minimal profiles row when a new auth.users
-- entry is created (email signup, Google OAuth, magic link, etc.).
--
-- ROOT CAUSE RISK:
--   If this trigger is missing or fails, new users have no profiles row.
--   /api/v1/users/me returns 404 → fetchUser() returns null → page.tsx
--   routes to /direction on every load even after onboarding completes.
--
-- SECURITY DEFINER: runs with the table owner's privileges, bypassing RLS
-- for the INSERT. This is required because the trigger fires in the context
-- of the auth schema, which has no RLS policy for profiles.
--
-- search_path is explicitly set to prevent search_path injection attacks.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  TEXT;
  v_email TEXT;
BEGIN
  -- Extract name from OAuth metadata (Google provides full_name).
  -- Falls back to the `name` key for other OAuth providers.
  v_name  := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    NULL
  );
  v_email := NEW.email;

  -- Insert minimal profile row. ON CONFLICT DO NOTHING prevents the trigger
  -- from failing if the row was somehow created by a concurrent request
  -- (e.g. the backend's ensureProfile() ran before the trigger).
  INSERT INTO public.profiles (id, name, email, created_at, updated_at)
  VALUES (NEW.id, v_name, v_email, NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but do NOT re-raise — a trigger failure that causes the
    -- auth.users INSERT to rollback would break the entire signup flow.
    -- The backend's ensureProfile() will create the row on the next request.
    RAISE WARNING '[handle_new_user] Profile creation failed for user %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$$;

-- Drop and recreate the trigger (idempotent).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ────────────────────────────────────────────────────────────
-- 5. VERIFY (run these SELECT queries to confirm setup)
-- ────────────────────────────────────────────────────────────

-- Check table exists:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'profiles';

-- Check RLS is on:
-- SELECT relname, relrowsecurity FROM pg_class
-- WHERE relname = 'profiles';

-- Check policies:
-- SELECT policyname, cmd FROM pg_policies
-- WHERE tablename = 'profiles';

-- Check trigger:
-- SELECT trigger_name, event_manipulation, event_object_table
-- FROM information_schema.triggers
-- WHERE trigger_name = 'on_auth_user_created';
