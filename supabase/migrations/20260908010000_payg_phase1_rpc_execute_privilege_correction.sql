-- 20260908010000_payg_phase1_rpc_execute_privilege_correction.sql
--
-- PAYG Phase 1 — RPC Execution Privilege Security Correction
--
-- Scope: THIS MIGRATION CHANGES ONLY EXECUTE PRIVILEGES ON ONE FUNCTION.
-- It does not touch any table, column, constraint, index, RLS policy,
-- or the function's business logic/definition in any way.
--
-- Problem (remote verification finding): public.record_payg_payment_event
-- is SECURITY DEFINER, so its EXECUTE privilege IS the security boundary
-- (it runs with the definer's — postgres's — full rights regardless of
-- caller). Remote inspection found EXECUTE granted to anon, authenticated,
-- postgres, and service_role. anon/authenticated must never be able to
-- call it directly (they should never even hold a Supabase session
-- capable of invoking backend-only RPCs, but PostgreSQL's own default
-- of granting EXECUTE to PUBLIC on function creation is exactly how this
-- happened, and privilege state must not depend on client-side
-- assumptions never being violated).
--
-- Fix: explicitly REVOKE EXECUTE FROM PUBLIC (not just anon/authenticated
-- individually — PUBLIC is the actual grantee Postgres records by
-- default, and revoking only the two named roles would leave PUBLIC's
-- grant in place, which a currently-unlisted future role could inherit),
-- then explicitly GRANT EXECUTE TO service_role, the intended caller
-- (see src/services/billing/paygPayment.service.js).
--
-- Signature-qualified exactly as deployed (10 positional args) so this
-- cannot accidentally target a different overload. No overload exists —
-- this is the only record_payg_payment_event function in the schema.
--
-- Does NOT touch: SECURITY DEFINER, owner, search_path, return type,
-- function body, payg_payments, payg_payment_events, payg_packages, or
-- any other object. Does NOT grant EXECUTE to anon, authenticated, or
-- any other application role. Does NOT add a client-facing route.

BEGIN;

REVOKE EXECUTE ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM "anon";

REVOKE EXECUTE ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) FROM "authenticated";

GRANT EXECUTE ON FUNCTION "public"."record_payg_payment_event"(
    text, text, text, uuid, text, numeric, text, text, timestamp with time zone, jsonb
) TO "service_role";

COMMIT;
