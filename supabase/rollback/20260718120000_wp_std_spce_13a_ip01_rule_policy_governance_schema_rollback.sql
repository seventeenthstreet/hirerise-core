-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback: 20260718120000_wp_std_spce_13a_ip01_rule_policy_governance_schema_rollback.sql
-- WP-STD-SPCE-13A — IP-01 — Rule & Policy Governance Schema (ROLLBACK)
--
-- PURPOSE:
--   Reverses 20260718120000_wp_std_spce_13a_ip01_rule_policy_governance_schema.sql
--   in full. Drops student_spce.rule_profiles, student_spce.
--   evaluation_policy_versions, and student_spce.rule_definitions (including
--   all rows, constraints, and auto-created indexes), drops every enum type
--   introduced by that migration, and drops the student_spce schema itself.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠  ROLLBACK SAFETY PRECONDITION — READ BEFORE EXECUTING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This rollback is SAFE only if no later IP has added a live dependency on
-- any of these three tables or on the student_spce schema. Specifically:
--
--   • IP-02 (Domain Types & Seed Data) — if fixture/seed data has been
--     inserted into any of these tables, this rollback removes it along with
--     the tables. That is expected and correct if IP-02 is being rolled back
--     together with IP-01; it is NOT correct to run this rollback while
--     keeping IP-02's code merged, since IP-02's seed scripts assume these
--     tables exist.
--   • IP-03 (Rule Registry Module) — if a Rule Registry module has been
--     built reading/writing student_spce.rule_definitions, roll back IP-03
--     first (its code, not its data — the module itself would simply fail
--     at runtime once these tables are gone, but its source files are a
--     separate rollback concern from this migration).
--   • Any later IP (IP-04–IP-13) — none of these tables are read directly by
--     any IP beyond IP-03/IP-04 (Rule Registry / Rule Evaluation Layer &
--     Discovery) per the dependency graph in WP-STD-SPCE-12 §4.1; rolling
--     back IP-01 implicitly invalidates every later IP's own preconditions
--     ("IP-0N merged" — WP-STD-SPCE-12 §2.2's milestone table), since IP-01
--     is the one package every other package's critical path depends on.
--
-- MANDATORY ROLLBACK ORDER when any later IP has been merged:
--   1. Roll back IP-13 down through IP-02, in strictly reverse dependency
--      order (WP-STD-SPCE-12 §4.1's dependency graph, reversed), since IP-01
--      blocks everything downstream per that same graph.
--   2. Then run this rollback.
--
-- This rollback does NOT touch:
--   • public.student_profile* (the Student Repository, WP-STD-SPCE-02 §3) —
--     never written to, referenced by FK, or otherwise touched by the
--     forward migration, so there is nothing to reverse here.
--   • The `governance` or `audit` schemas — entirely unrelated, untouched by
--     the forward migration.
--   • Any table outside the student_spce schema.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLES
-- Drop order: rule_profiles and evaluation_policy_versions first (neither is
-- referenced by a FOREIGN KEY from rule_definitions or vice versa — all three
-- tables are independent, no FK exists between them per the forward
-- migration — so drop order among the three is not itself load-bearing;
-- listed in reverse creation order for readability only).
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS student_spce.rule_profiles;
DROP TABLE IF EXISTS student_spce.evaluation_policy_versions;
DROP TABLE IF EXISTS student_spce.rule_definitions;


-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM TYPES
-- Safe to drop only after all three tables above are gone — an enum type
-- cannot be dropped while any column still has that type.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS student_spce.profile_lifecycle_stage_enum;
DROP TYPE IF EXISTS student_spce.policy_lifecycle_stage_enum;
DROP TYPE IF EXISTS student_spce.policy_precedence_level_enum;
DROP TYPE IF EXISTS student_spce.evaluation_policy_type_enum;
DROP TYPE IF EXISTS student_spce.rule_lifecycle_stage_enum;
DROP TYPE IF EXISTS student_spce.rule_output_type_enum;
DROP TYPE IF EXISTS student_spce.rule_severity_enum;
DROP TYPE IF EXISTS student_spce.rule_subdomain_enum;
DROP TYPE IF EXISTS student_spce.rule_category_enum;


-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA
-- Safe to drop only after every table and type above is gone. RESTRICT
-- (the default) is used deliberately, not CASCADE — if any object this
-- rollback does not know about has been created inside student_spce (for
-- example, by a later IP this rollback's safety precondition above warns
-- about), DROP SCHEMA will fail loudly rather than silently deleting
-- unrelated later work.
-- ─────────────────────────────────────────────────────────────────────────────

DROP SCHEMA IF EXISTS student_spce RESTRICT;

-- ─────────────────────────────────────────────────────────────────────────────
-- End of rollback.
-- ─────────────────────────────────────────────────────────────────────────────
