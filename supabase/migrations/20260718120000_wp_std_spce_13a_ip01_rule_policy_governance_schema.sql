-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260718120000_wp_std_spce_13a_ip01_rule_policy_governance_schema.sql
-- WP-STD-SPCE-13A — IP-01 — Rule & Policy Governance Schema
--
-- Implements the persistence layer WP-STD-SPCE-12 (§2.2, Milestone M1) requires
-- to exist before any later Student SPCE implementation package (IP-02–IP-13)
-- can proceed: `rule_definitions`, `evaluation_policy_versions`, and
-- `rule_profiles`. Per WP-STD-SPCE-12A (the repository audit this package is
-- built against), none of the three tables existed anywhere in the repository
-- prior to this migration — confirmed by a full-repository search of every
-- `.sql` file under `core/supabase/`.
--
-- DESIGN PRINCIPLES:
--   • Additive only — creates a new schema (`student_spce`) and three new
--     tables within it. No existing schema, table, column, enum, function, or
--     RLS policy is read, altered, or referenced. In particular, this
--     migration does not touch `public.student_profile*` (the Student
--     Repository's own tables, frozen per WP-STD-SPCE-02 §3/§18) or the
--     `governance`/`audit` schemas.
--   • Idempotent — table DDL uses CREATE TABLE IF NOT EXISTS; enum DDL uses
--     the DO $$ ... duplicate_object guard already established by the A10
--     governance migrations (e.g. 20260616000003); index DDL uses
--     CREATE INDEX/UNIQUE INDEX IF NOT EXISTS.
--   • No triggers, functions, GRANT statements, or RLS policies are created by
--     this migration — those are out of scope for IP-01 per WP-STD-SPCE-13A's
--     own "Do NOT implement" list (Rule Registry, Rule Evaluation, services,
--     controllers, routes are all later packages).
--   • Schema, not table-prefix, isolation. A new `student_spce` schema is used
--     (mirroring the existing `governance` and `audit` schema precedent in
--     this repository) rather than three `public`-schema tables, so that this
--     entirely-new domain's objects are trivially distinguishable from, and
--     never accidentally collide with, any existing or future `public` table.
--   • Enum value casing — a deliberate, documented deviation. Existing
--     governance migrations use SCREAMING_SNAKE_CASE enum values
--     (e.g. `APPROVE_RECOMMENDED`). This migration instead uses the exact
--     PascalCase string values already fixed as the certified vocabulary in
--     the architecture documents themselves (`Presence`, `Blocking`, `Draft`,
--     `Active`, and so on — WP-STD-SPCE-03 §7, WP-STD-SPCE-04 §3/§4/§6,
--     WP-STD-SPCE-09 §3.1/§6/§11, WP-STD-SPCE-05B §28.10). Traceability
--     between a stored value and the certified term it names was judged more
--     important than casing consistency with unrelated governance enums; see
--     "Known limitations" in the accompanying implementation summary.
--
-- SOURCE AUTHORITY:
--   WP-STD-SPCE-04 §3 (Rule Lifecycle), §4 (Rule Categories), §5 (Rule
--     Hierarchy), §6 (Rule Definition Model), §9 (Rule Dependencies),
--     §10 (Rule Versioning), §11 (Rule Policies).
--   WP-STD-SPCE-09 §3.1 (The Five Certified Policies), §4 (Policy
--     Responsibilities), §6 (Policy Precedence), §10 (Policy State),
--     §11 (Policy Lifecycle), §13 (Versioning).
--   WP-STD-SPCE-05A §28 (Rule Profiles), WP-STD-SPCE-05B §28.10 (Profile
--     Metadata), §28.11 (Conceptual Profile Composition).
--   WP-STD-SPCE-12 §3, IP-01 (this package's own charter and acceptance
--     criteria) and §2.2 Milestone M1.
--   WP-STD-SPCE-12A (Repository Integration Audit) — confirms no conflicting
--     or partial implementation exists.
--
--   No design decision below is made that is not already stated in one of the
--   documents above. Where a document explicitly defers a mechanism (e.g.
--   WP-STD-SPCE-04 §7: "storage mechanism... [is a] Phase H2 decision" — this
--   migration is that Phase H2 decision for storage only, not for the Rule
--   Registry's query/discovery behavior, which remains IP-03's scope), this
--   migration implements only the storage shape, never the deferred behavior.
--
-- LOCATION: core/supabase/migrations/
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA: student_spce
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS student_spce;

COMMENT ON SCHEMA student_spce IS
  'Student Smart Profile Completion Engine (Student SPCE) — governance schema for rule and policy definitions. Introduced by WP-STD-SPCE-13A / IP-01. Reads nothing from and writes nothing to any other schema; the Student Repository (public.student_profile*, per WP-STD-SPCE-02 §3) is read-only input to code that will be added in later IPs, never a dependency of this schema itself.';


-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM TYPES
-- Shared enumerations used by rule_definitions, evaluation_policy_versions,
-- and rule_profiles. Values are the exact certified vocabulary strings.
--
-- CONTRACT: Append-only. Never remove or rename a value once any row may
-- reference it — a governed enum in this schema follows the same
-- forward-only discipline WP-STD-SPCE-04 §10 fixes for rule versions
-- themselves. Adding a new value (e.g. a "Future Category" becoming a named
-- category) is a later work package's amendment, not a rewrite of this file.
-- ─────────────────────────────────────────────────────────────────────────────

-- WP-STD-SPCE-04 §4 — Rule Categories (eight-value taxonomy).
DO $$ BEGIN
  CREATE TYPE student_spce.rule_category_enum AS ENUM (
    'Presence',
    'Completeness',
    'Consistency',
    'Quality',
    'Evidence',
    'Eligibility',
    'Guidance',
    'FutureCategory'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-02 §5.3 / WP-STD-SPCE-03 §5 — the five certified subdomains.
-- NULL is used at the column level (not a sixth enum value) for a
-- Cross-section Rule, which has no single subdomain (WP-STD-SPCE-04 §6).
DO $$ BEGIN
  CREATE TYPE student_spce.rule_subdomain_enum AS ENUM (
    'Academic',
    'Activities',
    'Achievements',
    'Assessments',
    'CareerAspirations'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-04 §6 — Rule Definition Model, `severity` field.
DO $$ BEGIN
  CREATE TYPE student_spce.rule_severity_enum AS ENUM (
    'Blocking',
    'Advisory'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-04 §6 — Rule Definition Model, `outputType` field.
DO $$ BEGIN
  CREATE TYPE student_spce.rule_output_type_enum AS ENUM (
    'Pass',
    'Fail',
    'Skipped',
    'NotApplicable',
    'Deferred'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-04 §3 — Rule Lifecycle (five stages, single forward path).
DO $$ BEGIN
  CREATE TYPE student_spce.rule_lifecycle_stage_enum AS ENUM (
    'Draft',
    'Registered',
    'Active',
    'Deprecated',
    'Archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-09 §3.1 — The Five Certified Policies.
DO $$ BEGIN
  CREATE TYPE student_spce.evaluation_policy_type_enum AS ENUM (
    'RequiredField',
    'RecommendedField',
    'Scoring',
    'Confidence',
    'Eligibility'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-09 §6 — Policy Precedence (six levels; level 6, Resolved
-- Runtime Policy, is a per-run computed output, never a stored source row,
-- and is therefore intentionally excluded from this stored enum).
DO $$ BEGIN
  CREATE TYPE student_spce.policy_precedence_level_enum AS ENUM (
    'Global',
    'Domain',
    'Capability',
    'ConsumerProfile',
    'EvaluationContext'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-09 §11 — Policy Lifecycle. Only the five governance-lifecycle
-- stages a policy *version* passes through are modeled (Resolution and
-- Consumption are explicitly named as per-run operational acts, not
-- lifecycle stages a stored row occupies — §11's own disambiguation).
DO $$ BEGIN
  CREATE TYPE student_spce.policy_lifecycle_stage_enum AS ENUM (
    'Draft',
    'Publication',
    'Activation',
    'Deprecation',
    'Retirement'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WP-STD-SPCE-05B §28.10 — Profile Lifecycle. Same five stage *names* as the
-- Rule Lifecycle but a deliberately distinct enum type, because §28.10 is
-- explicit that "this lifecycle governs Profiles only" and is never a
-- substitute for, nor derived from, any referenced rule's own lifecycle.
DO $$ BEGIN
  CREATE TYPE student_spce.profile_lifecycle_stage_enum AS ENUM (
    'Draft',
    'Registered',
    'Active',
    'Deprecated',
    'Archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_spce.rule_definitions
-- WP-STD-SPCE-04 §6 (Rule Definition Model), §3 (Lifecycle), §5 (Hierarchy),
-- §9 (Dependencies), §10 (Versioning), §11 (Policy binding).
--
-- One row per (rule_id, version) — WP-STD-SPCE-04 §5's Rule Version level.
-- `rule_id`, `category`, and `output_types` are the rule's identity and
-- evaluation-time contract; §10 fixes that changing any of these across
-- versions is definitionally a new rule, never a version of the old one.
-- This migration cannot enforce that cross-version invariant with a single-
-- row CHECK constraint (it is a property of the set of rows sharing a
-- `rule_id`, not of any one row) — it is application-enforced, exactly as
-- several invariants in the existing A10 governance migrations are
-- documented as application-enforced rather than trigger-enforced (see
-- `governance.review_assignments`'s "Immutable after review_completed_at"
-- note, 20260616000003).
--
-- OWNERSHIP (per WP-STD-SPCE-04 §7/§18 — deferred to a later IP):
--   Write (INSERT/UPDATE): the Rule Registry module (IP-03) exclusively, once
--   built. No GRANT statements are issued by this migration — access control
--   is explicitly out of IP-01's scope.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_spce.rule_definitions (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),

  -- Identity (WP-STD-SPCE-04 §6) — stable across every version of this rule.
  rule_id                     text        NOT NULL,
  version                     integer     NOT NULL DEFAULT 1,

  -- Hierarchy (WP-STD-SPCE-04 §5) — organizational, not itself a runtime
  -- object the Rule Evaluation Layer consumes.
  rule_family                 text        NOT NULL,
  rule_group                  text        NOT NULL,

  -- Descriptive fields (WP-STD-SPCE-04 §6).
  display_name                text        NOT NULL,
  description                 text        NOT NULL,

  -- Evaluation-time contract (WP-STD-SPCE-04 §6's "four fields the Rule
  -- Evaluation Layer actually consumes": ruleId, subdomain, category,
  -- severity).
  category                    student_spce.rule_category_enum NOT NULL,
  subdomain                   student_spce.rule_subdomain_enum NULL,
  severity                    student_spce.rule_severity_enum NOT NULL,

  -- Declared possible outcomes (WP-STD-SPCE-04 §6, §15) — must be declared
  -- before registration so a returned outcome can be validated against it.
  output_types                student_spce.rule_output_type_enum[] NOT NULL,

  -- Rule Dependencies (WP-STD-SPCE-04 §9) — references to other `rule_id`s,
  -- resolved at Discovery time (IP-04), not by any constraint here.
  dependencies                text[]      NOT NULL DEFAULT '{}',

  -- Rule Policies (WP-STD-SPCE-04 §11) — references only; a rule never
  -- embeds a policy's actual value.
  policy_bindings              student_spce.evaluation_policy_type_enum[] NOT NULL DEFAULT '{}',

  -- Rule Lifecycle (WP-STD-SPCE-04 §3).
  lifecycle_stage              student_spce.rule_lifecycle_stage_enum NOT NULL DEFAULT 'Draft',
  deprecation_window_ends_at   timestamptz NULL,
  replacement_rule_id          text        NULL,

  -- Governance bookkeeping (WP-STD-SPCE-04 §6 `metadata`, §18 Ownership) —
  -- owner, review date, related documentation links. Reserved, no bearing on
  -- evaluation.
  metadata                     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_definitions_pkey
    PRIMARY KEY (id),

  CONSTRAINT rule_definitions_rule_id_version_uq
    UNIQUE (rule_id, version),

  CONSTRAINT rule_definitions_rule_id_ck
    CHECK (length(btrim(rule_id)) > 0),

  CONSTRAINT rule_definitions_rule_family_ck
    CHECK (length(btrim(rule_family)) > 0),

  CONSTRAINT rule_definitions_rule_group_ck
    CHECK (length(btrim(rule_group)) > 0),

  CONSTRAINT rule_definitions_display_name_ck
    CHECK (length(btrim(display_name)) > 0),

  CONSTRAINT rule_definitions_description_ck
    CHECK (length(btrim(description)) > 0),

  CONSTRAINT rule_definitions_output_types_nonempty_ck
    CHECK (array_length(output_types, 1) IS NOT NULL AND array_length(output_types, 1) > 0),

  -- WP-STD-SPCE-04 §3, Deprecated stage: "a stated deprecation window."
  CONSTRAINT rule_definitions_deprecation_window_ck
    CHECK (lifecycle_stage <> 'Deprecated' OR deprecation_window_ends_at IS NOT NULL),

  CONSTRAINT rule_definitions_version_positive_ck
    CHECK (version > 0)
);

-- WP-STD-SPCE-04 §10: "exactly one [version] is Active at any moment for a
-- given evaluation" — enforced as exactly one Active-lifecycle row per
-- rule_id.
CREATE UNIQUE INDEX IF NOT EXISTS rule_definitions_one_active_per_rule_uq
  ON student_spce.rule_definitions (rule_id)
  WHERE lifecycle_stage = 'Active';

-- Rule Discovery (WP-STD-SPCE-04 §8) resolves by Family, then filters by
-- Active lifecycle, category, and policy binding — the following indexes
-- support exactly those lookups (§7's Discovery/Filtering/Grouping
-- capabilities), without implementing Discovery itself (IP-04's scope).
CREATE INDEX IF NOT EXISTS idx_rule_definitions_rule_family_group
  ON student_spce.rule_definitions (rule_family, rule_group);

CREATE INDEX IF NOT EXISTS idx_rule_definitions_subdomain_category
  ON student_spce.rule_definitions (subdomain, category)
  WHERE lifecycle_stage IN ('Active', 'Deprecated');

CREATE INDEX IF NOT EXISTS idx_rule_definitions_lifecycle_stage
  ON student_spce.rule_definitions (lifecycle_stage);

CREATE INDEX IF NOT EXISTS idx_rule_definitions_dependencies_gin
  ON student_spce.rule_definitions USING gin (dependencies);

CREATE INDEX IF NOT EXISTS idx_rule_definitions_policy_bindings_gin
  ON student_spce.rule_definitions USING gin (policy_bindings);

COMMENT ON TABLE student_spce.rule_definitions IS
  'Rule Registry storage (WP-STD-SPCE-04 §6/§7) — one row per Rule Version. Populated and queried by the Rule Registry module (IP-03); this migration creates storage only, no registry behavior.';
COMMENT ON COLUMN student_spce.rule_definitions.rule_id IS
  'Stable dot-path identifier, unchanged across versions (WP-STD-SPCE-02A §5.13, WP-STD-SPCE-04 §6). e.g. academic.gradYearAfterAdmissionYear.';
COMMENT ON COLUMN student_spce.rule_definitions.version IS
  'Monotonically increasing integer per rule_id (WP-STD-SPCE-04 §10) — not semantic versioning.';
COMMENT ON COLUMN student_spce.rule_definitions.subdomain IS
  'NULL for a Cross-section Rule (WP-STD-SPCE-04 §6, §16) — absent, not a sixth enum value.';
COMMENT ON COLUMN student_spce.rule_definitions.dependencies IS
  'References to other rule_ids (WP-STD-SPCE-04 §9). Resolved and validated for cycles by Rule Discovery at evaluation setup (IP-04), never by a constraint here.';
COMMENT ON COLUMN student_spce.rule_definitions.metadata IS
  'Reserved governance bookkeeping (owner, review date, doc links — WP-STD-SPCE-04 §6/§18). No bearing on evaluation.';


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_spce.evaluation_policy_versions
-- WP-STD-SPCE-09 §3.1 (Five Certified Policies), §4 (Responsibilities),
-- §6 (Precedence), §10 (State), §11 (Lifecycle), §12 (Conflict Resolution),
-- §13 (Versioning).
--
-- One row per resolvable policy source at one precedence level. Policy
-- Resolution (IP-04, per WP-STD-SPCE-09 §5) reads these rows to produce the
-- single Resolved Runtime Policy per run — that resolution algorithm is
-- explicitly out of IP-01's scope; this table only stores the sources it
-- will read.
--
-- OWNERSHIP (deferred to a later IP): Write access belongs to Policy
-- Governance tooling (WP-STD-SPCE-09 §20, not yet built). No GRANT
-- statements are issued by this migration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_spce.evaluation_policy_versions (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),

  policy_type            student_spce.evaluation_policy_type_enum NOT NULL,
  precedence_level       student_spce.policy_precedence_level_enum NOT NULL,

  -- Scope of this source: NULL only for Global (the platform-wide default);
  -- otherwise a subdomain name (Domain level), a capabilityId (Capability
  -- level), or a context axis key (Evaluation Context level) — WP-STD-SPCE-09
  -- §6. Consumer Profile level rows are permitted by the enum for structural
  -- completeness (§6's own naming-completeness note) but the certified
  -- architecture gives them no content today; none should be inserted by any
  -- consumer of this table until a future work package certifies otherwise.
  scope_key              text        NULL,

  version                integer     NOT NULL DEFAULT 1,

  -- The resolved value/threshold/classification this source contributes.
  -- WP-STD-SPCE-09 never fixes a concrete value shape for any of the five
  -- policies ("no numeric scores or weighting formulas... implementation
  -- work package's job" — WP-STD-SPCE-05 §5; "storage mechanism... [is a]
  -- Phase H2 decision" — WP-STD-SPCE-04 §7). jsonb is used here so this
  -- migration commits to storage only, never to a specific policy's value
  -- schema, which is later-IP or later-WP scope.
  value                  jsonb       NOT NULL DEFAULT '{}'::jsonb,

  lifecycle_stage         student_spce.policy_lifecycle_stage_enum NOT NULL DEFAULT 'Draft',
  superseded_by_version   integer     NULL,

  -- Policy Owner of record (WP-STD-SPCE-09 §4, §20.2).
  owner                   text        NOT NULL,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evaluation_policy_versions_pkey
    PRIMARY KEY (id),

  CONSTRAINT evaluation_policy_versions_owner_ck
    CHECK (length(btrim(owner)) > 0),

  CONSTRAINT evaluation_policy_versions_version_positive_ck
    CHECK (version > 0),

  -- WP-STD-SPCE-09 §6: Global is the only level with no narrower scope.
  CONSTRAINT evaluation_policy_versions_global_scope_ck
    CHECK (
      (precedence_level = 'Global' AND scope_key IS NULL)
      OR (precedence_level <> 'Global' AND scope_key IS NOT NULL)
    ),

  -- WP-STD-SPCE-09 §6: "Capability Policy ... certified today only for
  -- Eligibility Policy."
  CONSTRAINT evaluation_policy_versions_capability_level_ck
    CHECK (precedence_level <> 'Capability' OR policy_type = 'Eligibility'),

  -- WP-STD-SPCE-09 §11, Deprecation/Retirement entry criteria: "a replacement
  -- version reaches Activation" — a deprecated/retired row must name it.
  CONSTRAINT evaluation_policy_versions_supersession_ck
    CHECK (
      lifecycle_stage NOT IN ('Deprecation', 'Retirement')
      OR superseded_by_version IS NOT NULL
    )
);

-- WP-STD-SPCE-09 §5.5: exactly one resolved value per policy/level/scope at
-- a time — enforced as exactly one Activation-stage row per
-- (policy_type, precedence_level, scope_key).
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_policy_versions_one_active_uq
  ON student_spce.evaluation_policy_versions (policy_type, precedence_level, COALESCE(scope_key, ''))
  WHERE lifecycle_stage = 'Activation';

-- No two sources may claim the same (policy_type, precedence_level,
-- scope_key, version) — the version identity WP-STD-SPCE-09 §13 fixes.
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_policy_versions_identity_uq
  ON student_spce.evaluation_policy_versions (policy_type, precedence_level, COALESCE(scope_key, ''), version);

CREATE INDEX IF NOT EXISTS idx_evaluation_policy_versions_type_level
  ON student_spce.evaluation_policy_versions (policy_type, precedence_level);

CREATE INDEX IF NOT EXISTS idx_evaluation_policy_versions_lifecycle_stage
  ON student_spce.evaluation_policy_versions (lifecycle_stage);

COMMENT ON TABLE student_spce.evaluation_policy_versions IS
  'Storage for the sources Policy Resolution (WP-STD-SPCE-09 §5, to be implemented in a later IP) reads to produce one resolved value per policy, per run. This migration creates storage only, no resolution algorithm.';
COMMENT ON COLUMN student_spce.evaluation_policy_versions.scope_key IS
  'NULL only for Global precedence. Subdomain name (Domain), capabilityId (Capability), or context axis key (EvaluationContext) otherwise — WP-STD-SPCE-09 §6.';
COMMENT ON COLUMN student_spce.evaluation_policy_versions.value IS
  'The policy source''s contributed value. Deliberately schema-flexible (jsonb) — no certified document fixes a concrete value shape for any of the five policies (WP-STD-SPCE-05 §5, WP-STD-SPCE-04 §7).';


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: student_spce.rule_profiles
-- WP-STD-SPCE-05A §28 (Rule Profiles — concept and seven canonical
-- instances), WP-STD-SPCE-05B §28.10 (Profile Metadata, Profile Lifecycle),
-- §28.11 (Conceptual Profile Composition — documentation only, never
-- resolved or executed).
--
-- Rule Profiles are consulted only at Recommendation Assembly (WP-STD-
-- SPCE-06 §5, step 10), after evaluation completes — never by the Rule
-- Evaluation Layer, Rule Discovery, or any Evaluation Policy (WP-STD-
-- SPCE-09 §3.2). This table stores the curated ruleId lists and their
-- governance metadata only; nothing here participates in evaluation.
--
-- OWNERSHIP (deferred): Write access belongs to Profile governance tooling,
-- not yet built (WP-STD-SPCE-05B §28.10's "future Profile Registry"). No
-- GRANT statements are issued by this migration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_spce.rule_profiles (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),

  -- Identity (WP-STD-SPCE-05B §28.10) — stable dot-path identifier.
  profile_id                text        NOT NULL,
  version                   text        NOT NULL DEFAULT '1.0',

  display_name              text        NOT NULL,
  description                text        NOT NULL,
  purpose                    text        NOT NULL,

  status                     student_spce.profile_lifecycle_stage_enum NOT NULL DEFAULT 'Draft',
  owner                      text        NOT NULL,

  target_consumers           text[]      NOT NULL DEFAULT '{}',
  supported_rule_families    text[]      NOT NULL DEFAULT '{}',
  supported_rule_categories  student_spce.rule_category_enum[] NOT NULL DEFAULT '{}',

  -- Descriptive classification only (WP-STD-SPCE-05B §28.10 "Profile Type")
  -- — e.g. single-Family, cross-cutting, composite. Not an enforced enum,
  -- since the certified documents do not fix a closed set of profile types.
  profile_type               text        NOT NULL,

  -- Documentation cross-reference only (WP-STD-SPCE-05B §28.11) — the
  -- profile_ids this one is conceptually described as composing. Never
  -- resolved or executed; explicitly not a dependency graph.
  profile_dependencies       text[]      NOT NULL DEFAULT '{}',

  -- The curated membership list (WP-STD-SPCE-05A §28.3–§28.4) — references
  -- to rule_definitions.rule_id, read only at Recommendation Assembly.
  rule_ids                   text[]      NOT NULL DEFAULT '{}',

  deprecated                 boolean     NOT NULL DEFAULT false,
  replacement_profile_id     text        NULL,
  notes                      text        NULL,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_profiles_pkey
    PRIMARY KEY (id),

  CONSTRAINT rule_profiles_profile_id_version_uq
    UNIQUE (profile_id, version),

  CONSTRAINT rule_profiles_profile_id_ck
    CHECK (length(btrim(profile_id)) > 0),

  CONSTRAINT rule_profiles_display_name_ck
    CHECK (length(btrim(display_name)) > 0),

  CONSTRAINT rule_profiles_description_ck
    CHECK (length(btrim(description)) > 0),

  CONSTRAINT rule_profiles_purpose_ck
    CHECK (length(btrim(purpose)) > 0),

  CONSTRAINT rule_profiles_owner_ck
    CHECK (length(btrim(owner)) > 0),

  CONSTRAINT rule_profiles_profile_type_ck
    CHECK (length(btrim(profile_type)) > 0),

  -- WP-STD-SPCE-05B §28.10 Profile Lifecycle: deprecated flag must agree
  -- with status.
  CONSTRAINT rule_profiles_deprecated_status_ck
    CHECK (NOT deprecated OR status IN ('Deprecated', 'Archived'))
);

-- One Active version per profile_id at a time (mirrors the same "single
-- resolved/active row" discipline used for rule_definitions and
-- evaluation_policy_versions above; WP-STD-SPCE-05B §28.10's Profile
-- Lifecycle names Active as a distinct, singular stage per Profile).
CREATE UNIQUE INDEX IF NOT EXISTS rule_profiles_one_active_per_profile_uq
  ON student_spce.rule_profiles (profile_id)
  WHERE status = 'Active';

CREATE INDEX IF NOT EXISTS idx_rule_profiles_status
  ON student_spce.rule_profiles (status);

CREATE INDEX IF NOT EXISTS idx_rule_profiles_owner
  ON student_spce.rule_profiles (owner);

CREATE INDEX IF NOT EXISTS idx_rule_profiles_rule_ids_gin
  ON student_spce.rule_profiles USING gin (rule_ids);

CREATE INDEX IF NOT EXISTS idx_rule_profiles_supported_families_gin
  ON student_spce.rule_profiles USING gin (supported_rule_families);

COMMENT ON TABLE student_spce.rule_profiles IS
  'Rule Profile storage (WP-STD-SPCE-05A §28, WP-STD-SPCE-05B §28.10) — curated, consumer-facing ruleId lists with governance metadata. Consulted only at Recommendation Assembly (WP-STD-SPCE-06 §5 step 10); never by the Rule Evaluation Layer, Rule Discovery, or any Evaluation Policy (WP-STD-SPCE-09 §3.2).';
COMMENT ON COLUMN student_spce.rule_profiles.rule_ids IS
  'Curated membership list — references to student_spce.rule_definitions.rule_id. Not a foreign key: a Profile may reference a rule at any lifecycle stage, including Draft or Archived (WP-STD-SPCE-05B §28.10), so an enforced FK would be incorrect, not merely unimplemented.';
COMMENT ON COLUMN student_spce.rule_profiles.profile_dependencies IS
  'Documentation cross-reference only (WP-STD-SPCE-05B §28.11 Conceptual Profile Composition) — never resolved, never a dependency graph, never affects evaluation.';

-- ─────────────────────────────────────────────────────────────────────────────
-- End of migration.
-- ─────────────────────────────────────────────────────────────────────────────
