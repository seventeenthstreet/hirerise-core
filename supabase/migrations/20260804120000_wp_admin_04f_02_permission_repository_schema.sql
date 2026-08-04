-- WP-ADMIN-04F-02 — Enterprise Permission Repository
--
-- Persistence table backing src/domain/permission/repository/*.
-- Additive only. Does not modify any existing table.
--
-- SCOPE NOTE: this migration introduces storage for the Permission entity
-- (AUTH-01 §3.2) only. It intentionally does NOT encode:
--   - enum CHECK constraints mirroring the Resource/Action/Status
--     vocabularies (AUTH-01 Shared Authorization Vocabulary, AUTH-02
--     Permission Capability Architecture) — those vocabularies are
--     governed and validated per AUTH-02 Permission Validation Capability
--     and are expected to evolve without a schema migration; duplicating
--     them here as CHECK constraints would create a second, driftable
--     source of truth for the same governed vocabulary.
--   - governance/lifecycle transition rules (Proposal, Review, Approval,
--     Publication, Adoption, Deprecation, Retirement — AUTH-04 §6) — those
--     belong to the future Permission Registry work package, per
--     WP-ADMIN-04F-02's explicit "Do NOT implement Registry / Governance"
--     boundary. This table only stores whatever status the domain layer
--     has already validated.
--   - permission assignment, evaluation, or multi-tenancy — out of scope
--     per the same work package boundary.

-- ─────────────────────────────────────────────────────────────────────────
-- permissions — one row per Permission (AUTH-01 §3.2). `name` is the
-- Permission's Stable Permission Identity (AUTH-04 §7): the unique
-- `${resource}:${action}` identifier assigned at proposal and never
-- reassigned thereafter. Per AUTH-04 §7, Permission Identity is immutable
-- once published — repository updates may change a Permission's metadata
-- (category, status, description) but must never change its Identity, so
-- `resource`/`action`/`name` are write-once from the repository's
-- perspective: nothing in this schema enforces that on its own (it is a
-- repository-layer contract, not a column constraint), but `name` being
-- UNIQUE and NOT NULL is what makes it usable as the lookup key the
-- repository's findByName()/existsByName() rely on, and the natural
-- conflict target for create().
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"        text NOT NULL,
    "resource"    text NOT NULL,
    "action"      text NOT NULL,
    "category"    text,
    "status"      text NOT NULL DEFAULT 'proposed',
    "description" text,
    "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "public"."permissions" OWNER TO "postgres";

ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_name_key" UNIQUE ("name");

COMMENT ON TABLE "public"."permissions" IS
    'WP-ADMIN-04F-02: persistence for the Permission domain entity (AUTH-01 §3.2). Pure storage — no governance, evaluation, or assignment logic. See src/domain/permission/repository/.';

-- Required lookups, per WP-ADMIN-04F-02 "Query Support": identifier,
-- resource, action, category, status.
CREATE INDEX IF NOT EXISTS "idx_permissions_resource"
    ON "public"."permissions" USING "btree" ("resource");
CREATE INDEX IF NOT EXISTS "idx_permissions_action"
    ON "public"."permissions" USING "btree" ("action");
CREATE INDEX IF NOT EXISTS "idx_permissions_category"
    ON "public"."permissions" USING "btree" ("category");
CREATE INDEX IF NOT EXISTS "idx_permissions_status"
    ON "public"."permissions" USING "btree" ("status");

-- Reuses the existing shared trigger function (already applied to
-- cms_skills, admin_principals, career_advice_results, etc. — see
-- 000_initial_schema.sql) rather than introducing a new one.
CREATE OR REPLACE TRIGGER "set_permissions_updated_at"
    BEFORE UPDATE ON "public"."permissions"
    FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();

-- RLS: enabled with no policies. This table has no direct client (no API
-- routes/UI are part of this work package — see WP-ADMIN-04F-02 "DO NOT
-- IMPLEMENT"), so it is reached only through the backend's service-role
-- Supabase client, which bypasses RLS. Mirrors the no-policy posture of
-- the recently-added admin_mfa_* tables (20260802010000_wp_admin_02c_mfa_totp_schema.sql)
-- rather than the older cms_* tables' anon/authenticated grants, since
-- this table — like admin_mfa_* — has no legitimate anon/authenticated
-- access path today.
ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."permissions" TO "service_role";
