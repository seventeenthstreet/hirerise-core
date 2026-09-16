-- 20260908030000_payg_phase2_credit_snapshot.sql
--
-- PAYG PHASE 2 — Decision A: Purchased credit entitlement is snapshotted
--
-- Scope: ONE additive column on payg_payments, ONE trigger function, ONE
-- trigger. Does NOT modify, replace, or touch record_payg_payment_event
-- in any way (frozen — see 20260907010000 / 20260908010000 /
-- 20260908020000). Does NOT modify payg_packages, payg_payment_events,
-- credit_ledger, users, or any subscription object.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY A TRIGGER, NOT A CHANGE TO record_payg_payment_event
-- ═════════════════════════════════════════════════════════════════════════
--
-- The controlling prompt requires the purchased-credit snapshot to be
-- captured "at the safest point in the existing PAYG flow" without
-- reopening the frozen Phase 1 RPC. record_payg_payment_event is the only
-- code path that ever INSERTs a payg_payments row (verified: `grep -rn
-- "INSERT INTO public.payg_payments\|insert into.*payg_payments"` across
-- the repo returns exactly one hit, inside that function). Editing that
-- function's body, return type, or signature is explicitly forbidden by
-- the controlling prompt (§2) and is a STOP condition (§20.4) if required.
--
-- A BEFORE INSERT trigger on payg_payments is therefore the correct,
-- minimal mechanism: it fires at exactly the same moment
-- record_payg_payment_event creates the row (the "point of confirmation
-- of a real, provider-validated payment row" — actually the point of
-- FIRST ROW CREATION, which happens once per real payment regardless of
-- what status it starts in), without adding one line to that function's
-- body, changing its RETURNS TABLE shape, or touching its security
-- attributes. This is purely additive: record_payg_payment_event's
-- INSERT statement does not reference this column at all; Postgres fills
-- it via the trigger, exactly the same way `created_at DEFAULT now()`
-- already works today without record_payg_payment_event naming that
-- column either.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY THIS IS SAFE FOR HISTORICAL ROWS (Stop Condition #1 — resolved,
-- not bypassed)
-- ═════════════════════════════════════════════════════════════════════════
--
-- The controlling prompt requires STOPPING, not guessing, if existing
-- non-test payg_payments rows lack a safe snapshot path. Repository
-- evidence resolves this cleanly rather than requiring a product
-- decision:
--
--   1. payg_payments.package_id carries a NOT NULL, ON DELETE RESTRICT
--      foreign key to payg_packages(id) (20260907010000, §3). No row can
--      exist in payg_payments referencing a package_id that is not
--      already a real row in payg_packages.
--   2. payg_packages was created SCHEMA-ONLY. Migration
--      20260907010000's own header states explicitly: "No package rows
--      are seeded — populating real packages ... is a product decision
--      pending approval" and "Until packages exist, all PAYG payment
--      attempts fail closed at package resolution."
--   3. Grep-verified: no migration and no seed file in this repository
--      (`supabase/migrations/`, `supabase/seed/`) ever INSERTs a row into
--      payg_packages. The package catalog has zero rows in every
--      environment this schema has been applied to.
--
-- Therefore it is architecturally impossible for payg_payments to
-- contain ANY row — test or real — anywhere this migration set has been
-- applied: the FK in (1) would reject it given (2)+(3). This migration's
-- backfill question is consequently moot, not skipped: there is nothing
-- to backfill. If this conclusion is ever falsified in a real deployment
-- target (i.e. payg_packages unexpectedly already has rows and
-- payg_payments is non-empty there), the DO block below fails loudly
-- with an explicit exception rather than silently proceeding, so this
-- is verified at apply-time, not merely asserted here in a comment.
--
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ---------------------------------------------------------------------
-- Runtime verification of the "zero existing rows" claim above. If this
-- ever fires, STOP: do not let this migration silently backfill/guess a
-- snapshot for a real historical payment. This is intentionally an
-- unconditional hard failure, not a warning.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_existing_count bigint;
BEGIN
  SELECT count(*) INTO v_existing_count FROM public.payg_payments;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION
      'PAYG PHASE 2 SNAPSHOT MIGRATION STOP: % existing payg_payments row(s) '
      'found. This migration assumed (and the Phase 1 migration record '
      'confirms) that payg_packages has never been seeded, making '
      'payg_payments provably empty. That assumption is false in this '
      'environment. Do NOT proceed with an automatic backfill — this is '
      'a product/engineering decision (controlling prompt Stop Condition '
      '#1) and must be resolved explicitly before this migration is '
      'applied here.', v_existing_count
      USING ERRCODE = 'assert_failure';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. IMMUTABLE PURCHASED-CREDIT SNAPSHOT COLUMN
-- ═════════════════════════════════════════════════════════════════════════
--
-- Type matches the two values it must always agree with: payg_packages.
-- credits (integer) and credit_ledger.amount / users.ai_credits_remaining
-- (both integer). Nullable at the column-constraint level only because
-- Postgres requires a column to exist before a BEFORE INSERT trigger can
-- populate it on the same statement — every row inserted after this
-- migration will always have it filled in by the trigger below or the
-- INSERT will be rejected. The grant function (next migration) treats a
-- NULL/non-positive snapshot as a hard validation failure and never
-- grants against it, so there is no path by which a NULL snapshot can
-- ever produce a credit grant.

ALTER TABLE "public"."payg_payments"
    ADD COLUMN IF NOT EXISTS "package_credits_snapshot" integer;

DO $$
BEGIN
    ALTER TABLE "public"."payg_payments"
        DROP CONSTRAINT IF EXISTS "payg_payments_package_credits_snapshot_check";
    ALTER TABLE "public"."payg_payments"
        ADD CONSTRAINT "payg_payments_package_credits_snapshot_check"
        CHECK ("package_credits_snapshot" IS NULL OR "package_credits_snapshot" > 0);
END $$;

COMMENT ON COLUMN "public"."payg_payments"."package_credits_snapshot" IS
    'PAYG Phase 2 (Decision A): immutable purchased-credit entitlement, '
    'captured once at payment-row creation time by '
    'payg_payments_snapshot_credits_trg (see trigger below), from '
    'payg_packages.credits as it existed at that moment. Never '
    'recalculated, never overwritten by later package price/credit '
    'changes, never touched by record_payg_payment_event''s status-'
    'transition UPDATE (that statement does not reference this column). '
    'public.grant_payg_credits() reads ONLY this column for entitlement — '
    'never live payg_packages.credits — so a later change to a package''s '
    'credit quantity can never alter what an already-purchased payment '
    'grants.';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. CAPTURE TRIGGER — fires at payment-row creation, not on transitions
-- ═════════════════════════════════════════════════════════════════════════
--
-- BEFORE INSERT only (never BEFORE UPDATE): a payment row is created
-- exactly once (record_payg_payment_event's INSERT ... ON CONFLICT DO
-- NOTHING path); every subsequent state transition is an UPDATE that
-- only ever touches status/updated_at/confirmed_at (verified in
-- 20260907010000's function body). This trigger never runs on those
-- UPDATEs, so it can never re-snapshot or silently change an existing
-- payment's entitlement after the fact.
--
-- Defensive `WHEN (NEW.package_credits_snapshot IS NULL)` guard: if a
-- future, separately-reviewed change ever supplies this column
-- explicitly on INSERT, that explicit value is respected and the
-- trigger is a no-op — it only ever fills in a gap, never overwrites a
-- caller-supplied value.

CREATE OR REPLACE FUNCTION "public"."payg_payments_snapshot_credits"()
    RETURNS trigger
    LANGUAGE "plpgsql"
    SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_credits integer;
BEGIN
    SELECT "credits" INTO v_credits
    FROM public.payg_packages
    WHERE "id" = NEW."package_id";

    IF v_credits IS NULL THEN
        -- The FK on payg_payments.package_id already guarantees the
        -- package row exists; this guards only against a NULL `credits`
        -- value, which the payg_packages schema does not currently
        -- allow (NOT NULL, > 0 check) but is checked defensively rather
        -- than assumed.
        RAISE EXCEPTION
            'PAYG_SNAPSHOT_FAILED: package % has no usable credits value for payment snapshot',
            NEW."package_id"
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    NEW."package_credits_snapshot" := v_credits;
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."payg_payments_snapshot_credits"() OWNER TO "postgres";

-- This function is only ever invoked by the trigger below, as the
-- inserting role (service_role, via record_payg_payment_event's
-- SECURITY DEFINER context) — it is not, and must not be, directly
-- callable.
REVOKE ALL ON FUNCTION "public"."payg_payments_snapshot_credits"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."payg_payments_snapshot_credits"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."payg_payments_snapshot_credits"() FROM "authenticated";

DROP TRIGGER IF EXISTS "payg_payments_snapshot_credits_trg" ON "public"."payg_payments";

CREATE TRIGGER "payg_payments_snapshot_credits_trg"
    BEFORE INSERT ON "public"."payg_payments"
    FOR EACH ROW
    WHEN (NEW."package_credits_snapshot" IS NULL)
    EXECUTE FUNCTION "public"."payg_payments_snapshot_credits"();

COMMIT;
