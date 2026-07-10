# EEP-01 — Enterprise Engineering Program
## Phase A: Enterprise Physical Data Model
### Canonical Student Academic Domain

**Status:** Phase A only. No SQL. Stops at end of this phase per program constraint.

---

## Phase Header

**Architecture references (authoritative, not reopened):**
- WP-ARCH-01B — bounded contexts, aggregates, ADRs (source of ownership/lifecycle rules)
- WP-ARCH-01C — logical entities E-01…E-10, reference entities R-01…R-16, attributes, relationships, constraints, versioning, audit, permission model (direct translation source for this phase)
- WP-ARCH-01D — runtime read-access patterns (informs which physical structures must be query-optimized for downstream runtimes)
- WP-ARCH-01E — legacy generation inventory (informs what this schema must be capable of receiving during migration) and the two carried-forward closure findings this phase must resolve (below)
- WP-ARCH-01F — closure review findings this phase is scoped to address: the E-03 permission-scope correction, and closure Risk #6 (PII/data-protection depth), which this phase treats as a first-class deliverable (Data Classification & PII Classification, below) rather than deferring further

**Scope:** Physical entities, columns, keys, relationships, normalization, partitioning strategy, naming conventions, data types, constraints, generated columns, audit fields, version fields, data classification, PII classification — for all 10 domain entities and 16 reference entities. No DDL, no RLS, no indexes-as-SQL (index *candidates* are named where normalization/partitioning decisions depend on them; full indexing strategy is Phase D).

**Dependencies:** None upstream within this program. This phase is the direct input to Phase B (Security Architecture) and Phase D (Canonical Schema Implementation).

**Deliverables:** This document — a complete physical data model specification, in prose and tables, translatable to DDL without further design decisions in Phase D.

**Risks carried into this phase:** WP-ARCH-01F Part 5, Risk #6 (PII/data protection) is addressed directly below. WP-ARCH-01F Part 2.1 (E-03 permission scope inconsistency) is resolved as a modeling decision in Part 6 of this document, with the correction stated explicitly.

---

## PART 1 — Naming Conventions

Established once, applied uniformly, and designed specifically to prevent recurrence of the naming collisions WP-ARCH-01A/A.2 found in the legacy schema (`student_academic_profiles` vs. `student_academics_profiles`; `student_academic_records` vs. `edu_academic_records` sharing a name for different lifecycles).

1. **Schema isolation.** All physical entities for this domain live in a dedicated PostgreSQL schema, `academic_domain`, distinct from `public` and from any other domain's schema. This alone eliminates the possibility of a same-named-different-shape table anywhere else in the database being mistaken for a canonical entity.
2. **Table names.** `snake_case`, singular business noun, no domain-repeating prefix (the schema qualifier already disambiguates) — e.g. `academic_domain.student_profile`, not `academic_domain.student_academic_profile` or `academic_domain.acad_student_profiles`.
3. **Reference tables** are prefixed `ref_` within the same schema — e.g. `academic_domain.ref_board` — so a query author can immediately distinguish shared-kernel reference data from student-owned operational/historical data without needing to memorize which of the 26 tables is which.
4. **Column names.** `snake_case`, no abbreviations (`marks_obtained`, not `mrks_obt`), matching WP-ARCH-01C Part 14 rule 10's business-name discipline carried down to the physical layer.
5. **Primary keys.** Every table's primary key column is named `id` (type `uuid`), never a composite natural key as the primary key — natural/business uniqueness is enforced via separate unique constraints (Part 5), keeping foreign keys single-column everywhere.
6. **Foreign keys.** Named `<referenced_singular_noun>_id` — e.g. `qualification_id` on `subject_selection`, `profile_id` on `academic_qualification`. Where a table has more than one FK to the same referenced table (none currently do), a disambiguating prefix is added.
7. **Code-reference columns** (a value resolved against the Taxonomy Version, per WP-ARCH-01C Part 1.3) are named `<concept>_code` — e.g. `board_code`, `country_code` — and are **always** paired with a `taxonomy_version_id` column on the same row (Part 8). A `_code` column is never a bare foreign key to a reference table's surrogate `id`; it is a business-key string, resolved via the reference table's own `code` + `taxonomy_version_id`, per WP-ARCH-01B ADR-05's "reference, never duplication" rule.
8. **Event/status enumerations** use native PostgreSQL `enum` types, one per concept, named `<concept>_status` or `<concept>_type` — e.g. `qualification_status`, `record_completion_state` — never a free-text column with application-only validation, since WP-ARCH-01C's forward-only transition rules (Part 6.3) are exactly the kind of invariant a DB-level enum plus a trigger (Phase D) can enforce structurally.
9. **Timestamps** are always `timestamptz`, never `timestamp` — the multi-country design goal (WP-ARCH-01B §1.3 item 6) makes timezone-naive timestamps a latent defect, not a simplification.
10. **No table or column name introduced by this phase collides, by design, with any name found in WP-ARCH-01A's Section 1.1 inventory** (`student_academic_records`, `student_academic_subjects`, `student_education_profiles`, `student_academic_profiles`, `student_subject_selections`, `student_language_preferences`, `edu_students`, `edu_academic_records`, `edu_stream_scores`, `edu_cognitive_results`, `edu_extracurricular`, and the unconfirmed `student_academics_profiles` variant). This is a deliberate, checked design constraint, not a coincidence — Phase D's migration scripts can therefore safely run both schemas side by side during WP-ARCH-01E's coexistence window (Phase 3–12) with zero name-shadowing risk.

---

## PART 2 — Physical Entity Catalogue

| Physical table | Logical entity | Schema | Category | Partitioned? |
|---|---|---|---|---|
| `student_profile` | E-01 Student Academic Profile | `academic_domain` | Operational | No |
| `language_preference` | E-02 Language Preference | `academic_domain` | Operational | No |
| `academic_qualification` | E-03 Academic Qualification | `academic_domain` | Historical | No (low per-student cardinality) |
| `subject_selection` | E-04 Subject Selection | `academic_domain` | Historical | No |
| `academic_record` | E-05 Academic Record | `academic_domain` | Historical | **Yes** — by `created_at` range (Part 4) |
| `subject_performance` | E-06 Subject Performance | `academic_domain` | Historical | **Yes** — partition-aligned with parent `academic_record` (Part 4) |
| `cognitive_assessment_result` | E-07 Cognitive Assessment Result | `academic_domain` | Historical | **Yes** — by `assessment_date` range |
| `activity_record` | E-08 Activity Record | `academic_domain` | Historical | No |
| `derived_academic_signal` | E-09 Derived Academic Signal | `academic_domain` | Derived | **Yes** — by `computed_date` range |
| `academic_context` | E-10 Academic Context (projection) | `academic_domain` | Projection | No (see Part 9 — materialization strategy) |
| `ref_country` | R-01 | `academic_domain` | Reference | No |
| `ref_region` | R-02 | `academic_domain` | Reference | No |
| `ref_board` | R-03 | `academic_domain` | Reference | No |
| `ref_curriculum` | R-04 | `academic_domain` | Reference | No |
| `ref_program` | R-05 | `academic_domain` | Reference | No |
| `ref_academic_level` | R-06 | `academic_domain` | Reference | No |
| `ref_qualification_type` | R-07 | `academic_domain` | Reference | No |
| `ref_stream` | R-08 | `academic_domain` | Reference | No |
| `ref_subject` | R-09 | `academic_domain` | Reference | No |
| `ref_language` | R-10 | `academic_domain` | Reference | No |
| `ref_institution` | R-11 | `academic_domain` | Reference | No |
| `ref_assessment_system` | R-12 | `academic_domain` | Reference | No |
| `ref_credit_system` | R-13 | `academic_domain` | Reference | No |
| `ref_grade_system` | R-14 | `academic_domain` | Reference | No |
| `ref_board_region_map` | R-15 | `academic_domain` | Reference (association) | No |
| `taxonomy_version` | R-16 | `academic_domain` | Reference (meta) | No |

**Table count:** 26 (10 domain + 16 reference), matching WP-ARCH-01C Part 2 exactly — no entity added, removed, or merged in translation, per this phase's constraint against reopening architectural decisions.

---

## PART 3 — Normalization

The physical model is **3NF for all operational and reference tables**, with two deliberate, documented departures, both justified directly by WP-ARCH-01C's own logical design rather than by physical convenience:

1. **`subject_performance.percentage` is a stored, non-derivable-at-query-time value**, not a normalized-away computed column, because WP-ARCH-01C explicitly designates it `Derived` but **persisted** (its logical Mutability is "Immutable once record committed," not "computed on read"). A denormalization exception is justified here because WP-ARCH-01A.2 §2.2 found the legacy schema's own comment stated this column exists "for analytics performance" — this phase preserves that intent structurally (Part 7, Generated Columns) rather than re-deriving it on every downstream read.
2. **`academic_context` is an intentionally denormalized, wide projection table** (Part 9) — this is expected and correct for a projection/read-model layer per WP-ARCH-01C Part 1.2's write-model/read-model split; it is not held to 3NF, by design, matching the logical model's own explicit statement that `AcademicContext` "owns no write-side truth of its own."

No other denormalization is introduced. In particular, taxonomy facts (board name, country name, etc.) are **never** copied onto `student_profile`, `academic_qualification`, or any historical table — only the `_code` + `taxonomy_version_id` pair is stored, per WP-ARCH-01B ADR-05, directly correcting the ad hoc `country_code`/`board_code` denormalization-with-backfill pattern WP-ARCH-01A.2 §2.6 found already causing reconciliation debt in the legacy Family C schema.

---

## PART 4 — Partitioning Strategy

Four tables are partitioned; the remaining 22 are not. Partitioning is applied only where WP-ARCH-01D's own catalogue identifies sustained, unbounded historical growth against a scale target of "ten downstream AI systems querying this domain" (WP-ARCH-01B §1.2) — i.e., append-only Historical/Derived tables with no natural upper bound on row count per student over a stated 10-year platform horizon (WP-ARCH-01B §1.4).

| Table | Partition key | Partition strategy | Justification |
|---|---|---|---|
| `academic_record` | `created_at` (range, yearly) | Native PostgreSQL declarative range partitioning, one partition per calendar year, new partitions provisioned ahead of year boundary | Append-only, immutable-once-committed (WP-ARCH-01B ADR-04); a 10-year horizon at platform scale makes unbounded single-table growth the single largest storage/query-performance risk in the domain |
| `subject_performance` | `created_at` (range, yearly), aligned to parent `academic_record` partition | Same as parent — partition boundaries chosen so a period's records and their subject performances always co-locate in the same partition pair | Avoids cross-partition joins for the domain's single most common read pattern (a period's full result set) |
| `cognitive_assessment_result` | `assessment_date` (range, yearly) | Native range partitioning | Append-only per-attempt history (WP-ARCH-01C Part 3, E-07); no upsert, unbounded growth |
| `derived_academic_signal` | `computed_date` (range, monthly) | Native range partitioning, finer grain than the above | This table has the highest expected write volume of the four — every computation run of every engine produces a new row (WP-ARCH-01B §2.6) — monthly partitions keep individual partitions from growing unmanageably large given potentially frequent re-scoring |

**Not partitioned, with justification:**
- `student_profile`, `language_preference` — current-state-only, bounded at one row (or a small child set) per student; no unbounded growth dimension exists (WP-ARCH-01B §3.1's own size justification already argues this table stays small).
- `academic_qualification`, `subject_selection` — historical but low cardinality per student (a handful of qualifications and a bounded subject list per lifetime); partitioning overhead would exceed its benefit at any realistic scale.
- `activity_record` — historical but comparatively low-volume per student relative to academic records.
- `academic_context` — a projection table, kept current-version-only in its primary form (Part 9); historical versions, if retained physically at all rather than via replay, are a Phase D operational decision, not a Phase A structural one.
- All 16 reference tables and `taxonomy_version` — bounded, slow-growing, shared-kernel data; partitioning a reference table would add operational complexity with no query-performance benefit at any plausible taxonomy size.

---

## PART 5 — Keys, Relationships, and Uniqueness Constraints

All primary keys are `uuid` (`id`), generated at write time (not client-supplied), consistent with WP-ARCH-01C Part 4's `Identifier` logical type being described as "opaque," never a natural key.

| Table | Primary key | Foreign keys | Business-key uniqueness constraint |
|---|---|---|---|
| `student_profile` | `id` | none (root of the domain) | `UNIQUE (student_id)` — WP-ARCH-01C §6.1: exactly one profile per student |
| `language_preference` | `id` | `profile_id → student_profile.id` | `UNIQUE (profile_id, language_code, relationship_type)` within the current `set_version` |
| `academic_qualification` | `id` | `profile_id → student_profile.id` | none beyond PK — many per profile, by design (WP-ARCH-01B ADR-02) |
| `subject_selection` | `id` | `qualification_id → academic_qualification.id` | `UNIQUE (qualification_id, subject_code) WHERE selection_status = 'enrolled'` — enforces §6.1's "at most one active selection per subject per qualification" as a **partial unique index**, not a plain unique constraint, so a withdrawn-then-reselected subject is permitted |
| `academic_record` | `id` | `qualification_id → academic_qualification.id`, `supersedes_record_id → academic_record.id` (self-referencing, nullable) | `UNIQUE (qualification_id, period_code, record_version)`; a **partial** unique index `UNIQUE (qualification_id, period_code) WHERE completion_state = 'committed' AND record_version = (max version in chain)` is the physical enforcement of §6.1's "at most one committed record per period at the current highest version" |
| `subject_performance` | `id` | `record_id → academic_record.id`, `subject_selection_id → subject_selection.id` | `UNIQUE (record_id, subject_selection_id)` — §6.1: at most one performance row per (record, selection) pair |
| `cognitive_assessment_result` | `id` | `profile_id → student_profile.id` | none beyond PK — every attempt is independently valid, no "current" row |
| `activity_record` | `id` | `profile_id → student_profile.id`, `supersedes_activity_id → activity_record.id` (self-referencing, nullable) | none beyond PK |
| `derived_academic_signal` | `id` | `profile_id → student_profile.id`, `source_context_id → academic_context.id` (or `source_context_version` if `academic_context` is replay-only, Part 9), `source_taxonomy_version_id → taxonomy_version.id` | none beyond PK — every run is independently retained |
| `academic_context` | `id` | `profile_id → student_profile.id` | `UNIQUE (profile_id, context_version)`; current-version lookup is `UNIQUE (profile_id) WHERE is_current = true` (partial index, Part 9) |
| `ref_*` tables (R-01–R-14) | `id` | hierarchical FKs per WP-ARCH-01C Part 5's reference relationships (e.g. `ref_curriculum.board_id → ref_board.id`) | `UNIQUE (code, taxonomy_version_id)` on every reference table — the same code may be re-published across taxonomy versions, but never duplicated within one |
| `ref_board_region_map` | `id` | `board_id → ref_board.id`, `region_id → ref_region.id` | `UNIQUE (board_id, region_id, taxonomy_version_id)` |
| `taxonomy_version` | `id` | none | `UNIQUE (version_number)`, strictly increasing (§6.8) |

**Every historical/operational table's FK into a reference table is a `_code` string column, resolved against `taxonomy_version_id` on the same row — not a direct FK to the reference table's `id`.** This is the physical enforcement of Part 1, rule 7 and WP-ARCH-01B ADR-05: it makes it structurally impossible for Phase D to accidentally reintroduce the denormalization pattern that caused the legacy backfill debt WP-ARCH-01A.2 §2.6 documented, because there is no `id`-based FK path that would tempt a future engineer to join and copy a taxonomy value onto a student row.

**Cross-qualification integrity rule** (WP-ARCH-01C §6.2 — "cross-qualification references are prohibited" between `subject_performance` and its parent `academic_record`/`subject_selection` pair): physically enforced by a `CHECK`-equivalent trigger constraint in Phase D (not expressible as a plain FK, since it requires comparing `subject_performance.record_id`'s qualification against `subject_performance.subject_selection_id`'s qualification) — flagged here as a **Phase D trigger requirement**, not resolved by this phase's key structure alone.

---

## PART 6 — Access-Pattern Notes for Phase B (Security Architecture)

Not a security design (that is Phase B in full) — this phase records the physical-structure implications Phase B will need, including the one correction inherited from WP-ARCH-01F.

- **WP-ARCH-01F Part 2.1 correction, applied here:** the physical `academic_qualification` table does **not** carry a Career-Outcome-Intelligence-Engine read grant distinct from what WP-ARCH-01B Part 5 step 13 actually authorized. Per the closure review's recommendation, this phase resolves the drift in favor of **narrowing to WP-ARCH-01B's original scope** (immutable `academic_record`/`subject_performance` history only) rather than widening WP-ARCH-01B — Career Outcome Intelligence Engine's Phase B role grants read access to `academic_record` and `subject_performance` only; `academic_qualification` is reached only indirectly, by joining through `academic_record.qualification_id` for the read query's own use (not as an independently grantable table-level permission). This keeps Phase B's forthcoming role design aligned with WP-ARCH-01B's actual ADR text and removes the inconsistency without requiring a WP-ARCH-01B amendment.
- Every table's row-level ownership predicate will resolve through `student_profile.student_id` (directly, or transitively via `profile_id`/`qualification_id`/`record_id` chains) — Phase B should design one composable ownership-check pattern reusable across all 10 domain tables rather than ten independent policies, since the FK graph in Part 5 makes the ownership chain uniform.
- Reference tables (`ref_*`, `taxonomy_version`) require universal read access and write access restricted to a taxonomy-steward role — no per-row ownership predicate applies to these 16 tables at all, simplifying Phase B's design for that half of the schema.
- `cognitive_assessment_result.raw_responses` and any equivalent free-text/JSON payload columns are flagged in Part 10 (PII Classification) as requiring column-level, not merely row-level, access restriction in Phase B — a plain RLS row policy is insufficient on its own for this column.

---

## PART 7 — Data Types, Constraints, and Generated Columns (by entity)

Logical types (WP-ARCH-01C Part 4) map to physical types as follows, applied consistently: **Identifier → `uuid`; Text → `text`; Number → `numeric` (unscaled) or `integer` (counts only); Boolean → `boolean`; Date → `date`; DateTime → `timestamptz`; Percentage → `numeric(5,2)`; Enumeration → native Postgres `enum`; Code Reference → `text` (business-key code) + a paired `uuid` FK to `taxonomy_version`; Collection-of-X → `jsonb`.**

### 7.1 `student_profile` (E-01)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `student_id` | `uuid` | No | FK to platform identity domain (outside this schema — referenced, not owned, per WP-ARCH-01B §8) |
| `country_code` | `text` | No | Code Reference → `ref_country` |
| `region_code` | `text` | No | Code Reference → `ref_region` |
| `board_code` | `text` | No | Code Reference → `ref_board` |
| `current_academic_level_code` | `text` | No | Code Reference → `ref_academic_level` |
| `current_stream_code` | `text` | Yes | Code Reference → `ref_stream` |
| `current_institution_code` | `text` | Yes | Code Reference → `ref_institution` |
| `established_at` | `timestamptz` | No | Immutable |
| `taxonomy_version_id` | `uuid` | No | FK → `taxonomy_version`; resolves every `_code` column above |
| *(audit fields)* | — | — | Per Part 8 |

### 7.2 `language_preference` (E-02)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `profile_id` | `uuid` | No | FK → `student_profile` |
| `language_code` | `text` | No | Code Reference → `ref_language` |
| `relationship_type` | `enum('medium','additional')` | No | |
| `proficiency_level` | `enum('basic','intermediate','fluent','native')` | Yes | Required (application-layer + `CHECK`) when `relationship_type = 'additional'` |
| `display_order` | `integer` | No | Default `0` |
| `set_version` | `integer` | No | Default `1`, increments per full-set replace |
| `taxonomy_version_id` | `uuid` | No | FK → `taxonomy_version` |
| *(audit fields)* | — | — | Per Part 8 |

### 7.3 `academic_qualification` (E-03)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `profile_id` | `uuid` | No | FK → `student_profile` |
| `qualification_type_code` | `text` | No | Code Reference → `ref_qualification_type` |
| `board_code` | `text` | No | Code Reference → `ref_board`; may differ from `student_profile.board_code` (transfer scenario, WP-ARCH-01C §4) |
| `curriculum_code` | `text` | No | Code Reference → `ref_curriculum` |
| `stream_code` | `text` | Yes | Code Reference → `ref_stream` |
| `institution_code` | `text` | Yes | Code Reference → `ref_institution`; mutable post-creation (only mutable field on this table) |
| `period_start` | `date` | No | |
| `period_target_end` | `date` | Yes | |
| `period_actual_end` | `date` | Yes | Set-once, only on `status → completed` |
| `status` | `enum('active','completed','discontinued')` | No | Default `active`; forward-only transition enforced by Phase D trigger |
| `taxonomy_version_id` | `uuid` | No | FK → `taxonomy_version`, at creation, immutable |
| *(audit fields)* | — | — | Per Part 8 |

### 7.4 `subject_selection` (E-04)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `qualification_id` | `uuid` | No | FK → `academic_qualification` |
| `subject_code` | `text` | No | Code Reference → `ref_subject` |
| `selection_status` | `enum('enrolled','withdrawn')` | No | Default `enrolled`; forward-only |
| `is_primary` | `boolean` | No | Default `false` |
| `display_order` | `integer` | No | Default `0` |
| `selected_at` | `timestamptz` | No | |
| `withdrawn_at` | `timestamptz` | Yes | Set-once |
| `taxonomy_version_id` | `uuid` | No | FK → `taxonomy_version`, at selection time |
| *(audit fields)* | — | — | Per Part 8 |

### 7.5 `academic_record` (E-05) — **partitioned, see Part 4**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `qualification_id` | `uuid` | No | FK → `academic_qualification` |
| `period_code` | `text` | No | Code Reference → `ref_academic_level` (period-scoped usage) |
| `completion_state` | `enum('draft','committed')` | No | Default `draft`; forward-only; Phase D trigger blocks commit with zero `subject_performance` children |
| `committed_at` | `timestamptz` | Yes | Set-once |
| `record_version` | `integer` | No | Default `1`; increments only via amendment |
| `supersedes_record_id` | `uuid` | Yes | Self-FK; must reference a committed prior version of the same `(qualification_id, period_code)` |
| `is_predicted` | `boolean` | No | Default `false` |
| `taxonomy_version_id` | `uuid` | No | FK → `taxonomy_version`, at creation |
| *(audit fields)* | — | — | Per Part 8 |

### 7.6 `subject_performance` (E-06) — **partitioned, aligned with parent**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `record_id` | `uuid` | No | FK → `academic_record` |
| `subject_selection_id` | `uuid` | No | FK → `subject_selection`; must share the same qualification as `record_id` (Phase D trigger, Part 5) |
| `marks_obtained` | `numeric(6,2)` | Yes | `CHECK (marks_obtained >= 0)` |
| `max_marks` | `numeric(6,2)` | Yes | `CHECK (max_marks > 0)`; cross-column `CHECK (marks_obtained <= max_marks)` when both present |
| `grade_code` | `text` | Yes | Code Reference → `ref_grade_system` entry |
| `percentage` | `numeric(5,2)` | Yes | **Generated/persisted, not a native `GENERATED ALWAYS` column** — see Part 7.9 |
| `percentage_source` | `enum('marks_derived','grade_inferred','none')` | No | Default `none` |
| `source_type` | `enum('manual','ocr','imported')` | No | Default `manual` |
| `is_predicted` | `boolean` | No | Default `false` |
| *(audit fields)* | — | — | Per Part 8; inherits parent record's immutability at commit |

### 7.7 `cognitive_assessment_result` (E-07) — **partitioned, see Part 4**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `profile_id` | `uuid` | No | FK → `student_profile` |
| `assessment_at` | `timestamptz` | No | |
| `analytical_score` | `numeric(5,2)` | No | Scale bounds enforced by `assessment_version`-scoped `CHECK`, defined in Phase D once the scale is confirmed (see Known Issues) |
| `logical_score` | `numeric(5,2)` | No | Same |
| `memory_score` | `numeric(5,2)` | No | Same |
| `communication_score` | `numeric(5,2)` | No | Same |
| `creativity_score` | `numeric(5,2)` | No | Same |
| `raw_responses` | `jsonb` | No | **PII/sensitive — see Part 10** |
| `assessment_version` | `text` | No | |
| *(audit fields)* | — | — | Per Part 8; no update fields — immutable from creation |

### 7.8 `activity_record` (E-08)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | No | PK |
| `profile_id` | `uuid` | No | FK → `student_profile` |
| `activity_name` | `text` | No | `CHECK (length(trim(activity_name)) > 0)` |
| `activity_level` | `enum('beginner','intermediate','advanced','national','international')` | No | |
| `reported_at` | `timestamptz` | No | |
| `status` | `enum('active','withdrawn')` | No | Default `active`; forward-only |
| `supersedes_activity_id` | `uuid` | Yes | Self-FK |
| *(audit fields)* | — | — | Per Part 8 |

### 7.9 Generated columns — explicit treatment

`subject_performance.percentage` is **not** implemented as a native PostgreSQL `GENERATED ALWAYS AS (...) STORED` column, despite being a derived value, for one specific reason: WP-ARCH-01C §2.2 (citing WP-ARCH-01A.2) establishes that percentage is computed from marks **when marks/max_marks are present**, but **inferred from grade** when they are absent — a native generated column can express exactly one deterministic formula from sibling columns, not a two-path fallback with a source flag. This phase therefore specifies `percentage` as an **application/service-layer-computed, then persisted** column (Phase F responsibility), with `percentage_source` as its co-located provenance flag — directly closing the gap WP-ARCH-01A.2 §2.2 found in the legacy schema (a `percentage_source` value existed only in a transient function return, never persisted). This is the one place this phase's physical design is more capable than the legacy schema it replaces, and it is achieved by *not* reaching for a native generated column.

No other column in the domain is a native generated column; `academic_context`'s composed fields (Part 9) are populated by the Composition Context's own write path, not by a database-level generation expression, consistent with WP-ARCH-01C's explicit statement that the projection is "rebuilt," not "computed in place."

---

## PART 8 — Audit Fields (applied uniformly to all 18 write-model tables — E-01 through E-09's physical tables)

Every table in Part 7 (and the reference tables, with one variation noted) carries this fixed audit column set, directly implementing WP-ARCH-01C Part 9.1:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `created_by` | `uuid` | No | Actor identifier (student, system process, or admin) |
| `created_at` | `timestamptz` | No | Default `now()` |
| `updated_by` | `uuid` | Yes | Only populated on tables where in-place mutation is permitted (`student_profile`, `language_preference` — see WP-ARCH-01C Part 1.1) |
| `updated_at` | `timestamptz` | Yes | Same restriction |
| `change_reason` | `text` | Yes | Required (application-layer + `CHECK`) whenever the row represents an amendment/supersession event |
| `business_event` | `text` | No | The named domain event (WP-ARCH-01C Part 11) this row's creation/transition corresponds to |
| `audit_classification` | `enum('routine','correction','system_generated','administrative')` | No | |

**Reference tables (`ref_*`, `taxonomy_version`) carry a reduced set:** `created_by`, `created_at`, `deprecated_at` (nullable — presence means the entry is no longer valid for new writes, per WP-ARCH-01C Part 14 rule 8), and no `updated_by`/`updated_at` at all, since reference entries are never edited in place (Part 1.1's append/version-only mutability).

---

## PART 9 — Version Fields and the `academic_context` Projection Table

| Table | Version column(s) | Semantics |
|---|---|---|
| `academic_qualification`, `subject_selection`, `academic_record`, `subject_performance`, `cognitive_assessment_result`, `activity_record`, `derived_academic_signal`, `student_profile`, `language_preference` | `taxonomy_version_id` | Every row cites the specific taxonomy state it was resolved against (Part 7 tables, each) |
| `academic_record` | `record_version` (Part 7.5) | Supersession-chain version |
| `language_preference` | `set_version` (Part 7.2) | Full-set-replace version |
| `derived_academic_signal` | `engine_version` (`text`), `source_context_version` (`integer`, referencing `academic_context.context_version`) | Per WP-ARCH-01C §2.9 (E-09) |
| `academic_context` | `context_version` (`integer`, monotonic per `profile_id`) | See below |
| `taxonomy_version` | `version_number` (`integer`, globally monotonic) | Part 5 |

**`academic_context` physical design:** modeled as an **append-only table of projection versions**, not an update-in-place row, so that WP-ARCH-01C Part 8's replay guarantee ("every prior version retained") is a physical fact, not a logging convention layered on top of a mutable row. Columns:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `profile_id` | `uuid` | FK → `student_profile` |
| `context_version` | `integer` | `UNIQUE (profile_id, context_version)`, strictly increasing |
| `is_current` | `boolean` | Exactly one `true` row per `profile_id`, enforced by a partial unique index (`UNIQUE (profile_id) WHERE is_current`); every prior version's flag is flipped to `false` in the same transaction that inserts the new current version |
| `identity_snapshot` | `jsonb` | Composed from `student_profile`/`language_preference` |
| `active_qualification_snapshot` | `jsonb` | Composed from `academic_qualification`/`subject_selection` |
| `performance_history_summary` | `jsonb` | Composed from `academic_record`/`subject_performance` |
| `cognitive_activity_summary` | `jsonb` | Composed from `cognitive_assessment_result`/`activity_record` |
| `source_event_ids` | `jsonb` (array) | The specific source-entity audit-event references that triggered this rebuild |
| `generated_at` | `timestamptz` | |

This table is expected to be the highest-read-volume table in the schema (it is the sole legal read surface for nine downstream runtimes, per WP-ARCH-01B ADR-06/Part 2.5). It is deliberately **not partitioned** (Part 4) because the dominant query pattern is "give me the current version for one profile," served by the `is_current` partial index — a query shape partitioning would not help and could complicate. Retention of non-current versions (how long they're kept physically vs. relied on being reconstructable from source events per WP-ARCH-01C Part 9.3) is a Phase D/operational decision, flagged in Known Issues.

---

## PART 10 — Data Classification and PII Classification

Four classification levels are defined, applied per table and, where they diverge from the table's default, per column. This directly satisfies WP-ARCH-01F Part 5, Risk #6 and Part 8, WP-1's acceptance criterion ("every PII-bearing field has an explicit protection decision").

**Classification levels:**
- **Public** — no restriction; safe in logs, error messages, non-authenticated contexts.
- **Internal** — platform-internal only; not student-identifying on its own.
- **Confidential** — student-identifying or student-specific; requires authenticated, ownership-scoped access (the default for nearly every column in this domain).
- **Restricted** — confidential **and** independently sensitive even among student data (e.g. raw psychometric responses) — requires the access controls above **plus** column-level encryption and a distinct retention/erasure policy, not just row-level RLS.

| Table / column | Classification | PII? | Notes |
|---|---|---|---|
| All `ref_*` tables, `taxonomy_version` | Public | No | Shared reference content, no student linkage |
| `student_profile` (all columns except `student_id`) | Confidential | Indirect PII (academic context, not directly identifying alone) | |
| `student_profile.student_id` | Confidential | **Direct PII** (links to platform identity) | This is the domain's sole direct-identity linkage point — deliberately narrow, since no name/email/contact field is stored anywhere in this domain (confirmed against WP-ARCH-01A/A.2's evidence: this domain never held those fields even in the legacy schema) |
| `language_preference`, `academic_qualification`, `subject_selection` | Confidential | Indirect PII | |
| `academic_record`, `subject_performance` (including `marks_obtained`, `grade_code`, `percentage`) | Confidential | Indirect PII — academic performance records | Several jurisdictions HireRise's multi-country goal (WP-ARCH-01B §1.3 item 6) will reach classify academic records as a distinct legally-protected category (e.g. education-records statutes) independent of general PII law; Phase B must treat this table's classification as jurisdiction-aware, not a single global rule — flagged as a Known Issue below, not resolved by this phase |
| `activity_record` | Confidential | Indirect PII | |
| `cognitive_assessment_result.analytical_score` / `logical_score` / `memory_score` / `communication_score` / `creativity_score` | Confidential | Indirect PII | Computed outputs |
| `cognitive_assessment_result.raw_responses` | **Restricted** | **Direct, sensitive PII** | The student's raw, unaggregated assessment answers. This is the single column in the entire domain this phase flags for column-level encryption at rest (not merely RLS) and a retention/erasure policy distinct from the rest of the domain's default indefinite-retention posture (WP-ARCH-01C Part 9.3) — a raw-response payload has materially higher sensitivity and materially lower long-term utility than a computed score, and should not inherit the same "retain indefinitely by domain default" posture without an explicit decision, which this phase does not make unilaterally (Known Issues) |
| `derived_academic_signal` | Internal-to-Confidential | Indirect PII when `profile_id`-linked | Computed, versioned outputs; sensitivity is lower than source data but still student-linked |
| `academic_context` (all snapshot `jsonb` columns) | Confidential | Indirect PII (aggregated) | Inherits the highest classification of any field it composes from — since `cognitive_activity_summary` may include cognitive score fields, this projection's classification floor is the same as `cognitive_assessment_result`'s computed-score columns, **not** Restricted (raw responses are explicitly excluded from any projection snapshot — this phase's `cognitive_activity_summary` column definition, Part 9, composes only from computed scores, never from `raw_responses`, precisely to keep the widely-read projection table out of Restricted classification) |
| Audit columns (`created_by`, `updated_by`, `change_reason`) across all tables | Internal | Indirect PII (actor identifiers) | |

---

## Implementation Summary

This phase translates all 26 logical entities from WP-ARCH-01C into a physical schema (`academic_domain`) with: a collision-proof naming convention verified against the exact legacy names WP-ARCH-01A catalogued; full key/relationship/uniqueness design, including two partial-unique-index patterns needed to express WP-ARCH-01C's business invariants physically; a four-table partitioning strategy scoped only to genuinely unbounded historical/derived growth; an explicit, justified resolution for the one column (`percentage`) where a native generated column would have silently reintroduced a gap WP-ARCH-01A.2 found in the legacy design; a uniform audit-field and version-field application across all write-model tables; and a four-level data classification scheme that resolves WP-ARCH-01F's Risk #6 down to column grain, isolating exactly one column (`cognitive_assessment_result.raw_responses`) as Restricted.

One WP-ARCH-01F closure item (Part 2.1, the E-03 permission-scope inconsistency) is resolved within this phase (Part 6) in favor of WP-ARCH-01B's original, narrower exception text, removing the drift without requiring an amendment to WP-ARCH-01B itself.

---

## Validation Checklist

- [x] Every WP-ARCH-01C domain entity (E-01–E-10) and reference entity (R-01–R-16) has exactly one corresponding physical table — no merge, split, or omission.
- [x] Every logical attribute in WP-ARCH-01C Part 4 has an explicit physical type.
- [x] Every business invariant in WP-ARCH-01C Part 6 has an explicit physical enforcement mechanism (constraint, partial unique index, or flagged Phase D trigger).
- [x] No table or column name collides with any name in WP-ARCH-01A's Section 1.1 evidence inventory.
- [x] No taxonomy fact is denormalized onto any student-owned table (WP-ARCH-01B ADR-05 verified against every `_code` column's design).
- [x] WP-ARCH-01F's E-03 permission-scope finding is explicitly addressed, not silently dropped.
- [x] WP-ARCH-01F's Risk #6 (PII depth) is addressed to column grain, not left as a table-level generality.
- [ ] Cross-jurisdiction legal classification of academic records (Known Issues, below) — **not** resolved by this phase; requires Phase B input.
- [ ] `raw_responses` retention/erasure policy — **not** resolved by this phase; requires Phase B input.

## Acceptance Checklist

- [x] No SQL present anywhere in this document, per Phase A's constraint.
- [x] No architectural decision from WP-ARCH-01B/C/D/E is reopened or contradicted.
- [x] Every deviation from a literal 1:1 logical-to-physical translation (Part 3's two exceptions, Part 7.9's generated-column decision) is explicitly justified with a citation back to specific evidence or a specific WP-ARCH-01C/WP-ARCH-01F clause.
- [x] Document is structured for direct handoff into Phase B (Security Architecture) and Phase D (Canonical Schema Implementation) without requiring re-derivation of any decision made here.

## Known Issues

1. **Cross-jurisdiction data classification for academic records is not resolved here.** Several jurisdictions within HireRise's stated multi-country scope classify academic/education records as a distinct legally protected category (separate from general PII regimes). This phase flags `academic_record`/`subject_performance` as "Confidential, jurisdiction-aware" but does not, and should not, attempt to enumerate per-jurisdiction legal requirements — that is a Phase B input requiring compliance/legal review, not a data-modeling decision.
2. **`cognitive_assessment_result.raw_responses` retention/erasure policy is undecided.** This phase isolates the column (Restricted, column-level encryption recommended) but does not set a retention period — that is a Phase B/product decision this phase deliberately does not make unilaterally.
3. **`academic_context` historical-version physical retention policy is undecided.** WP-ARCH-01C Part 9.3 permits shorter retention for projections than for source data, since they're replay-reconstructable; whether non-current `academic_context` rows are purged, archived, or retained indefinitely is an operational decision for Phase D/H, not this phase.
4. **Assessment score scale bounds** (`cognitive_assessment_result`'s five score columns) are noted as needing a `CHECK` constraint scoped to `assessment_version`, but the actual scale (0–100? a normalized float?) was never located in the repository evidence (WP-ARCH-01A.2 §2.12 — "repository evidence is insufficient to determine ... where the scoring computation happens"). This phase reserves the column type (`numeric(5,2)`) but the bound itself is a Phase D input pending that investigation (already scheduled as WP-ARCH-01F Part 5, Risk #1, targeted at WP-ARCH-01E Phase 10).
5. **Cross-qualification integrity for `subject_performance`** (Part 5) requires a trigger-based constraint, not a plain FK — flagged for Phase D, not resolved here, since Phase A's own scope excludes triggers other than by name-flagging.

## Recommended Next Phase

**Phase B — Enterprise Security Architecture**, specifically prioritized to first resolve Known Issues #1 and #2 above (jurisdiction-aware classification, `raw_responses` retention) before completing the full RLS/role/tenant-isolation design, since both directly gate how Phase B's row- and column-level policies for `cognitive_assessment_result` and `academic_record` must be shaped.

---

**STOP. Awaiting approval before proceeding to Phase B.**
