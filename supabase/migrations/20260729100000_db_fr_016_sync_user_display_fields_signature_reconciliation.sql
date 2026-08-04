-- =============================================================================
-- DB-FR-016 — sync_user_display_fields RPC Signature Reconciliation
-- =============================================================================
--
-- Scope: public.sync_user_display_fields() only.
--
-- Certified investigation: WP-DB-FR-015 — sync_user_display_fields RPC
-- Signature Reconciliation. That investigation established:
--   - 000_initial_schema.sql defines sync_user_display_fields(p_user_id uuid,
--     p_display_name text, p_photo_url text). Its body writes to both
--     public.users (id uuid) and public.user_profiles (id text, via an
--     explicit ::text cast).
--   - 202604130004_indexes_and_rpcs.sql ("PATCH 31 | FILE 5 OF 5 — Delta-safe
--     indexes + RPC compatibility — Phase 0 reconciled") later defines
--     sync_user_display_fields(p_user_id text, p_display_name text,
--     p_photo_url text) under its own section header "TEXT identity + JSONB
--     return preserved". Its body writes only to public.user_profiles
--     (id text — no cast needed), matching the canonical target table's real
--     column type and the sibling seed_user_and_profile RPC's already-
--     certified move away from RPC-driven public.users writes (WP-AUTH-03 §3).
--   - CREATE OR REPLACE FUNCTION cannot change a parameter's type, so the
--     202604130004 statement did not replace the uuid-typed original — it
--     created a second overload alongside it. Both have coexisted in every
--     schema snapshot examined since.
--   - PostgREST cannot resolve which overload a call to
--     sync_user_display_fields is meant to invoke and returns PGRST203.
--
-- This is the same defect shape already certified and fixed twice in this
-- program — DB-FR-003 (public.claim_job) and DB-FR-008 (replace_career_
-- predictions / replace_career_simulations / replace_education_roi) — and
-- the same resolution is applied here: the obsolete uuid-typed overload is
-- DROPped explicitly by its exact signature; the text-typed overload
-- (public.user_profiles.id's actual type, and the shape
-- user.registration.service.js's "Patch 32" syncProfileDisplayFields() was
-- built and shipped against) is left exactly as-is and additionally
-- certified with a COMMENT ON FUNCTION.
--
-- Sole application caller: core/src/modules/user/user.registration.service.js,
-- syncProfileDisplayFields() → safeRpc('sync_user_display_fields', {
-- p_user_id: userId, p_display_name, p_photo_url }, userId), invoked only
-- from GET /app-entry (core/src/modules/appEntry/appEntry.route.js), where
-- userId is always a plain JS string. This migration removes the ambiguous
-- uuid overload and leaves that call path fully intact against the
-- remaining text overload — no application code change is required or made.
--
-- No table, column, RLS policy, grant, ownership, SECURITY DEFINER setting,
-- or application code is touched. No new capability is introduced. Behavior
-- of the surviving text overload is byte-for-byte unchanged from
-- 202604130004_indexes_and_rpcs.sql.
--
-- Replay-safety: DROP FUNCTION IF EXISTS is idempotent; COMMENT ON is
-- idempotent (overwrite). Safe to re-run.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. sync_user_display_fields — drop obsolete uuid overload
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS "public"."sync_user_display_fields"("p_user_id" "uuid", "p_display_name" "text", "p_photo_url" "text");

COMMENT ON FUNCTION "public"."sync_user_display_fields"("p_user_id" "text", "p_display_name" "text", "p_photo_url" "text") IS
'DB-FR-016: certified as the sole surviving overload. public.user_profiles.id is, and always has been, '
'text — this overload''s parameter type already matched the canonical schema and required no change. A '
'second, uuid-typed overload existed alongside it since 000_initial_schema.sql (it additionally wrote to '
'public.users, a responsibility later moved to GET /me''s inline upsert per WP-AUTH-03); PostgREST could '
'not resolve which overload a call was meant to invoke (PGRST203). It has been dropped by this migration '
'(same defect shape, same resolution, as DB-FR-003''s public.claim_job fix and DB-FR-008''s career-'
'replacement functions fix). Sole caller: user.registration.service.js syncProfileDisplayFields(), called '
'from GET /app-entry, where p_user_id is always a plain string — this overload''s signature and behavior '
'are unchanged.';

COMMIT;
