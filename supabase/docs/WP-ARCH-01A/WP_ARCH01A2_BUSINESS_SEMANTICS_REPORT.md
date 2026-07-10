# WP-ARCH-01A.2 — Enterprise Domain Semantic Investigation
## Student Academic Domain — Business Semantics Report

**Type:** Investigation only. No architecture, schema, or migration recommendations are made in this document, per scope constraints.
**Predecessor:** WP-ARCH-01A (`WP_ARCH01A_REPOSITORY_EVIDENCE_REPORT.md`) — repository evidence, not repeated here except where corroborating or revising a specific prior finding (flagged explicitly where that happens).
**Method note:** This pass reads business logic — services, validators, migration comments, RPC bodies, and self-documenting architecture notes left in the code — rather than only counting/locating files. Several findings below **update** WP-ARCH-01A's confidence levels because this pass found direct evidence (a table being queried via `.rpc()` rather than `.from()`, for example) that a file-grep pass would miss. Each such update is marked **[REVISES WP-ARCH-01A]**.

---

## 0. Summary of Material Findings Beyond WP-ARCH-01A

1. **[REVISES WP-ARCH-01A]** `student_education_profiles` is a **confirmed real backend table**, not just a frontend contract name. `student-onboarding/services/education.service.js` queries it directly with `supabase.from('student_education_profiles')`, and it is defined with full constraints in `20260518000001_student_onboarding_foundation.sql`.
2. **[REVISES WP-ARCH-01A]** `student_academic_profiles`, `student_subject_selections`, and `student_language_preferences` are **confirmed live in production**, contradicting the prior "not confirmed" status. The evidence was invisible to a `.from('table_name')` grep because the frontend accesses them exclusively through Supabase RPC functions (`supabase.rpc('fn_...')`) called directly from `front/src/api/academicOnboardingApi.ts` — bypassing the Node backend entirely. The migration `20260527000003_phase2b_student_academic_rpcs_evolution.sql` documents their live production column state directly in its header comments.
3. **New finding:** the frontend code path that calls these RPCs (`useStudentAcademicProfile`, `useOnboardingMutations`) is **fully built but not wired into any active page or route**. The one file that demonstrates how to use it, `services/academicHooks.usage.ts`, is explicitly commented "NOT imported at runtime — it exists as a reference for contributors." This is a third, independent academic-data pathway that is schema-live but UI-dead.
4. **New finding:** `student-onboarding/services/recommendation-engine.js` — which **is** mounted and reachable (`server.js` → `/student-onboarding` → lazy-loaded inside the route handler) — queries six table names via `.from()`: `student_academics_profiles`, `student_interests_profiles`, `student_learning_styles`, `student_exposure_profiles`, `student_financial_profiles`, plus `student_education_profiles` (confirmed real, see #1). **None of the first five appear in any migration file in the repository.** This is a live, reachable code path querying tables with no confirmed schema origin.
5. **New finding:** the `edu_*` family (education-intelligence) and the `student_academic_*` family (student-onboarding) differ not just in name but in **lifecycle model**: `student_academic_records`/`subjects` are year-keyed, upsert-per-year, additive (Section 3.1); `edu_academic_records`/`edu_extracurricular` are **replace-all-per-student** via an atomic RPC (`replace_student_academic_records`) with no year dimension at all (Section 3.2). These are not just duplicate schemas — they encode different business models of "what an academic record is."
6. **New finding:** `knowledge-runtime/student/studentIntelligence.service.js` contains the single richest first-party business-semantics document in the repository — extensive header comments explaining exactly which fields are wired, which are deliberately not wired, and why, including a four-way naming collision on "career interests" across `student_career_profiles`, `users.career_goal`, `user_profiles.data.career_goals`, and `user_personalization_profile.career_interests`. This is treated as primary evidence throughout Section 7.

---

## 1. Business Concept Catalogue

This catalogue lists every distinct academic-domain entity found with a business role, independent of which "family" it belongs to. "Confirmed" means direct evidence (schema + at least one query site); "Asserted only" means the concept is referenced in code/comments but no schema origin was found.

| # | Concept | Status | Confirmed via |
|---|---|---|---|
| 1 | Academic year record (header row) | Confirmed | `student_academic_records` — repository + migration |
| 2 | Academic subject result | Confirmed | `student_academic_subjects` — repository + migration |
| 3 | Education profile (level/board/school type) | Confirmed | `student_education_profiles` — service + migration |
| 4 | Onboarding session/progression | Confirmed | `student_onboarding_sessions` — migration, used by every step service |
| 5 | Taxonomy-driven academic profile | Confirmed (live, unwired UI) | `student_academic_profiles` — RPC evolution migration + frontend RPC caller |
| 6 | Taxonomy-driven subject selection | Confirmed (live, unwired UI) | `student_subject_selections` — same evidence as #5 |
| 7 | Taxonomy-driven language preference | Confirmed (live, unwired UI) | `student_language_preferences` — same evidence as #5 |
| 8 | Legacy/parallel student profile | Confirmed | `edu_students` — model + repository |
| 9 | Legacy/parallel academic record (replace-all) | Confirmed | `edu_academic_records` — model + repository |
| 10 | Legacy/parallel extracurricular record (replace-all) | Confirmed | `edu_extracurricular` — model + repository |
| 11 | Legacy/parallel cognitive result | Confirmed | `edu_cognitive_results` — model + repository |
| 12 | Legacy/parallel derived stream score | Confirmed | `edu_stream_scores` — model + repository, clearly derived (see Section 3.2) |
| 13 | Career profile (interests/curiosities) | Confirmed | `student_career_profiles` — migration `000_initial_schema.sql`, consumed by `knowledge-runtime` |
| 14 | "Academics profile" (typo variant) | **Asserted only** | `student_academics_profiles` — queried in `recommendation-engine.js`; no migration defines it |
| 15 | Student interests profile | **Asserted only** | queried in `recommendation-engine.js`; no migration found |
| 16 | Student learning style profile | **Asserted only** | queried in `recommendation-engine.js`; no migration found |
| 17 | Student exposure profile | **Asserted only** | queried in `recommendation-engine.js`; no migration found |
| 18 | Student financial profile | **Asserted only** | queried in `recommendation-engine.js`; no migration found |
| 19 | Career/education ROI, digital twin, simulation entities | Confirmed, out of academic scope proper | `edu_education_roi`, `edu_career_simulations`, `lmi_career_predictions` — named in `TABLES` map but not part of the 12 canonical entities under investigation; noted for completeness only |

Repository evidence is insufficient to determine whether concepts #14–18 are dead code, a schema that was never migrated, or a schema created directly in the Supabase dashboard outside the migration pipeline. All three are structurally possible from the evidence available and none is preferred here.

---

## 2. Entity Semantic Profiles

For each of the 12 entities named in the brief, plus the additional entities discovered.

### 2.1 `student_academic_records`
- **Purpose:** the "header" row for one student's academic performance in one academic year (class 8–12) — board, completion state, subject count.
- **Business meaning:** represents a school year as a unit of academic history, independent of its subjects.
- **Primary owner (module):** `student-onboarding`.
- **Created/updated by:** the student, via `POST /step/academics` → `academic.service.js#saveAcademicsStep` → `academic.repository.js#upsertAcademicRecord`. Upsert-only; no separate create vs. update path in application code.
- **Consumed by:** `academic.service.js#getAcademicsStep` (read-back for the onboarding UI); `knowledge-runtime` is aware of the sibling `student_academic_subjects` table but explicitly has **not** wired either table in as of this repository snapshot (Section 7.1).
- **Immutable:** No — same row is upserted repeatedly as the student edits a year (`onConflict: 'user_id,academic_year'`).
- **Versioned/historical:** No — one row per (user, year); re-saving a year overwrites it. It is historical only in the sense that multiple years coexist as separate rows; it does not retain prior states of the same year.
- **Operational:** Yes (transactional, written by end-user action).
- **Analytical/derived:** No — the row itself is user-entered; `percentage`/`subject_count` on the *subject* table are derived (Section 2.2), but the record row's fields (`board_type`, `is_partial`, `is_predicted`) are direct user input.
- **Temporary:** No, but `is_partial = true` rows are an explicit "draft" state distinguished from "committed" (`is_partial = false`) — see Section 4 (lifecycle) and Section 5 (invariants).
- **Canonical:** Per WP-ARCH-01A's naming, yes — this is the Phase-2 canonical table for this concept, actively written and read.

### 2.2 `student_academic_subjects`
- **Purpose:** one row per subject result within one academic year.
- **Business meaning:** the atomic unit of academic performance data — a single subject's marks/grade for a single year.
- **Primary owner:** `student-onboarding`.
- **Created/updated by:** student, via the same `saveAcademicsStep` flow, batch-upserted per year (`upsertAcademicSubjects`).
- **Deleted by:** the same flow — `deleteRemovedSubjects` removes rows for a year that are no longer present in a re-save payload. This is an explicit, code-documented **destructive** operation triggered by ordinary user re-save (not an admin or cleanup process).
- **Consumed by:** `academic.service.js` (read-back); referenced-but-not-wired by `knowledge-runtime` (Section 7.1).
- **Immutable:** No.
- **Versioned/historical:** No — same overwrite-on-conflict model as the parent record (`onConflict: 'user_id,academic_year,subject'`).
- **Derived fields within the row:** `percentage` is computed server-side from `marks_obtained`/`max_marks` (or inferred from `grade` when marks are absent) by `academic-normalization.js#normalizeSubjectEntry`, then persisted — i.e., the row is a mix of user-entered fields (`marks_obtained`, `max_marks`, `grade`, `subject`) and one derived-and-stored field (`percentage`). `grade` itself can also be *inferred* from percentage when absent (`inferGradeFromPercentage`), meaning `grade` is sometimes user-entered and sometimes derived, with no column-level flag distinguishing which case produced a given row — `percentage_source` (`'marks'` / `'grade_inference'` / `'none'`) exists in the normalization function's return shape but the migration's column list does not include a persisted `percentage_source` or `grade_source` column, so this distinction is not preserved in storage, only in the transient API response.
- **Operational:** Yes.
- **Analytical:** Partially — the stored `percentage` column exists explicitly "for analytics performance" per the migration's own comment, and there are two indexes (`idx_academic_subjects_subject_year`, `idx_academic_subjects_percentage`) whose comments state they exist for "future velocity analysis" and "future: stream affinity" respectively — i.e., the schema was built in anticipation of analytical consumers that, per Section 7, do not yet exist in the codebase.
- **Canonical:** Yes, per the same reasoning as 2.1.

### 2.3 `student_education_profiles`
- **Purpose:** one row per student capturing `education_level`, `board_type`, `school_type` — the first step of onboarding.
- **Business meaning:** the student's current schooling context, as distinct from their historical per-year academic performance (2.1/2.2).
- **Primary owner:** `student-onboarding` (backend service: `education.service.js`); also consumed as an API-contract shape by the frontend onboarding module (per WP-ARCH-01A). **[REVISES WP-ARCH-01A]** — this pass confirms it as a real backend-owned table, not merely a frontend DTO name; see Finding #1.
- **Created/updated by:** student, via `upsertEducationProfile` — single-row upsert on `user_id` (unique constraint), i.e. **one profile per student, always fully replaced**, never year-keyed.
- **Consumed by:** `education.service.js#getEducationProfile` (onboarding UI read-back); `recommendation-engine.js` (as `education` in its aggregation, Section 2.11); `knowledge-runtime`'s `studentIntelligence.service.js` explicitly reuses `educationProfileService#getEducationProfile` read-only (Section 7.1) — this is the **one** piece of the "academic" domain that `knowledge-runtime` has actually wired in as of this snapshot.
- **Immutable:** No.
- **Versioned/historical:** No — single current-state row per student.
- **Derived/temporary:** No — direct user input, no derived fields.
- **Canonical:** Yes — confirmed table, confirmed live consumer in the one runtime that matters most for this WP (`knowledge-runtime`).

### 2.4 `student_academics_profiles` (typo variant — "academics" plural)
- **Purpose:** cannot be determined from repository evidence — no CREATE TABLE, no comment describing its intended shape beyond the two fields destructured from it (`subjects_json`) in `recommendation-engine.js`.
- **Business meaning:** apparently intended to hold a JSONB blob of subjects (`academics.subjects_json`) rather than the normalized per-subject rows used by `student_academic_subjects` (2.2) — i.e., even where this table's *name* nearly duplicates a confirmed table, its *shape*, as used by the one call site, is structurally different (denormalized JSON vs. normalized rows).
- **Owner:** `student-onboarding` (only call site).
- **Repository evidence is insufficient to determine** whether this is: (a) a dead reference to a table that was never created, (b) a table created outside the migration pipeline, or (c) a renamed/abandoned predecessor of `student_academic_profiles` (2.6) that the RPC-evolution migration's header comments describe as the "live" taxonomy table. Given `student_academic_profiles` (singular "academic") is independently confirmed live with a different, non-JSON-blob shape (Section 2.6), this is evidence that `student_academics_profiles` (plural) is a **third, distinct spelling** referring to a **fourth, unconfirmed** structure — not simply a typo for one of the other two.

### 2.5 `student_education_profiles` vs. `student_academic_profiles` vs. `student_academics_profiles` — terminology note
See Section 6 for full terminology analysis; flagged here because these three names are easy to conflate and this report treats them as three separate concepts per the evidence above, not as spelling variants of one concept.

### 2.6 `student_academic_profiles`
- **Purpose:** the taxonomy-driven "one row per student" academic profile — country, region, board, stream, current class, target year — used by the RPC-based onboarding path.
- **Business meaning:** a richer, internationalized/normalized version of the same concept `student_education_profiles` (2.3) captures more narrowly (education level/board/school type only). The two are not confirmed to be reconciled with each other anywhere in the codebase.
- **Primary owner:** ambiguous by module-directory convention (no backend module directory corresponds to it — see Section 8) but by call-site evidence, it is owned by the **frontend**, which talks to it directly via Supabase RPC, with no Node backend involvement at all.
- **Created/updated by:** `fn_create_student_academic_profile(...)` RPC, called from `createAcademicProfile()` in `academicOnboardingApi.ts`. The RPC is documented as idempotent ("safe to call again if onboarding is replayed from the start"), consistent with an upsert-per-student pattern like 2.1's record-level upsert, but scoped to the whole profile rather than a single year.
- **Consumed by:** `fn_get_student_full_profile()` RPC (`getStudentFullProfile()`), which the migration's own comment states returns "profile + subjects + languages + onboarding_status + is_complete" as one composed shape — i.e., this table is the aggregate root of a three-table family (2.6/2.7/2.8) at the RPC layer, distinct from how 2.1/2.2 compose (two tables joined by the calling service, not a DB-side RPC).
- **Keying:** uses `auth_user_id` as its canonical user FK column (explicitly, per migration comment: "NOT renamed") — different column name from every other table in this catalogue, all of which use `user_id`. The evolution migration adds a *denormalized* `user_id`-named column onto the two child tables only (2.7/2.8), not onto this table itself.
- **Immutable/versioned:** No — `onboarding_completed_at` timestamp plus `is_active` boolean suggest single current-state-per-student, not historical.
- **Derived fields:** `taxonomy_hash_at_save` — described in the migration as a "replay audit anchor," i.e., a derived integrity/versioning field, not user input.
- **Operational vs. analytical:** Operational (transactional onboarding data).
- **Canonical:** Live in production per direct migration-comment evidence, but **not reachable through any currently-routed frontend page** — see Finding #3. Whether it is "canonical" in the sense of being the intended long-term source of truth cannot be determined from repository evidence; it is simply the newest and richest of the competing schemas by field count.

### 2.7 `student_subject_selections`
- **Purpose:** child table of `student_academic_profiles` (2.6) — one row per subject the student has selected (not scored — no marks/grade columns exist here at all).
- **Business meaning:** this is a materially **different concept** from `student_academic_subjects` (2.2). 2.2 records subject *performance* (marks, grade, percentage); 2.7 records subject *selection/enrollment* only (`is_primary`, `is_elective`, `subject_code`), with no scoring fields whatsoever. These two tables are not interchangeable even though both are named "subjects."
- **Owner:** frontend, via RPC (same pathway as 2.6).
- **Created/updated by:** `fn_save_student_subjects(p_subject_ids UUID[])`, documented in the frontend caller as "Replaces any existing selection — not additive" and "Idempotent" — i.e., **replace-all semantics per call**, not per-row upsert like 2.2.
- **FK:** `student_profile_id` → 2.6 (not a direct `user_id` FK on the original live table; `user_id` was added only as a denormalized convenience column by the evolution migration).
- **Ordering:** `sort_order` — explicitly a **display-order** field, described as "deterministic display order... reassigned on next `fn_save_student_subjects()` call," i.e., a UI-presentation concern persisted at the data layer, not an academic-performance concern.
- **Versioned/historical:** No — replace-all, current-state only.
- **Derived:** `taxonomy_hash_at_save`, same audit-anchor pattern as 2.6.

### 2.8 `student_language_preferences`
- **Purpose:** child table of `student_academic_profiles` (2.6) — one row per language the student has selected, with `proficiency_level`, `is_primary`.
- **Business meaning:** distinct from `student_education_profiles.board_type`/`school_type`. This is the only entity in the catalogue where "language" is modeled as **tied to the student's academic profile**, not to a qualification, institution, or subject — see Section 5 (invariants) for the specific invariant this establishes.
- **Owner/created/updated:** same pattern as 2.7 — `fn_save_student_languages(p_medium_language_ids, p_additional_language_ids)`, replace-all, idempotent, via frontend RPC.
- **Distinguishes "medium of instruction" from "additional languages"** at the RPC parameter level (`p_medium_language_ids` vs. `p_additional_language_ids`) — a business distinction (language you're taught *in* vs. a language you *study*) that has no equivalent field anywhere in the `student_academic_records`/`student_education_profiles` families.
- **Versioned/historical:** No.

### 2.9 `edu_students`
- **Purpose:** the core student row in the legacy/parallel `edu_*` family — id, name, email, education_level, onboarding_step.
- **Owner:** `education-intelligence`.
- **Created/updated by:** `upsertStudent` (single-row upsert keyed on `id = userId`, i.e., the student's row ID **is** their auth user ID, no separate surrogate key) and `setOnboardingStep` (partial update of one column).
- **Business meaning:** functions as this family's version of both `student_education_profiles` (2.3) *and* a session-tracking row (`onboarding_step`), collapsed into one table — where the `student_academic_*` family split "education profile" and "onboarding session" into two separate tables (`student_education_profiles` + `student_onboarding_sessions`).
- **Consumed by:** `studentMatching.service.js` (per WP-ARCH-01A); `knowledge-runtime`'s `studentIntelligence.service.js`, which explicitly sources its "legacy, thin fields" from here and separately calls out `edu_students.skills` (a flat text array) as the only skills source currently wired in, pending a "structured skills" source that the service's own comments say was not found.
- **Immutable/historical:** No — single current-state row per student, same as 2.3/2.6.

### 2.10 `edu_academic_records`
- **Purpose:** subject/class-level marks record in the legacy family.
- **Business meaning:** **structurally simpler** than 2.1/2.2 combined — a flat row of `{ student_id, subject, class_level, marks }` with no board, no percentage, no grade, no partial/predicted flags.
- **Owner:** `education-intelligence`.
- **Created/updated by:** `replaceAcademicRecords(studentId, records)` → `atomicReplace('replace_student_academic_records', ...)`, a **DB-side RPC that performs DELETE + INSERT inside one transaction**. This is a **materially different lifecycle model** from 2.1/2.2: the entire set of a student's academic records is replaced atomically on every save, with no per-year or per-subject upsert-by-key — there is no unique constraint evidence of one row per (student, class_level, subject) at the application layer; uniqueness is enforced procedurally by "delete everything, insert what was sent," not declaratively.
- **Historical/append-only:** **No** — this is the opposite of append-only. A save that omits a prior class's data would delete that class's rows.

### 2.11 `edu_extracurricular`
- Same replace-all lifecycle pattern as 2.10, via a parallel `replaceActivities`/atomic-RPC pair (name not independently confirmed but structurally identical per the repository function inventory in Section 1 evidence above).
- **Business meaning:** activity/extracurricular records, structurally analogous to 2.10 but for non-academic activities.

### 2.12 `edu_cognitive_results`
- **Purpose:** stores cognitive-assessment scores — `analytical_score`, `logical_score`, `memory_score`, `communication_score`, `creativity_score`, plus a `raw_answers` JSONB blob.
- **Created/updated by:** `upsertCognitive` — single-row upsert (not replace-all), unlike 2.10/2.11.
- **Business meaning:** these are **assessment outputs**, not directly user-entered free text — `raw_answers` is the closest thing to raw input; the five named scores are computed from `raw_answers` by logic not in this repository path (or not found in this pass — repository evidence is insufficient to state where the scoring computation happens).
- **Derived:** the five score fields are analytical/derived relative to `raw_answers`; the row as a whole is operational (written once per assessment attempt, upserted).

### 2.13 `edu_stream_scores`
- **Purpose:** `engineering_score`, `medical_score`, `commerce_score`, `humanities_score`, `recommended_stream`, `confidence`, `engine_version`, `calculated_at`.
- **Business meaning:** this is the clearest example in the whole catalogue of a **purely derived/analytical entity** — every field is a computed output, there is no user-entered field on this table at all. `initStreamScores` creates an all-null placeholder row (per `buildStreamScoreRow` in the model), to be filled in by a scoring process elsewhere.
- **Owner:** `education-intelligence`.
- **Consumed by:** `studentMatching.service.js` (per WP-ARCH-01A); this pass found no evidence it is consumed by `knowledge-runtime`.
- **Versioned:** partially — `engine_version` and `calculated_at` suggest the row is meant to be re-computed and know which engine version produced it, but the repository function inventory shows only `getStreamScores`/`initStreamScores`, no scored-write function in this file — repository evidence is insufficient to state where/how the score fields actually get populated.

---

## 3. Business Lifecycle Matrix

| Entity | Created by | Modified by | Append-only? | Snapshot/replace-all? | Historical? | User-entered? | Derived? |
|---|---|---|---|---|---|---|---|
| `student_academic_records` | Student (save step) | Student (re-save) | No | Per-year upsert (not whole-set replace) | Only across years, not within a year | Yes | No |
| `student_academic_subjects` | Student (save step) | Student (re-save); can be deleted on re-save | No | Per-(year,subject) upsert; explicit stale-row deletion | No | Mostly (percentage is derived-and-stored) | Partially |
| `student_education_profiles` | Student (onboarding step 2) | Student (re-save) | No | Whole-row upsert, 1 row/student | No | Yes | No |
| `student_academic_profiles` | Student, via RPC | Student, via RPC (idempotent create) | No | Whole-row, 1 row/student | No (but has an audit-anchor hash field) | Yes | `taxonomy_hash_at_save` only |
| `student_subject_selections` | Student, via RPC | Student, via RPC | No | **Whole-set replace per call** | No | Yes | `sort_order`, `taxonomy_hash_at_save` |
| `student_language_preferences` | Student, via RPC | Student, via RPC | No | **Whole-set replace per call** | No | Yes | `sort_order`, `taxonomy_hash_at_save` |
| `edu_students` | Student (legacy onboarding) | Student; step tracked in same row | No | Whole-row upsert, 1 row/student | No | Yes | No |
| `edu_academic_records` | Student (legacy save) | Student (legacy re-save) | No | **Whole-set replace, DB-side transaction** | No | Yes | No |
| `edu_extracurricular` | Student (legacy save) | Student (legacy re-save) | No | **Whole-set replace, DB-side transaction** | No | Yes | No |
| `edu_cognitive_results` | Assessment flow | Assessment flow (re-take) | No | 1 row/student upsert | No | Partially (`raw_answers` only) | Yes (5 score fields) |
| `edu_stream_scores` | Assessment/scoring flow (init) | Scoring engine (not found in this repository path) | No | 1 row/student | No | No | Yes, entirely |
| `student_academics_profiles`, `student_interests_profiles`, `student_learning_styles`, `student_exposure_profiles`, `student_financial_profiles` | Unknown | Unknown | Unknown | Unknown | Unknown | Presumed yes, given call-site field names (`subjects_json`, `responses_json`) | Unknown |

For the last row: **repository evidence is insufficient to determine this business semantic** for any lifecycle property — no migration, no repository file, and no comment describing intended behavior was found for these five names beyond their use as `.from()` targets and the specific fields destructured from their query results in `recommendation-engine.js`.

---

## 4. Business Invariants

Only invariants directly supported by constraints, unique keys, or enforced code paths are listed. Each is tied to its evidence.

| Invariant | Supported? | Evidence |
|---|---|---|
| One education profile per student | **Yes** | `student_education_profiles_user_id_key UNIQUE (user_id)` |
| One academic-profile (taxonomy family) per student | **Yes** | `student_academic_profiles` uses `auth_user_id` as its keying column with upsert-style `fn_create_student_academic_profile` behavior described as idempotent; no explicit UNIQUE constraint text was captured in this pass, so this is inferred from RPC behavior, not a directly-read constraint — treat as probable, not fully confirmed at the DDL level. |
| Many academic records per student (one per academic year) | **Yes** | `uq_academic_record_user_year UNIQUE (user_id, academic_year)` — multiple rows per student, one per year |
| Many subjects per academic record | **Yes** | `record_id` FK on `student_academic_subjects` → `student_academic_records.id`, plus `uq_academic_subject_user_year_subject UNIQUE (user_id, academic_year, subject)` — many subject rows per record |
| One board per academic year (not per qualification/student) | **Yes, but scoped narrowly** | `board_type` lives on `student_academic_records`, i.e., scoped **per year**, not per student and not per "qualification" (no qualification entity was found tied to board). The migration's own comment notes the year-level `board_type` "may differ from `student_education_profiles.board_type` if the student transferred" — i.e., the schema explicitly anticipates board changing per year, and explicitly does NOT assume one board per student. |
| One curriculum per qualification | **Repository evidence is insufficient to determine this business semantic.** | No "curriculum" or "qualification" entity/column was found anywhere in the 12 investigated entities or their migrations. |
| Language tied to student | **Yes, in one specific family only** | `student_language_preferences.student_profile_id` → `student_academic_profiles` (student-level), with the added denormalized `user_id` also student-scoped. |
| Language tied to qualification | **No supporting evidence found.** | No qualification entity exists to tie it to. |
| Language tied to institution | **No supporting evidence found.** | No institution entity was found among the investigated tables. |
| Subjects tied to semester | **No supporting evidence found.** | "Semester" does not appear as a column anywhere in the investigated schema; WP-ARCH-01A's keyword scan found exactly 1 file-match for "semester" across the codebase, outside the entities in scope here. |
| Subjects tied to examination | **No supporting evidence found.** | No "examination" entity/column found in the investigated schema. |
| Subjects tied to curriculum | **No supporting evidence found.** | Same reasoning as "one curriculum per qualification" above. |
| Subjects tied to board | **Indirectly, via the year record** | `student_academic_subjects` does not itself carry a `board_type` column; board is a property of the parent `student_academic_records` row, i.e., subjects are tied to board only transitively, through the year they belong to — not directly. |
| Marks cannot exceed max marks | **Yes** | Enforced twice: at the application layer (`academics.validator.js` — `marks_obtained cannot exceed max_marks`) and structurally implied at the DB layer via separate CHECK constraints on each column (no cross-column CHECK was found in the migration text captured, so the DB-level enforcement of the *relationship* between the two columns is not independently confirmed — only the application layer confirms the relationship itself). |
| Duplicate subjects within a year are rejected | **Yes** | `academics.validator.js#validateAcademicYear` explicitly checks a `seenSubjects` set and throws on duplicates, in addition to the DB's own `UNIQUE (user_id, academic_year, subject)` constraint. |
| Partial saves are permitted (a record need not be complete) | **Yes** | `is_partial` boolean is a first-class, explicitly documented concept at both the record level (`student_academic_records.is_partial`) and the signal-quality evaluator, which filters out partial years before counting toward "sufficiency." |

---

## 5. Aggregate Behavior Observations

Reported as observed behavior only — no aggregate design is proposed.

- **`student_academic_records` behaves as an aggregate root for `student_academic_subjects`** within the student-onboarding family: the service layer always writes the record row first, then the subject rows referencing its `id`, and deletes subject rows scoped to a `(user_id, academic_year)` pair that maps 1:1 to a single record row. Subjects are never written without a parent record existing first (evidenced by `academic.service.js#saveAcademicsStep`'s ordering: `upsertAcademicRecord` → `deleteRemovedSubjects` → `upsertAcademicSubjects`).
- **`student_academic_profiles` behaves as an aggregate root for `student_subject_selections` and `student_language_preferences`** at the RPC layer: `fn_get_student_full_profile()` is documented to return all three as one composed shape, and the two child tables reference `student_profile_id`. This is a **DB-side** aggregate composition (a single RPC call), structurally different from the **application-side** aggregate composition used by `student_academic_records`/`subjects` (two separate Supabase calls, joined in JS).
- **`edu_students` behaves as a loose parent** for `edu_academic_records`/`edu_extracurricular`/`edu_cognitive_results`/`edu_stream_scores` via `student_id` FKs (per the row builders in `student.model.js`), but the *replace-all* write pattern (Section 2.10/2.11) means the "child" rows are not incrementally added to the aggregate the way `student_academic_subjects` rows are — the whole child set is a single unit that gets discarded and rebuilt together, which behaves more like a **value object / embedded document** pattern reimplemented as separate SQL rows than like a true independently-addressable child entity.
- **`edu_stream_scores` behaves as a derived/projection entity**, not a child entity of anything the student writes directly — no code path in this repository writes score values to it (only `initStreamScores`, which nulls everything out). It is a placeholder whose actual population source was not found in this investigation pass.
- **No entity in this catalogue shows event-sourcing behavior** (i.e., no table stores a sequence of state-change events; every table stores current state, replaced or upserted in place). This applies uniformly across all three families.
- **No entity in this catalogue shows snapshot-versioning behavior** in the sense of retaining multiple historical states of the same logical row under version numbers — the closest thing is `taxonomy_hash_at_save` (Section 2.6–2.8), which records a hash of the taxonomy *at time of save* for audit/replay purposes, but does not itself version the row's own data across saves.

---

## 6. Business Terminology Analysis

| Term(s) | Same concept or different? | Evidence |
|---|---|---|
| "Academic Profile" (`student_academic_profiles`) vs. "Education Profile" (`student_education_profiles`) | **Different concepts**, per confirmed schema: Education Profile = `{education_level, board_type, school_type}` (3 fields, India-board-centric); Academic Profile = `{country_code, region_code, board_code, stream_code, current_class, target_year, ...}` (internationalized taxonomy, more fields). Both are "one row per student," both are live, neither references the other. |
| "Academic Profile" (`student_academic_profiles`, singular) vs. "Academics Profile" (`student_academics_profiles`, plural, in `recommendation-engine.js`) | **Cannot be confirmed as the same concept.** The singular is a confirmed live table with a documented column set (Section 2.6). The plural has no migration and is queried with a shape (`subjects_json` JSONB blob) inconsistent with the singular table's documented columns. Treated as distinct per Section 2.4's reasoning — this is the clearest unresolved terminology ambiguity in the domain. |
| "Academic Record" (`student_academic_records`, `edu_academic_records`) | **Different concepts sharing a name**, per Section 2.10's lifecycle-model comparison — one is year-keyed/upsert, the other is a flat, replace-all set with no year dimension in its own row shape (year is called `class_level`, a same-purpose but differently-named column). |
| "Academic Subject" (`student_academic_subjects`) vs. "Subject Selection" (`student_subject_selections`) | **Different concepts**, per Section 2.7: one records performance (marks/grade), the other records enrollment/selection only, with zero performance fields. |
| "Board" | Used consistently as an educational-board concept (CBSE/ICSE/state/IB/other) across `student_education_profiles.board_type`, `student_academic_records.board_type`, and `student_academic_profiles.board_code` — same underlying real-world concept, three separate columns in three separate tables, not reconciled by any join or shared lookup table found in this pass, aside from `academic_boards` being named as the backfill source for `board_code` in the evolution migration's comments (a taxonomy/lookup table not otherwise investigated here as it is out of the 12 named entities). |
| "Curriculum," "Qualification," "Institution," "School," "College," "University" | **No entity found using these terms as a first-class column or table name** within the 12 investigated entities or their direct dependencies. `school_type` exists (government/private/aided — a school *ownership category*, not a specific school/institution identity). No "institution," "college," or "university" entity was found tied to the student-academic domain in this pass; WP-ARCH-01A's keyword scan found low file counts for these terms generally (12, 22, 3, 17 respectively), consistent with them belonging to a different domain (e.g., the separate `university`/`school` modules seen in the module listing, which were out of scope for this WP and not investigated here). |
| DTO vs. database entity vs. view model | `student_education_profiles` was, prior to this pass, suspected by WP-ARCH-01A to be "a frontend contract name, not confirmed 1:1 with any table." This pass confirms it **is** a database entity, directly queried — not merely a DTO shape. No other naming ambiguity of this specific "DTO vs. table" kind was found for the other 11 entities; each of the other 11 is confirmed as a real table by direct query-site or migration evidence. |

---

## 7. Runtime Semantic Dependencies

### 7.1 Student Context Runtime (`knowledge-runtime/student/studentIntelligence.service.js`, class `StudentService`)
- **Required academic inputs, as wired today:** `education-intelligence/repositories/student.repository.js` (`edu_students`, read-only, "legacy, thin fields") and `student-onboarding/services/education.service.js#getEducationProfile` (`student_education_profiles`, read-only).
- **Required academic inputs, explicitly NOT wired:** stream, subjects (`student_academic_subjects` — explicitly named in a code comment as "located but not wired into this composition — needs confirmation of shape before reuse"), current semester/year, FYUGP status, structured skills, experience, preferences, resume signals, qualifications. The service represents each of these in its output shape as `available: false` with a `note`, rather than omitting them — a deliberate transparency pattern documented in the file's own header.
- **Career-related fields wired in, with a four-way naming collision documented:** `career.interests` (from `student_career_profiles`, student-onboarding track) and `career.goals` (from `users.career_goal` / `user_profiles.data.career_goals`, professional-onboarding track), reconciled with an explicit precedence rule (structured array wins over the single text field). Two further candidate sources — `user_personalization_profile.career_interests` and an `ai-career-advisor` read path — are explicitly left unwired, with the service's own comments stating the reason is unresolved ownership/architecture ambiguity, not a technical blocker.
- **Expected output:** a composed "student runtime context" object, cached (`CACHE_KEY_PREFIX = 'student-runtime:'`, ~300s TTL with jitter).
- **Read-only:** Yes — the file's own header states "does not own CRUD for any of it," and every dependency listed is a `get*` call, no writes.
- **Derived:** Yes — this is explicitly a composition/computation layer, not a data owner, per both this pass and WP-ARCH-01A's Module Responsibility Matrix.
- **Authoritative:** No — by design, it defers to `education-intelligence` and `student-onboarding` as the owning systems of record for any field it surfaces.

### 7.2 Recommendation Engine (`knowledge-runtime/recommendation/recommendation.service.js`)
- **Required academic inputs:** none directly — it depends exclusively on an injected `studentService` instance (`StudentService`, Section 7.1) and `knowledgeService`; the constructor throws if `studentService` is not provided.
- **Business dependency:** entirely transitive through `StudentService.getStudentIntelligenceProfile(userId)` — whatever academic data `StudentService` does or does not surface (Section 7.1) is what `RecommendationService` can see. It has no independent repository access of its own to any academic table.
- **Read-only, derived, non-authoritative:** consistent with 7.1 — it is one layer further removed from the data.

### 7.3 A second, unrelated "recommendation engine" (`student-onboarding/services/recommendation-engine.js`)
- This is a **separate, same-named-in-spirit but architecturally distinct** component from 7.2 — it is not part of `knowledge-runtime` at all, does not go through `StudentService`, and instead independently aggregates six raw table reads directly via its own `fetchStudentContext` function (Section 0, Finding #4), feeding them into a prompt for a direct Anthropic API call (`buildAssessmentPrompt`).
- **Required academic inputs:** `student_education_profiles` (confirmed), `student_academics_profiles` (unconfirmed schema, Section 2.4), plus four further unconfirmed tables (interests/learning-style/exposure/financial).
- **Whether authoritative:** the file itself generates a report by direct LLM prompt construction from raw rows — it does not call into `education-intelligence` or `knowledge-runtime` at all, making it a **third, fully independent** path to "student academic intelligence" alongside the `knowledge-runtime` composition (7.1/7.2) and the taxonomy-RPC path (Section 2.6–2.8). Whether this file, `knowledge-runtime`, or neither is intended as the eventual single source of truth cannot be determined from repository evidence.

### 7.4 Education Intelligence engines (ROI, career-success, digital-twin, academic-trend, stream-intelligence, cognitive-profile, activity-analyzer)
Per WP-ARCH-01A's Module Responsibility Matrix (not re-verified line-by-line in this pass, cited as corroborating context): these sit on top of the same `education-intelligence` repository (`edu_*` family) via `services/educationIntelligence.service.js`, documented in that file as the sole sanctioned entry point. This pass's new evidence (Section 2.10–2.13) adds that the *inputs* to these engines are themselves either replace-all snapshots (`edu_academic_records`, `edu_extracurricular`) or upserted current-state rows (`edu_cognitive_results`), never historical series — meaning any "trend" or "velocity" engine reading from this family would be working from single-point-in-time data unless it separately persists its own history, which was outside the scope of the repositories investigated here.

### 7.5 Career Intelligence / FYUGP Intelligence / AI Context Generation
**Repository evidence is insufficient to determine this business semantic** for these three runtimes specifically as they relate to the student-academic entities in scope. `studentIntelligence.service.js`'s header does mention "FYUGP status" as an explicitly-unwired field (Section 7.1), which is the only direct evidence found connecting FYUGP to this domain in this pass; no FYUGP-specific runtime file was independently opened.

---

## 8. Cross-Domain Responsibility Map

Reported as observed module/directory responsibility only — no ownership recommendation is made.

- **`student-onboarding`** — owns the write path for `student_academic_records`, `student_academic_subjects`, `student_education_profiles`, `student_onboarding_sessions`, and (per Section 2.3) is the sole place `getEducationProfile` is exposed for reuse. Also contains `recommendation-engine.js` (Section 7.3), which behaves as its own independent sub-boundary reading additional, partly-unconfirmed tables — this file's responsibilities do not overlap with the rest of the module's otherwise-consistent "one repository file per concept" pattern.
- **`education-intelligence`** — owns the full `edu_*` family read/write path, plus the ROI/career-simulation/career-prediction/stream-intelligence engines layered on top (per WP-ARCH-01A, not re-traced here). Internally consistent replace-all/upsert lifecycle model (Section 3), distinct from `student-onboarding`'s per-year upsert model.
- **The taxonomy-RPC family (`student_academic_profiles`/`student_subject_selections`/`student_language_preferences`)** — has **no corresponding backend module directory** in `core/src/modules`. Its only "owner" by file-location convention is the frontend (`front/src/api/academicOnboardingApi.ts` + the RPC functions themselves, which live in the database, not in either the `core` or `front` application code trees). This is a structurally different ownership shape from every other entity in this catalogue, all of which have a clear owning backend module directory.
- **`knowledge-runtime` (Student Context Runtime)** — composes, does not own; reuses `education-intelligence` and `student-onboarding` read paths (Section 7.1); has zero reuse of the taxonomy-RPC family, either as consumer or as a code comment acknowledging its existence — no reference to `student_academic_profiles`, `student_subject_selections`, or `student_language_preferences` was found anywhere in `knowledge-runtime`.
- **Recommendation / Decision (`knowledge-runtime`)** — consume `StudentService` only, no direct academic-table access (Section 7.2).
- **Boundary observed, not evaluated:** the existence of three structurally different "who owns academic truth" answers — a backend-module-owned family, a frontend/RPC-owned family, and a third ad-hoc family with no confirmed owner at all (Section 2.4/7.3) — is reported here as an observed fact about current responsibility, not flagged as a problem to fix (out of scope for this WP per its constraints).

---

## 9. Business Rule Catalogue

Rules directly observable in validators, service logic, or migration constraints/comments.

1. Academic subject rows cannot exist without a parent academic record row being written first, in the write path (`student_academic_records` → `student_academic_subjects`), enforced by application-layer sequencing and a DB foreign key (`record_id` NOT NULL REFERENCES).
2. A subject's `marks_obtained` cannot exceed its `max_marks` (application-layer validator; Section 4).
3. A student cannot submit the same subject twice within the same academic year (application-layer validator + DB unique constraint; Section 4).
4. An academic year is only "committed" toward onboarding-completion signal quality when `is_partial = false`; partial years are explicitly excluded from the sufficiency calculation (`evaluateAcademicSignalQuality`).
5. Onboarding advances past the "academics" step only when either (a) at least one committed year has ≥4 subjects, or (b) at least 2 committed years each have ≥1 subject — an explicit two-path sufficiency rule with named thresholds (`SUBJECTS_FOR_COMPLETE_YEAR`, `YEARS_FOR_PARTIAL_SUFFICIENCY`).
6. Removing a subject from a year during a re-save is a real delete, not a soft-delete or archive — `deleteRemovedSubjects` issues a hard `DELETE`.
7. A student's board can differ year-to-year (explicit migration comment, Section 2.1) — the schema does not assume board continuity across a student's academic history.
8. Percentage is preferentially computed from marks when both marks and max_marks are present; only falls back to grade-derived inference when marks are absent (`normalizeSubjectEntry`'s stated priority order).
9. `student_subject_selections` and `student_language_preferences` are fully replaced (not incrementally merged) on every save call — selecting a new subject set means resending the complete set, not adding to the prior one (explicit in both the RPC names' comments: "Replaces any existing selection — not additive").
10. `edu_academic_records` and `edu_extracurricular` are likewise fully replaced per save, via an atomic DB-side transaction rather than an application-orchestrated multi-step write (Section 2.10/2.11) — the same "replace, don't merge" business rule as #9, but implemented at a different architectural layer (DB RPC vs. two Supabase calls from JS).
11. Recommendations (`RecommendationService`, Section 7.2) consume academic context only through `StudentService`, never directly — no direct repository dependency on any academic table was found in `recommendation.service.js`.
12. `StudentService` never presents a field as available unless its source has been directly confirmed in code — fields it cannot confirm are explicitly marked unavailable with a note, rather than silently omitted or guessed (Section 7.1) — this is a governance/data-honesty rule enforced by convention in the code, not by any schema constraint.

---

## 10. Semantic Gaps

Points where the business meaning could not be determined from repository evidence, stated per the brief's required phrasing.

1. **Repository evidence is insufficient to determine this business semantic:** the intended shape, owner, or lifecycle of `student_academics_profiles`, `student_interests_profiles`, `student_learning_styles`, `student_exposure_profiles`, and `student_financial_profiles` (Section 2.4, Section 0 Finding #4). These are queried by a live, mounted route but have no migration, no repository file, and no comment beyond their call site.
2. **Repository evidence is insufficient to determine this business semantic:** how or where `edu_stream_scores`'s four score fields actually get computed and written — only an all-null initializer function was found (Section 2.13).
3. **Repository evidence is insufficient to determine this business semantic:** whether `student_academic_profiles` (2.6) has an application-enforced or DB-enforced "one per student" constraint, versus relying entirely on RPC-level idempotency without a backing UNIQUE constraint — the migration text captured in this pass did not include the original CREATE TABLE (only the additive evolution), so the base constraint set for this table was not independently confirmed.
4. **Repository evidence is insufficient to determine this business semantic:** whether `edu_academic_records`'s `class_level` and `student_academic_records`'s `academic_year` are meant to represent the same real-world concept under different names, or genuinely different groupings (e.g., school class vs. onboarding-defined year band) — no shared lookup or mapping table was found reconciling the two.
5. **Repository evidence is insufficient to determine this business semantic:** whether any process currently reconciles or is intended to eventually reconcile the three parallel "who is this student, academically" families (student-onboarding, education-intelligence, taxonomy-RPC) into one merged view, beyond the partial, explicitly-incomplete composition already performed by `StudentService` (Section 7.1).
6. **Repository evidence is insufficient to determine this business semantic:** who/what is expected to eventually consume the taxonomy-RPC family (Section 2.6–2.8) given no frontend page currently calls it and no backend module owns it — whether it is pre-built for a near-term launch, an abandoned initiative, or reachable through a path this investigation did not find.

---

## 11. Ambiguities Requiring Architectural Decisions

Flagged for WP-ARCH-01B; no resolution attempted here, per this WP's constraints.

1. Which of `student_education_profiles`, `student_academic_profiles`, and (if it is real) `student_academics_profiles` is meant to be the durable "who is this student, educationally" record going forward, given all three are live or reachable and none currently defers to another.
2. Whether `student_academic_subjects` (performance) and `student_subject_selections` (enrollment/selection) are meant to remain two separate concepts long-term, or are two partial views of what should eventually be one "subject" concept per student.
3. Whether the "replace-all" lifecycle model (`edu_academic_records`, `edu_extracurricular`, `student_subject_selections`, `student_language_preferences`) or the "per-key upsert with historical rows" model (`student_academic_records`, `student_academic_subjects`) is the intended long-term pattern for academic data — the two are not merely different implementations of the same rule, they encode different answers to "does history matter here."
4. Whether the six-table read in `student-onboarding/services/recommendation-engine.js` (Section 7.3) reflects a real, intended data model that simply never got migrated, or should be treated as dead/broken code — this affects whether five additional "concepts" (interests, learning style, exposure, financial profile) belong in the canonical domain at all.
5. Whether `knowledge-runtime`'s explicitly-partial composition (Section 7.1) is expected to eventually pull from the taxonomy-RPC family, the `student_academic_*` family, the `edu_*` family, or some reconciliation of the three, for the fields it currently marks unavailable (stream, subjects, structured skills, qualifications).
6. Ownership model for the taxonomy-RPC family (Section 8): every other entity in this catalogue has a clear backend-module owner; this family's only "owner" is a set of database-side RPC functions called directly from the frontend, with no backend module directory at all. Whether that is the intended long-term ownership shape, or an artifact of an in-progress migration toward backend ownership, cannot be determined from repository evidence.

---

## 12. Evidence Coverage & Limitations

- **Fully traced with direct file inspection this pass:** all repository/service/validator/helper files for `student-onboarding`'s academics, education, and recommendation-engine paths; the `student_education_profiles` and `student_academic_records`/`subjects` migrations in full; the structural section map (not full line-by-line) of the 2,280-line Phase-2B RPC evolution migration, including all `ALTER TABLE`, `CREATE OR REPLACE FUNCTION`, and `COMMENT ON` statements; the `education-intelligence` `student.model.js` and `student.repository.js` in full; the `knowledge-runtime` `studentIntelligence.service.js` header and constructor in full, and `recommendation.service.js`'s dependency wiring; the frontend `academicOnboardingApi.ts` and confirmation that its consuming hooks are not wired into any routed page.
- **Traced structurally but not read line-by-line:** the RPC function *bodies* inside the Phase-2B evolution migration (`fn_create_student_academic_profile`, `fn_get_student_full_profile`, `fn_save_student_subjects`, `fn_save_student_languages`, `fn_complete_academic_onboarding` — Section 6 of that file, ~850 lines of SQL) — their existence, names, and documented parameters/purpose (from `COMMENT ON FUNCTION` and the frontend caller's own doc comments) are confirmed; their internal logic was not exhaustively reviewed statement-by-statement.
- **Not inspected in this pass:** live database state (out of scope, as in WP-ARCH-01A); the `education-intelligence` engines' internal scoring logic (ROI, career-success, digital-twin, stream-intelligence, cognitive-profile, activity-analyzer) beyond confirming their existence and entry-point pattern per WP-ARCH-01A; the `decision`, `explainability`, and `validation` runtimes under `knowledge-runtime` beyond confirming they are downstream of `StudentService`/`KnowledgeService`, not direct academic-table consumers; the `career-copilot`, `ai-career-advisor`, and `personalization` modules referenced only in passing by `studentIntelligence.service.js`'s own header comments (explicitly flagged there as unconfirmed/out-of-architecture, not independently verified here).
- Anywhere this report states "repository evidence is insufficient" or leaves a status as "unconfirmed," that is a deliberate refusal to infer, matching this WP's instruction to distinguish fact from assumption. This report deliberately preserves WP-ARCH-01A's original per-entity "Active" status table rather than restating it, per the instruction not to repeat prior findings; Section 0 lists every point where this pass's deeper reading materially revises rather than merely corroborates that table.
