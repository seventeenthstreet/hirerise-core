# WP-ARCH-01E — Enterprise Migration Strategy
## Canonical Student Academic Domain — Transition from Current State

**Predecessors (completed, approved, treated as authoritative — not redesigned in this document):**
- WP-ARCH-01A — Repository Evidence Report
- WP-ARCH-01A.2 — Business Semantic Investigation
- WP-ARCH-01B — Canonical Student Academic Domain Architecture
- WP-ARCH-01C — Enterprise Logical Data Model
- WP-ARCH-01D — Enterprise Runtime Integration Architecture

**Also treated as authoritative current-state evidence, not re-audited here:** the five WP-DB-01 migration-chain reports (Migration Audit, Dependency Analysis, Migration Ordering Review, Drift Analysis, Reconciliation Planning, Canonical Schema Comparison) and the WP-DB-01A implementation/verification pair. Where this document references a specific finding from that series (e.g. "F1", "position 59"), it is citing that series's own numbering, not re-deriving it.

**Scope of this document:** the enterprise transition path from the current repository state to the runtime and domain architecture defined by WP-ARCH-01B/C/D. This is a strategy document — sequencing, risk, governance, and verification gates. It contains no SQL, no schema, no code.

---

## PART 1 — Enterprise Transformation Vision

### 1.1 Migration philosophy

The Student Academic Domain did not arrive at its current state through one bad decision — WP-ARCH-01A/A.2 found three independently-evolving table families, each built to solve a real problem at the time it was built, none of them ever formally retired. The migration strategy therefore treats this as **consolidation of three legitimate lineages into one canonical domain**, not as "replacing something broken with something good." That framing matters operationally: it means the migration can and should preserve every fact any of the three families holds, rather than treating any of them as disposable.

### 1.2 Business goals

- Reach the canonical Student Academic Domain (WP-ARCH-01B/C) and the runtime architecture (WP-ARCH-01D) without a rewrite-and-cutover event.
- Never present a moment where a downstream consumer (Recommendation Engine, Decision Engine, or any runtime in WP-ARCH-01D's catalogue) sees two disagreeing answers to "what is this student's academic picture."
- Preserve every student's historical academic record through the transition, with full auditability of the transition itself.
- Close the ungoverned direct-table-read path (`recommendation-engine.js`, WP-ARCH-01A.2 §7.3) as an early, not a late, milestone — it is the single highest-severity finding in the entire evidence base and the transition plan treats it accordingly.

### 1.3 Risk tolerance

This is a **low-risk-tolerance migration**. The domain sits under a live, revenue-relevant onboarding flow and at least two confirmed-live runtimes (Student Context Runtime, Recommendation Engine, per WP-ARCH-01D §2.2–2.4). Every phase in Part 14 is designed to be independently reversible, and no phase retires a legacy component until its replacement has been running in coexistence, verified, for at least one full verification cycle (Part 11).

### 1.4 Guiding principles

1. **Additive before subtractive.** New canonical structures are introduced and populated before any legacy structure is touched for removal.
2. **One direction of truth at a time per entity.** During coexistence, exactly one family is authoritative for a given student's given fact at any moment — never two simultaneously (Part 3, No Dual Writes).
3. **Every stage must be independently verifiable**, not just "believed correct" (Part 11).
4. **No architectural decision is re-opened.** WP-ARCH-01B/C/D's decisions are inputs, not discussion topics, for this document.
5. **The migration itself is auditable.** Every cutover, every dual-write window, every retirement is a logged, timestamped, reversible event — the transition has the same auditability standard as the domain it produces (WP-ARCH-01C Part 9).

### 1.5 Transformation approach

A **strangler-fig pattern**, applied at the domain level: the canonical Student Academic Domain and its Academic Context Composition Context are stood up alongside the three existing families, gradually take over read traffic (via the Composition Context reading from — and eventually replacing — the legacy sources), then gradually take over write traffic (via Student Onboarding's commands being redirected to the canonical domain), with each existing family retired only once nothing reads or writes it anymore.

### 1.6 Why phased migration is preferred

A single cutover would require: reconciling three data models, migrating all runtime consumers, and validating nine downstream runtimes (seven of which are not yet built, per WP-ARCH-01D's own evidence-status labeling) — all in one event, with no partial-success state. Given the domain's own evidence base already contains one confirmed deterministic halt condition in the underlying migration chain (WP-DB-01 Ordering Review, "execution would halt at position 59 of 70") and a second, newly-surfaced blocking defect found only once the first was fixed (WP-DB-01A Verification Report, failure at position 2, unrelated to the first), a big-bang cutover in a codebase that has already twice failed to reconstruct cleanly from scratch is not a credible plan. Phasing lets each stage's verification gate (Part 11) catch exactly this class of surprise before it propagates.

---

## PART 2 — Current State Assessment

### 2.1 The four generations

Repository investigation (WP-ARCH-01A, WP-ARCH-01A.2, WP-ARCH-01B Part 1.1) establishes four generations of "what does this student's academic picture look like," three of them simultaneously live in production today:

| Generation | Name | Tables | Status | Evidence |
|---|---|---|---|---|
| **Generation 1** | Legacy Education Intelligence | `edu_students`, `edu_academic_records`, `edu_extracurricular`, `edu_cognitive_results`, `edu_stream_scores` (Family B) | **Active** — defined in `000_initial_schema.sql`, queried through `education-intelligence`'s sole sanctioned repository, mounted student route live; four of its five route files (careerSimulation, roiAnalysis, careerPrediction, analysis) are present but not mounted anywhere in `server.js` | WP-ARCH-01A §4–5, WP-ARCH-01B Part 1.1 |
| **Generation 2** | MVP Student Onboarding | `student_academic_records`, `student_academic_subjects`, `student_education_profiles` (Family A) | **Active** — Phase-2 migrations (May 2026), queried live by `academic.repository.js`; built for linear wizard step-completion with partial-save support, not lifetime history | WP-ARCH-01A §1.1–1.2, WP-ARCH-01B Part 1.1 |
| **Generation 3** | Current Production Academic Module | The entangled coexistence of Generations 1 and 2, partially reconciled by `StudentService` | **Active, and the actual state a new engineer encounters** — `StudentService` (Student Context Runtime, WP-ARCH-01D §2.2) already performs a partial, self-documented composition across both families, with an open code comment acknowledging `student_academic_subjects` "was located but not wired into this composition — needs confirmation of shape before reuse," while currently sourcing subjects/skills from the legacy `edu_students.skills` flat array instead | WP-ARCH-01A §6 Finding #2, WP-ARCH-01A.2 §7.1 |
| **Generation 4** | Incomplete Academic Context | `student_academic_profiles`, `student_subject_selections`, `student_language_preferences` (Family C) | **Not wired to any application code** — taxonomy-driven, multi-country/board/language-aware, the architecturally closest of the three to canonical (WP-ARCH-01B Part 1.1), but its base migration does not exist under its expected name (only `..._evolution.sql` exists — WP-ARCH-01A §7), so it was "never given a backend owner" and never became reachable from any live UI | WP-ARCH-01A §7, WP-ARCH-01B Part 1.1, ADR-01 |

**Why this matters for sequencing:** Generation 4 is the one family that is architecturally closest to the canonical `StudentAcademicProfile`/taxonomy design (WP-ARCH-01B ADR-01, ADR-05), but it is also the one with zero current consumers — meaning it can be consolidated into the canonical schema with the least coexistence risk, since nothing breaks if its interim state changes. Generations 1 and 2, by contrast, have live consumers today and must be migrated with full coexistence discipline (Part 4).

### 2.2 Existing bounded contexts (pre-migration)

None. WP-ARCH-01A.2 §10 Finding #5 explicitly found no evidence any process currently reconciles the three families beyond `StudentService`'s partial, incomplete composition. There is no bounded-context discipline today — only three independently-evolving table families and one runtime doing its best to paper over the gap.

### 2.3 Existing runtimes

Per WP-ARCH-01D's own evidence-status labeling: only **Student Context Runtime** (`StudentService`) and **Recommendation Engine** (`RecommendationService`) are confirmed live today. A second, architecturally non-compliant "recommendation engine" (`student-onboarding/services/recommendation-engine.js`) also exists, independently querying six raw tables and bypassing every composition layer (WP-ARCH-01A.2 §7.3) — this is not a runtime this migration preserves; it is a component this migration retires (Part 6).

### 2.4 Existing repositories

- `student-onboarding/repositories/academic.repository.js` — Generation 2's sole write path.
- `education-intelligence/repositories/student.repository.js` — Generation 1's sole write path, itself sitting under `educationIntelligence.service.js`, which already documents itself as the sole sanctioned entry point for Generation 1's scoring engines (WP-ARCH-01A §4).
- No repository exists for Generation 4 — its Phase-2b RPC-evolution migration is the only artifact referencing it (WP-ARCH-01A §7).
- Duplicate `controllers/`/`collectors/` file sets exist in `education-intelligence` with identical filenames in both directories, unresolved as to whether they are duplicates or divergent (WP-ARCH-01A §5) — this is a migration blocker until resolved (Part 2.6).

### 2.5 Legacy components

- The four unmounted Generation 1 route files (careerSimulation, roiAnalysis, careerPrediction, analysis) — status (staged, dead, or reachable via an unfound path) is undetermined by static evidence (WP-ARCH-01A §5, §8).
- The second, non-compliant `recommendation-engine.js` (Part 2.3).
- `migrations_original_backup/` — confirmed to predate the WP-DB-01A filename standardization (WP-ARCH-01A §7).
- The `archive/` folder (8 superseded M3-family migration files), explicitly out of the applied chain (WP-DB-01 Reconciliation Planning §5).

### 2.6 Technical debt

Inherited directly from the WP-DB-01 series, and treated here as fixed inputs to this migration's own Schema stream (Part 5):

- **The migration chain does not currently reconstruct cleanly from a clean `supabase db reset`.** Two independent, sequential blockers have been found so far: the original ordering-driven halt at position 59 of 70 (WP-DB-01 Ordering Review), resolved by WP-DB-01A's filename-normalization batch; and a second, previously-undetected defect surfaced only once the first was fixed — a schema mismatch between `000_initial_schema.sql`'s `skill_embeddings.embedding` column and `001_semantic_ai_upgrade.sql`'s reference to a nonexistent `embedding_vector` column, which halts execution at position 2 of 70, in the Legacy Foundation era, unrelated to anything either WP-ARCH or WP-DB-01A touched (WP-DB-01A Verification Report). **This document treats the migration chain as not yet provably reconstructable end-to-end, and Phase 0 (Part 14) does not close until it is.**
- **Two live, incompatible-schema duplicate table definitions** (`signal_category_hierarchy`, `signal_ontology_edges`) whose winner depends on execution order and has already flipped once as a side effect of the WP-DB-01A ordering fix (Finding F3, WP-DB-01A Implementation Report) — unresolved, logged as "Requires Human Decision."
- **No canonical schema artifact exists anywhere in the repository** (WP-DB-01 Canonical Schema Comparison Report) — the entire WP-DB-01 series' notion of "canonical" is a reconstruction from execution order, not a verified external source of truth. This is a standing gap this migration's Schema stream must close (Phase 0) before any later phase can claim genuine parity, not just internal consistency.
- **Only 13 of 71 migrations have rollback coverage (~17%)**, concentrated away from the largest, most complex files (WP-DB-01 Migration Audit §13).
- **Duplicate `controllers/`/`collectors/` directories** in `education-intelligence` (Part 2.4).
- **A second, architecturally non-compliant recommendation engine** bypassing all composition layers (Part 2.3).

### 2.7 Migration blockers

1. The migration chain's own reconstructability is unresolved (2.6) — this blocks any phase that assumes a clean, deterministic starting schema state, which is every phase in Part 14 from Phase 1 onward.
2. The `signal_category_hierarchy`/`signal_ontology_edges` duplicate-definition decision is unresolved and requires a human decision, not an automated one (WP-DB-01 Reconciliation Planning, Phase 2) — this blocks any downstream work that depends on either table's shape, though it does not block this domain's own migration streams directly, since neither table belongs to the Student Academic Domain.
3. No canonical schema artifact exists to verify against (2.6) — this blocks Part 11's Architecture Validation gate from being a genuine external comparison rather than an internal-consistency check, until acquired.
4. The `controllers/`/`collectors/` duplication in `education-intelligence` must be resolved (diffed, and either confirmed as intentional re-export or flagged as drift) before Generation 1's repository layer can be safely retired (Part 6), since retiring the wrong one of an unconfirmed duplicate pair risks silently deleting live logic.

### 2.8 Architectural gaps

- No bounded-context ownership exists today (2.2).
- No projection layer exists between the three families and any consumer beyond `StudentService`'s partial composition (2.3).
- No event model exists — none of WP-ARCH-01C Part 11's events (`AcademicProfileEstablished`, `AcademicRecordCommitted`, etc.) are emitted by any current component; today's writes are direct repository calls with no publication step.
- No versioning exists on any current entity — none of the three families carry a context version, taxonomy version, or engine version stamp of the kind WP-ARCH-01C Parts 8–9 require.

---

## PART 3 — Migration Principles

1. **Single Source of Truth (transition-scoped).** At every point in the migration, for every individual student and every individual fact (e.g. "current qualification," "Class 10 board exam marks"), exactly one system is authoritative. During coexistence (Part 4), authority for a given fact type moves from a legacy family to the canonical domain in one atomic step per fact type, never gradually per-student without a tracked cutover boundary.
2. **Canonical ownership.** Once the canonical Student Academic Domain exists, it and only it may create or mutate any entity in WP-ARCH-01C Part 3 — this is WP-ARCH-01C Part 14 rule 1, and this migration introduces no interim exception to it once a given entity type has cut over.
3. **No dual writes.** No period exists where both a legacy family and the canonical domain accept independent writes for the same fact. Where coexistence requires both to hold a value simultaneously (Part 4.3), exactly one accepts the write and the other is a read-only, event-driven replica of it — never two independent write paths that could disagree.
4. **Backward compatibility.** Every canonical entity must be able to represent every fact any of the three legacy families currently hold, so that no historical record is lost or silently narrowed during consolidation (Part 7).
5. **Forward compatibility.** Every interim (transition-only) component is built so its removal, once retirement criteria are met, requires no change to any permanent component's contract — transition scaffolding is additive, not load-bearing, for the target state.
6. **Incremental replacement.** Every migration stream (Part 5) proceeds fact-type by fact-type or component by component, never as a single indivisible domain-wide cutover.
7. **Data integrity.** Every record migrated from a legacy family to the canonical domain must be independently verifiable against its source (Part 11), and any record that cannot be confidently mapped is flagged for manual reconciliation, never silently dropped or guessed.
8. **Audit preservation.** The migration itself produces an audit trail (Part 1.4) with the same rigor WP-ARCH-01C Part 9 requires of the domain it produces — every cutover event, every dual-write-window boundary, and every retirement is a timestamped, reviewable record.
9. **Version preservation.** Every migrated historical entity carries a reference to the Taxonomy Version and originating-family context it was migrated from, so later taxonomy evolution cannot retroactively misinterpret pre-migration data (directly extending WP-ARCH-01C Part 14 rule 7 into the migration itself).
10. **Event continuity.** Once the canonical domain's event model (WP-ARCH-01C Part 11) is live for a given entity type, every subsequent change publishes the canonical event — including changes made through any temporarily-retained legacy write path — so that no downstream projection (WP-ARCH-01D Part 4) ever silently misses a fact because it arrived through a coexistence-era path instead of the canonical one.

---

## PART 4 — Target Transition Architecture

### 4.1 Current architecture

Three independently-writable table families (Generations 1, 2, 4), one partial ad hoc composition (`StudentService`, Generation 3's reconciliation attempt), one non-compliant direct-read shortcut, zero projections, zero events, zero versioning.

### 4.2 Transition architecture

```
Generation 1 (edu_*)  ─┐
Generation 2 (student_academic_*) ─┼─► Migration Composition Layer ─► Canonical Student Academic Domain
Generation 4 (student_academic_profiles etc.) ─┘        (temporary,          (WP-ARCH-01B/C aggregates,
                                                          read-side only)      event-sourced, versioned)
                                                                                      │
Student Onboarding ──────────────► Command Router (temporary) ──────────────────────►┘
   (writes continue to target                (routes each command to whichever
    whichever family is still                  system is currently authoritative
    authoritative for that fact                 for that specific fact type,
    type, per Part 4.3's schedule)               per the cutover schedule)
```

- **Purpose:** allow the canonical domain to exist, be populated, and be read by early adopter runtimes (Student Context Runtime first, per Part 8) while legacy writes continue uninterrupted, until each fact type's cutover boundary is reached.
- **Temporary components:** the Migration Composition Layer (a read-side reconciliation service, distinct from and eventually replaced by the permanent Academic Context Composition Context); the Command Router (routes Student Onboarding's commands to the currently-authoritative system per fact type).
- **Permanent components:** the canonical Student Academic Domain's aggregates and bounded contexts (WP-ARCH-01B Parts 2–3); the Academic Context Composition Context, which the Migration Composition Layer is eventually replaced by, not merged into.
- **Retired components (by the end of this stage):** the non-compliant direct-read `recommendation-engine.js` (retired early, Part 6, since its retirement does not depend on any fact-type cutover completing).
- **Coexistence rules:** for any given fact type, reads may be served from either the legacy family or the canonical domain during its transition window, but writes are single-sourced per Principle 3; the Command Router is the single place this routing decision is made, so no consumer ever has to know which system currently owns a given write.

### 4.3 Final architecture

Exactly the architecture defined by WP-ARCH-01B (domain), WP-ARCH-01C (logical model), and WP-ARCH-01D (runtime integration) — no transition-era component remains. The Migration Composition Layer and Command Router are fully retired once every fact type has cut over and every legacy family has been archived (Part 6).

- **Purpose:** the canonical, permanent target state.
- **Temporary components:** none.
- **Permanent components:** all of WP-ARCH-01B/C/D.
- **Retired components:** Generations 1, 2, and 4 (archived per Part 6, not deleted outright, per Principle 8's audit-preservation requirement), the Migration Composition Layer, and the Command Router.
- **Coexistence rules:** none — coexistence is a transition-stage-only concept.

---

## PART 5 — Migration Streams

Each stream is independently sequenced (Part 14) but explicitly scoped here so work can be planned in parallel where dependencies allow.

### 5.1 Schema

- **Objectives:** achieve a migration chain that deterministically reconstructs the canonical database from a clean `supabase db reset`; acquire a genuine canonical schema artifact (WP-DB-01's standing gap).
- **Dependencies:** none — this stream has the longest lead time and should start immediately (mirroring WP-DB-01 Reconciliation Planning's own Phase 0 sequencing).
- **Inputs:** the WP-DB-01 series' full finding set (F1–F12), the newly-surfaced `skill_embeddings`/`embedding_vector` defect (WP-DB-01A Verification Report).
- **Outputs:** a verified, clean, deterministic `supabase db reset`; a checked-in canonical schema artifact.
- **Completion criteria:** a disposable-project `db reset` completes end-to-end with no guard-clause halt and no object-definition failure, and its resulting schema has been diffed against the newly-acquired canonical artifact.

### 5.2 Reference Data (Taxonomy)

- **Objectives:** stand up the Academic Taxonomy Context (WP-ARCH-01B Part 2.1) as a versioned, shared-kernel reference set, seeded from the union of all taxonomy-like data found across all three legacy families (Family A's enums, Family C's RPC-driven codes).
- **Dependencies:** Schema stream complete (needs a stable place to land).
- **Inputs:** Family A's `academic_year_enum`/`ACADEMIC_SUBJECTS` list; Family C's country/board/region codes and its already-organic `taxonomy_hash_at_save` pattern (WP-ARCH-01B Part 1.3 item 5).
- **Outputs:** a published, versioned taxonomy (R-01…R-16, WP-ARCH-01C Part 7) with a Taxonomy Version 1 baseline.
- **Completion criteria:** every code value present in any of the three legacy families has a corresponding canonical taxonomy entry; no legacy enum value is dropped (WP-ARCH-01C Part 14 rule 8's deprecation-not-deletion discipline applies from the very first taxonomy publish).

### 5.3 Academic Records (Operational Data)

- **Objectives:** migrate Generation 1, 2, and 4's operational data into the canonical `StudentAcademicProfile`/`AcademicQualification`/`AcademicRecord`/etc. aggregates (WP-ARCH-01B Part 3).
- **Dependencies:** Reference Data stream complete (every migrated record needs a taxonomy reference to resolve against).
- **Inputs:** all confirmed-active tables from Generations 1, 2, and 4 (WP-ARCH-01A §1.1–1.2).
- **Outputs:** populated canonical aggregates, one `StudentAcademicProfile` per student, reconciled across all three source families per Part 7.
- **Completion criteria:** every student record in every source family has either a corresponding canonical record or an explicit, logged reconciliation exception (Principle 7).

### 5.4 Taxonomy Governance Handoff

- **Objectives:** transfer taxonomy stewardship (WP-ARCH-01C Part 14 rule 9) from ad hoc, per-family conventions to the formal Academic Taxonomy Context governance process.
- **Dependencies:** Reference Data stream complete.
- **Completion criteria:** no code path anywhere in the repository still writes a taxonomy-like value directly to a legacy table; all taxonomy changes flow through the canonical publish process.

### 5.5 Repositories

- **Objectives:** retire the three legacy repositories (`academic.repository.js`, `education-intelligence/repositories/student.repository.js`, and Generation 4's absent-but-implied one) in favor of the canonical domain's single-writer command surfaces (WP-ARCH-01C Part 14 rule 2).
- **Dependencies:** Academic Records stream complete for the relevant fact types.
- **Completion criteria:** no application code imports a legacy repository; all writes flow through canonical command handlers.

### 5.6 Services

- **Objectives:** migrate `educationIntelligence.service.js`'s orchestration role and `StudentService`'s partial composition role into, respectively, retirement (its responsibilities are absorbed per WP-ARCH-01B Part 8) and the permanent Student Context Runtime contract (WP-ARCH-01D §2.2).
- **Dependencies:** Repositories stream complete.
- **Completion criteria:** `StudentService` consumes only the canonical Academic Context projection, with its self-documented "not wired into composition" gap (WP-ARCH-01A.2 §7.1) fully closed, not worked around.

### 5.7 RPC Layer

- **Objectives:** evaluate Generation 4's Phase-2b RPC layer (`phase2b_student_academic_rpcs_evolution.sql`) for reusable logic (its taxonomy-aware design is architecturally closest to canonical, Part 2.1), then retire or fold its logic into the canonical command surface.
- **Dependencies:** Academic Records stream complete for Generation 4's fact types.
- **Completion criteria:** no RPC in this layer is independently callable by any consumer outside the canonical command surface.

### 5.8 Runtime Integration

- **Objectives:** cut Student Context Runtime and Recommendation Engine over to consuming the canonical Academic Context projection instead of any legacy source (Part 8.1–8.2).
- **Dependencies:** Services stream complete.
- **Completion criteria:** per WP-ARCH-01D's own contract (Part 8 there), Student Context Runtime's output is traceable only to canonical Academic Context versions, with zero remaining reads against any Generation 1/2/4 table.

### 5.9 Recommendation Integration

- **Objectives:** confirm Recommendation Engine's exclusive dependency on Student Context Runtime survives the cutover unchanged, and formally retire the non-compliant second `recommendation-engine.js` (Part 6).
- **Dependencies:** Runtime Integration stream complete for Student Context Runtime.
- **Completion criteria:** exactly one component named "recommendation engine" exists in the repository, and it has no independent repository access to any academic table (WP-ARCH-01B ADR-06, WP-ARCH-01D §2.4).

### 5.10 Decision Integration

- **Objectives:** stand up Decision Engine per WP-ARCH-01D §2.5's prospective contract, since no confirmed prior implementation exists.
- **Dependencies:** Recommendation Integration stream complete.
- **Completion criteria:** Decision Engine consumes only Knowledge Runtime and Recommendation projections, per its declared contract — this is new construction, not a migration, and is scoped accordingly (lower coexistence risk, since there is no legacy Decision Engine to coexist with).

### 5.11 Frontend

- **Objectives:** migrate the frontend onboarding module's `student_education_profiles` API-contract consumption (WP-ARCH-01A §1.2, noted as a DTO/contract name rather than a confirmed table) to the canonical domain's command/query surface.
- **Dependencies:** Repositories and Runtime Integration streams complete.
- **Completion criteria:** no frontend module references a legacy table or API-contract name; all onboarding UI consumes canonical commands and the Academic Context projection.

### 5.12 Testing

- **Objectives:** build a verification suite (Part 11) that runs at every phase gate, not just at the end.
- **Dependencies:** runs continuously alongside every other stream, starting at Phase 0.
- **Completion criteria:** every phase in Part 14 has passed its assigned verification gates before the next phase begins.

### 5.13 Observability

- **Objectives:** stand up the health/lineage model WP-ARCH-01D Part 9 requires, extended during migration to also report per-fact-type cutover status (which system is currently authoritative for which fact, per student).
- **Dependencies:** Schema stream complete (needs a stable place to log to).
- **Completion criteria:** an operator can query "for student X, which system is currently authoritative for which academic fact" at any point during the migration, not just before/after.

### 5.14 Documentation

- **Objectives:** maintain a running, versioned record of every cutover decision, every dual-write-window boundary, and every retirement (Principle 8).
- **Dependencies:** runs continuously.
- **Completion criteria:** the documentation trail is itself sufficient to reconstruct why and when each fact type moved authority, without needing to inspect git history.

---

## PART 6 — Component Migration Matrix

| Component | Current owner | Future owner | Approach | Justification |
|---|---|---|---|---|
| `edu_students`, `edu_academic_records`, `edu_extracurricular`, `edu_cognitive_results`, `edu_stream_scores` (Gen 1) | `education-intelligence` module | Student Academic Domain (`StudentAcademicProfile`, `AcademicRecord`, `CognitiveAssessmentResult`, `ActivityRecord`) | **Migrate + Retire** | Confirmed live, confirmed queried; every fact these tables hold has a canonical home (WP-ARCH-01C Part 3), so nothing is lost by consolidating |
| `student_academic_records`, `student_academic_subjects`, `student_education_profiles` (Gen 2) | `student-onboarding` module | Student Academic Domain (`AcademicRecord`, `SubjectPerformance`, `StudentAcademicProfile`) | **Migrate + Retire** | Same reasoning; this is also the family Student Onboarding currently writes to, so it is the first write-path cutover target (Part 8) |
| `student_academic_profiles`, `student_subject_selections`, `student_language_preferences` (Gen 4) | Nobody (no backend owner, WP-ARCH-01A §7) | Student Academic Domain (`StudentAcademicProfile`, `AcademicQualification`, `LanguagePreference`) | **Reuse design, migrate data if any live rows exist, then retire schema** | Architecturally closest to canonical (Part 2.1); its design informs the canonical schema more than it needs to be replaced by it — but the tables themselves still retire once canonical is live, since WP-ARCH-01B Part 8 gives it no ongoing role |
| `education-intelligence/repositories/student.repository.js` | `education-intelligence` | N/A | **Retire** | Superseded by canonical command surface (Part 5.5) |
| `student-onboarding/repositories/academic.repository.js` | `student-onboarding` | N/A | **Retire** | Same |
| `educationIntelligence.service.js` | `education-intelligence` | N/A (responsibilities absorbed) | **Retire** | WP-ARCH-01B Part 8 already rules this module does not persist as a standalone bounded context in the target architecture |
| ROI / career-success / digital-twin / academic-trend / stream-intelligence / cognitive-profile / activity-analyzer engines | `education-intelligence` | Derived Academic Intelligence Context | **Refactor** | These are genuine derived-signal computations (WP-ARCH-01B ADR-08); their scoring logic is likely reusable, but their input access must be refactored to read from canonical entities, not `edu_*` directly |
| 4 unmounted Generation 1 route files (careerSimulation, roiAnalysis, careerPrediction, analysis) | `education-intelligence` | Undetermined | **Investigate before deciding** | Status (staged/dead/reachable via unfound path) is not resolvable from static evidence (WP-ARCH-01A §8); this migration does not guess — it schedules an investigation task ahead of any retire/refactor decision |
| `student-onboarding/services/recommendation-engine.js` (non-compliant) | `student-onboarding` | N/A | **Retire immediately** | Already architecturally condemned by WP-ARCH-01B ADR-06; its retirement has no dependency on any fact-type cutover completing, so it is scheduled early (Phase 1, not deferred to Phase 12) |
| `StudentService` (`studentIntelligence.service.js`) | `knowledge-runtime` | Student Context Runtime (WP-ARCH-01D §2.2) | **Refactor (in place)** | Confirmed live, correctly positioned architecturally already — it needs its input source redirected to canonical Academic Context, not a wholesale replacement |
| `RecommendationService` | `knowledge-runtime` | Recommendation Engine (WP-ARCH-01D §2.4) | **Reuse, unchanged** | Already compliant — depends exclusively on `StudentService`/`knowledgeService`; once its sole input is redirected upstream, no change to this component itself is required |
| Decision Engine, Career Intelligence, Career Outcome Intelligence Engine, FYUGP Intelligence, AI Context Generation | None (not confirmed built) | Per WP-ARCH-01D §2.5–2.9 | **New construction** | Not a migration in the strangler-fig sense — there is no legacy component to strangle; these are built directly to their WP-ARCH-01D contracts |
| `controllers/` vs `collectors/` duplicate files (`education-intelligence`) | `education-intelligence` | Undetermined | **Diff before deciding** | Same reasoning as the unmounted routes — resolve the ambiguity (Part 2.7 item 4) before scheduling either half for retire or reuse |
| `migrations_original_backup/`, `archive/` (M3-family) | N/A (dead) | N/A | **Archive (already archived)** | No action needed; confirmed out of the applied chain (WP-DB-01 Reconciliation Planning §5) |

---

## PART 7 — Data Transition Strategy

### 7.1 Canonical adoption

The canonical domain is populated by reading, not by a single big-bang import: the Migration Composition Layer (Part 4.2) reconciles all three families' current state into canonical shape continuously, so that by the time write authority for a given fact type cuts over (Part 8), the canonical domain already holds a fully-reconciled, verified copy of every fact of that type.

### 7.2 Reference data migration

Taxonomy migration (Part 5.2) happens first and once — every code value across all three families is mapped to a canonical taxonomy entry before any operational-data migration begins, since every operational record needs a taxonomy reference to resolve against (WP-ARCH-01C Part 7).

### 7.3 Operational data migration

Per Principle 7, every operational record is migrated with independent verification against its source. Three-way reconciliation is required specifically for the subset of students who have records in more than one family simultaneously (a near-certainty given WP-ARCH-01A.2 §0's finding that all three families are live) — this is the highest-effort part of this stream and is scoped as its own explicit sub-task, not assumed to be a simple union.

### 7.4 Historical preservation

Per WP-ARCH-01B ADR-04, canonical `AcademicRecord`/`SubjectPerformance` are append-only. Migrated historical records are inserted as already-committed history, not replayed through the canonical domain's normal draft→commit lifecycle — each carries a migration-provenance marker (Principle 9) distinguishing "migrated from Generation N" from "originated in the canonical domain," so that the transition itself remains auditable without being confused with ordinary domain activity.

### 7.5 Derived data regeneration

None of Generation 1's derived engines' output (ROI scores, stream scores, cognitive profiles) is migrated as-is — per WP-ARCH-01B ADR-08, derived signals are recomputed against canonical entities once the Derived Academic Intelligence Context is live, not carried over, since carrying over unversioned legacy scores would violate the canonical domain's engine-versioning requirement from day one.

### 7.6 Projection rebuild

Once canonical entities exist for a given fact type, the Academic Context (E-10) projection is built for the first time for that fact type — this is a genuine "rebuild," in WP-ARCH-01C Part 8's sense, even though it is the first build, because the underlying entities already carry full event history from the migration itself (7.4).

### 7.7 Context rebuild

Student Context Runtime's context rebuild (WP-ARCH-01D Part 4) is triggered the first time by the migration's own cutover event for each fact type, then proceeds identically to steady-state operation thereafter — there is no special "migration mode" for this runtime once its input source has been redirected.

### 7.8 Recommendation / Decision / AI Context regeneration

Because Recommendation Engine, Decision Engine, and AI Context Generation are all request-scoped or on-demand (WP-ARCH-01D §2.4–2.5, §2.9), there is no standing output to "regenerate" for these layers — the very next request made after a cutover automatically computes against canonical data, with no separate regeneration step required. This is one of the concrete benefits of WP-ARCH-01D ADR-R02's request-scoped design choice: it removes an entire category of migration complexity that would exist if these runtimes maintained standing per-student state.

---

## PART 8 — Runtime Transition Strategy

### 8.1 Student Context Runtime

Confirmed live (WP-ARCH-01D §2.2). Migration approach: redirect `StudentService`'s input from its current partial, ad hoc composition of Generations 1/2 to the canonical Academic Context projection, one fact type at a time, closing its own documented "not wired" gap (WP-ARCH-01A.2 §7.1) as part of this cutover rather than leaving it open. Production impact is minimized because this runtime already sits at exactly the composition point the canonical domain is designed to feed — the change is to its input source, not its position in the architecture.

### 8.2 Knowledge Runtime

Layering only confirmed by evidence at the dependency-edge level (WP-ARCH-01D §2.3); internal composition logic not independently traced. Migration approach: verify its actual current inputs before touching anything (an investigation task, mirroring Part 6's approach to the unmounted routes), then redirect to consume Student Context Runtime's output once 8.1 is complete, per its already-declared WP-ARCH-01D contract.

### 8.3 Recommendation Engine

Confirmed live, confirmed compliant (WP-ARCH-01D §2.4). Migration approach: no change to this component beyond its transitive benefit from 8.1/8.2's redirection — its own dependency (`studentService`/`knowledgeService`) does not need to change, only what those dependencies now return.

### 8.4 Decision Engine

Not confirmed built (WP-ARCH-01D §2.5). Migration approach: new construction against its declared contract, sequenced after Recommendation Engine's cutover is verified, so it is built directly against canonical-sourced Recommendation output rather than against a moving target.

### 8.5 Career Intelligence

Not confirmed built (WP-ARCH-01D §2.6). Migration approach: new construction, sequenced after Decision Engine, with its one direct-access exception (Derived Academic Signal) available only once the Derived Academic Intelligence Context (7.5) is live.

### 8.6 Career Outcome Intelligence Engine

Not confirmed built (WP-ARCH-01D §2.7). Migration approach: new construction, sequenced last among the intelligence runtimes, since its longitudinal-analysis purpose specifically needs a meaningful amount of canonical-era history to exist before its output is meaningful — building it too early would not be unsafe, but would produce output with no real signal in it yet.

### 8.7 FYUGP Intelligence

Not confirmed built, contract entirely prospective (WP-ARCH-01D §2.8). Migration approach: new construction, dependent only on Academic Context being live (8.1's underlying dependency), so it can in principle be built in parallel with Knowledge Runtime/Recommendation/Decision work, since it is a parallel branch, not part of the main chain (WP-ARCH-01D Part 3.1).

### 8.8 AI Context Generation

Not confirmed built (WP-ARCH-01D §2.9). Migration approach: new construction, last in sequence, since it is the most provenance-dense consumer (WP-ARCH-01D Part 7) and depends on Knowledge Runtime, Career Intelligence, and Derived Academic Signal all being live and stable first.

**Production-safety rule applied uniformly across 8.1–8.8:** no runtime is cut over to a canonical input until the Migration Composition Layer (or, once retired, the canonical projection itself) has been serving reads in shadow mode — computed but not yet acted upon — for at least one full verification cycle (Part 11), so that any discrepancy between legacy and canonical output is caught before it can affect a real student-facing decision.

---

## PART 9 — Compatibility Strategy

- **Backward compatibility:** every canonical event and projection remains a superset-compatible extension of whatever shape preceded it, per WP-ARCH-01C Part 14 rule 5 and WP-ARCH-01D Part 10 rule 12 — carried into the migration itself, meaning a consumer reading canonical output mid-migration is never broken by a later migration phase's additions.
- **Forward compatibility:** interim components (Migration Composition Layer, Command Router) are built so that a permanent component's later arrival requires no change to their already-published contract — they are designed to be quietly replaced, not refactored in place.
- **API compatibility:** the frontend's `student_education_profiles` API-contract name (WP-ARCH-01A §1.2) is preserved as a stable external contract for as long as the frontend depends on it, even after its backend implementation has fully moved to canonical entities — the contract name and the backend model are decoupled deliberately during transition.
- **Projection compatibility:** Academic Context's shape is fixed by WP-ARCH-01C Part 3 (E-10) from the moment it is first built; no interim, migration-only projection shape is introduced that downstream runtimes would need to unlearn later.
- **Event compatibility:** canonical events (WP-ARCH-01C Part 11) are published starting from the very first canonical write, including writes that originate from migrated historical data (Part 7.4) — there is no "pre-event era" data silently exempted from the event model once migration for that fact type begins.
- **Taxonomy compatibility:** every migrated historical record retains the Taxonomy Version it is reconciled against at migration time (Principle 9), so a later taxonomy evolution cannot retroactively reinterpret pre-migration data — identical to WP-ARCH-01C Part 14 rule 7's steady-state rule, applied to migration-origin data as well.
- **Runtime compatibility:** every runtime cutover (Part 8) is additive from its consumers' point of view — a runtime's declared output shape (WP-ARCH-01D Part 4/6) does not change because its input source changed from legacy to canonical.
- **Repository compatibility:** legacy repositories are retired only after their consumers have been migrated (Part 6) — no repository is removed while anything still imports it.

---

## PART 10 — Deployment Strategy

- **Development:** each migration stream (Part 5) is developed against a disposable environment seeded from a verified-clean `supabase db reset` (Schema stream, Part 5.1) — no development work proceeds against an environment whose base state is not itself provably reconstructable, given the Schema stream's own finding that this is not yet true today.
- **Testing:** the verification suite (Part 5.12, Part 11) runs continuously against every stream's output as it's produced, not only at stream completion.
- **Integration:** cross-stream integration points (e.g. Academic Records depending on Reference Data) are verified at the boundary before either stream is considered complete for downstream planning purposes.
- **Staging:** a full coexistence environment — all three legacy families plus the canonical domain plus the Migration Composition Layer — is stood up in staging before any production cutover, and the entire Part 14 phase sequence is rehearsed there first.
- **Pilot:** the first fact-type cutover (Generation 2's operational academic records, since it is the family Student Onboarding currently writes to) is piloted against a small, explicitly-consented cohort in production before being extended platform-wide.
- **Production rollout:** fact-type by fact-type, per Part 14's phase sequence, each gated by Part 11's verification criteria.
- **Progressive rollout:** within each fact-type cutover, reads move to canonical first (in shadow, then live), then writes move last — never the reverse, since a write-first cutover would create exactly the dual-write risk Principle 3 forbids.
- **Rollback:** every cutover has a defined rollback trigger (Part 12) and a defined rollback action — because the legacy family is never deleted until full retirement (Part 6), rolling back a cutover is a routing change (Command Router, Part 4.2), not a data-recovery operation, for as long as both sides still exist.
- **Disaster recovery:** the migration's own audit trail (Part 5.14) is itself part of the disaster-recovery surface — a failure mid-migration can be diagnosed from the cutover log alone, without needing to reconstruct intent from application logs.

---

## PART 11 — Enterprise Verification Strategy

| Gate | Verifies | Method |
|---|---|---|
| **Architecture validation** | The canonical schema matches WP-ARCH-01B/C's approved design, and (once acquired) a real external canonical artifact | Structural review against WP-ARCH-01B/C; diff against the Part 5.1 canonical artifact once available |
| **Data validation** | Every migrated record is traceable to a source record in one of the three legacy families, with no silent drop | Row-count and sampled field-level reconciliation per fact type, per Principle 7 |
| **Repository validation** | No application code imports a retired legacy repository | Repository-wide reference search, mirroring the technique WP-DB-01A's own implementation report used to catch stray references to renamed files |
| **Runtime validation** | Each runtime's cutover (Part 8) produces output equivalent to its pre-cutover output for the same input, within any intentional, documented change | Shadow-mode parallel-run comparison before any runtime is fully cut over |
| **Projection validation** | Academic Context and every downstream projection (WP-ARCH-01D Part 4) rebuilds correctly from canonical event history alone | Replay test: rebuild from scratch and compare to the currently-stored version, per WP-ARCH-01C Part 8's own replay guarantee |
| **Recommendation validation** | Recommendation Engine's output is unchanged in kind (though its inputs have changed source) once cut over | Shadow-mode comparison against pre-cutover output for a sampled set of real requests |
| **Decision validation** | Decision Engine's newly-built logic conforms to its WP-ARCH-01D contract | Contract-conformance test against declared inputs/outputs (Part 8.4) |
| **AI Context validation** | The assembled bundle carries complete, correct provenance for every input (WP-ARCH-01D Part 7) | Provenance-completeness check: every bundle field traceable to a specific upstream version |
| **Performance validation** | The canonical domain and its projections perform acceptably under production load | Load test in staging (Part 10) before each production cutover |
| **Security validation** | Canonical entities carry equivalent or stronger access control than the legacy tables they replace | Access-control review per fact type, before that fact type's write-cutover |
| **Explainability validation** | Every derived signal and AI-facing claim can be traced back to a specific computation run and source version (WP-ARCH-01B ADR-08, WP-ARCH-01D Part 7) | Spot-check: pick a random AI Context bundle field, walk it back to its source |
| **Business validation** | The migrated domain still supports every business workflow the three legacy families collectively supported | Workflow-by-workflow acceptance review against Student Onboarding's current step list |
| **User acceptance** | Real onboarding flows complete successfully end-to-end against the canonical domain | Pilot cohort sign-off (Part 10) before platform-wide rollout |

No phase in Part 14 advances past a gate it has not passed. Where a gate cannot yet be fully evaluated (e.g. Architecture Validation's external-artifact comparison, blocked until Part 5.1's canonical artifact is acquired), that gate is explicitly marked partial, not silently skipped — mirroring the honesty discipline the WP-DB-01 series itself modeled when it declined to invent a canonical comparison it couldn't actually perform.

---

## PART 12 — Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Monitoring | Rollback trigger |
|---|---|---|---|---|---|
| Migration chain still doesn't reconstruct cleanly after this document's Phase 0 (a third undiscovered defect, mirroring how the second was only found after the first was fixed) | Medium — the pattern has already repeated once | High — blocks every subsequent phase | Treat Schema stream completion as a genuine gate, not a checkbox; run the full `db reset` dry run in a disposable project, not just static analysis | Automated dry-run in CI on every schema-adjacent change during migration | Any `db reset` failure halts Phase 1 start until resolved |
| Three-way reconciliation (Part 7.3) finds students with genuinely conflicting facts across families (e.g. different marks for the same subject/period in Gen 1 vs Gen 2) | Medium — three independently-evolving families with no reconciliation to date make this plausible | Medium — affects data integrity for an unknown subset of students | Flag conflicts for manual reconciliation rather than auto-resolving (Principle 7); do not let conflict volume block the rest of the migration | Reconciliation-exception count tracked per fact type as a first-class migration metric | Exception rate above an agreed threshold pauses that fact type's cutover pending review |
| `signal_category_hierarchy`/`signal_ontology_edges` duplicate-definition decision (unrelated table, but shared migration chain) delays Schema stream completion | Medium | Low to this domain directly, but blocks shared infrastructure | Track as an explicit external dependency, not this domain's own decision to make (WP-DB-01 Reconciliation Planning already scoped it as "Requires Human Decision") | Track resolution status as a Schema-stream blocker in Part 14's Phase 0 | If unresolved beyond an agreed date, escalate rather than silently waiting |
| Unmounted Gen 1 routes or `controllers/`/`collectors/` duplication turn out to be load-bearing in a way static evidence couldn't show | Low to Medium | Medium — could break an undiscovered production path on retirement | Investigate before retiring (Part 6); treat "undetermined" as "not yet safe to touch," not as "probably fine" | Pre-retirement grep/trace pass repeated immediately before each retirement, not only during initial investigation | Any live traffic hitting a component flagged for retirement halts that retirement |
| Dual-write violation introduced accidentally during coexistence (e.g. a code path is missed and still writes to a legacy table after cutover) | Medium — coexistence periods are exactly where this class of bug hides | High — violates Principle 3 and risks silent data divergence | Command Router (Part 4.2) is the single enforced write path; any direct legacy write outside it is itself a bug to detect | Automated check: any write to a cut-over legacy table outside the Command Router raises an alert | Immediate halt of further cutovers in that stream until the leak is closed |
| Downstream runtime (e.g. Recommendation Engine) silently degrades in quality after cutover due to a subtle canonical-vs-legacy data shape difference | Medium | High — user-facing quality regression | Shadow-mode parallel-run validation (Part 11) before any runtime fully cuts over | Ongoing comparison sampling even after cutover, for an agreed bake-in period | Output-quality regression beyond an agreed threshold triggers rollback via Command Router |
| New runtimes (Decision Engine, Career Intelligence, etc.) are built against a still-moving canonical target, since domain migration and runtime construction overlap in time | Medium | Medium | Sequence new-runtime construction after the specific upstream fact types it depends on have fully cut over (Part 8.4–8.8), not in parallel with them | Track each new runtime's declared dependency's cutover status as a go/no-go gate for its own construction start | Do not begin building a new runtime against an upstream fact type that hasn't yet passed Runtime/Projection validation |
| AI-facing features (AI Context Generation) inherit and amplify any unresolved data-quality issue from earlier in the chain, given how provenance-dense that layer is | Low to Medium | High (reputational/business) | Build AI Context Generation last (Part 8.8), after every upstream layer has bake-in time | Provenance-completeness spot-checks (Part 11) before this runtime is considered production-ready | Any AI Context bundle with incomplete provenance is treated as not-production-ready, not shipped with a caveat |

---

## PART 13 — Migration Governance

1. **Architecture governance.** WP-ARCH-01B/C/D remain the fixed target throughout; this migration strategy may be revised for sequencing or risk reasons, but no revision may alter an architectural decision those documents already made — any apparent need to do so is escalated as a new ADR against those documents, not resolved unilaterally here.
2. **Change control.** Every migration stream's completion criteria (Part 5) is reviewed and signed off before the stream is marked complete for downstream planning purposes.
3. **Release governance.** Each fact-type cutover (Part 8) is its own release, independently approved, independently rollback-able — no cutover is bundled with an unrelated feature release.
4. **Version governance.** Taxonomy Version 1 (Part 5.2) and every subsequent version publish follows WP-ARCH-01C Part 14 rules 3, 5, 7 unchanged; this migration introduces no separate versioning scheme.
5. **Runtime governance.** Every runtime cutover or new-construction effort (Part 8) follows WP-ARCH-01D Part 10's runtime governance rules unchanged, including rule 13's future-runtime-onboarding checklist for the five runtimes being newly built.
6. **Reference-data governance.** From the moment Taxonomy Version 1 publishes, all taxonomy changes — including ones needed mid-migration to accommodate a legacy value not yet mapped — go through the formal stewardship process (WP-ARCH-01C Part 14 rule 3), never as an ad hoc migration-script edit.
7. **Migration approval gates.** Each phase in Part 14 requires explicit sign-off against its Part 11 verification gates before the next phase's production rollout (not development) begins; development work for the next phase may proceed in parallel, since it does not touch production.
8. **Documentation requirements.** Every cutover, dual-write-window boundary, and retirement is logged per Part 5.14 before it is executed, not reconstructed afterward from memory or git history.

---

## PART 14 — Transformation Timeline

### Phase 0 — Preparation
- **Objectives:** achieve a verified, clean, deterministic `supabase db reset`; acquire a genuine canonical schema artifact; resolve the `controllers/`/`collectors/` duplication ambiguity; investigate the four unmounted Generation 1 routes; retire the non-compliant `recommendation-engine.js`.
- **Dependencies:** none — this phase has the longest lead time and starts immediately, mirroring WP-DB-01 Reconciliation Planning's own Phase 0 sequencing for the narrower schema-only problem.
- **Deliverables:** a passing `db reset` dry run; a checked-in canonical artifact; a disposition decision for the duplicate controller/collector files and the unmounted routes; confirmed retirement of the non-compliant recommendation engine.
- **Success criteria:** every item above is closed, not merely investigated.
- **Exit criteria:** Schema stream (Part 5.1) is complete.

### Phase 1 — Canonical Schema Foundation
- **Objectives:** stand up the canonical domain's schema-level structures (aggregates, not yet populated).
- **Dependencies:** Phase 0 complete.
- **Deliverables:** empty but structurally complete canonical aggregates, ready to receive taxonomy and operational data.
- **Success criteria:** structure matches WP-ARCH-01B/C exactly.
- **Exit criteria:** Architecture Validation gate (Part 11) passes.

### Phase 2 — Reference Data
- **Objectives:** publish Taxonomy Version 1, seeded from the union of all three legacy families' code values (Part 5.2).
- **Dependencies:** Phase 1 complete.
- **Deliverables:** a complete, versioned taxonomy with no dropped legacy value.
- **Success criteria:** every legacy code value maps to a canonical entry.
- **Exit criteria:** Data Validation gate passes for reference data specifically.

### Phase 3 — Academic Domain
- **Objectives:** populate canonical operational aggregates via the Migration Composition Layer, reconciling all three families (Part 5.3, Part 7.1–7.4).
- **Dependencies:** Phase 2 complete.
- **Deliverables:** fully-reconciled canonical data, with logged exceptions for any unresolvable conflicts.
- **Success criteria:** every source record accounted for (migrated or explicitly excepted).
- **Exit criteria:** Data Validation gate passes for operational data.

### Phase 4 — Repository Layer
- **Objectives:** retire legacy repositories (Part 5.5) once their consumers no longer need them.
- **Dependencies:** Phase 3 complete for the relevant fact types.
- **Deliverables:** no application code importing a legacy repository.
- **Success criteria:** Repository Validation gate passes.
- **Exit criteria:** same.

### Phase 5 — Service Layer
- **Objectives:** redirect `StudentService` to canonical Academic Context; retire `educationIntelligence.service.js` (Part 5.6).
- **Dependencies:** Phase 4 complete.
- **Deliverables:** `StudentService`'s documented composition gap closed; Generation 1's orchestration responsibilities fully absorbed.
- **Success criteria:** Runtime Validation gate passes for Student Context Runtime.
- **Exit criteria:** same.

### Phase 6 — RPC Layer
- **Objectives:** evaluate and retire/fold Generation 4's RPC layer (Part 5.7).
- **Dependencies:** Phase 3 complete for Generation 4's fact types.
- **Deliverables:** no independently-callable RPC outside the canonical command surface.
- **Success criteria:** Repository Validation gate (extended to RPCs) passes.
- **Exit criteria:** same.

### Phase 7 — Runtime Integration
- **Objectives:** complete Student Context Runtime and Knowledge Runtime cutovers (Part 8.1–8.2).
- **Dependencies:** Phase 5 complete.
- **Deliverables:** both runtimes consuming only canonical projections.
- **Success criteria:** Runtime and Projection Validation gates pass.
- **Exit criteria:** same, plus a bake-in period of shadow-mode comparison with no material discrepancy.

### Phase 8 — Recommendation Integration
- **Objectives:** verify Recommendation Engine's unchanged compliance post-cutover (Part 8.3).
- **Dependencies:** Phase 7 complete.
- **Deliverables:** confirmed output equivalence.
- **Success criteria:** Recommendation Validation gate passes.
- **Exit criteria:** same.

### Phase 9 — Decision Integration
- **Objectives:** build Decision Engine (Part 8.4) — new construction, not migration.
- **Dependencies:** Phase 8 complete.
- **Deliverables:** a Decision Engine conforming to its WP-ARCH-01D contract.
- **Success criteria:** Decision Validation gate passes.
- **Exit criteria:** same.

### Phase 10 — Career Intelligence
- **Objectives:** build Career Intelligence, Career Outcome Intelligence Engine, and FYUGP Intelligence (Part 8.5–8.7).
- **Dependencies:** Phase 9 complete for Career Intelligence; Academic Context alone suffices for FYUGP Intelligence, so it may start earlier in parallel.
- **Deliverables:** three new runtimes conforming to their WP-ARCH-01D contracts.
- **Success criteria:** each runtime's respective validation criteria (extending Part 11's pattern) pass.
- **Exit criteria:** same.

### Phase 11 — AI Context Generation
- **Objectives:** build AI Context Generation last, once all its inputs have bake-in time (Part 8.8).
- **Dependencies:** Phase 10 complete.
- **Deliverables:** a fully provenance-complete AI Context bundle.
- **Success criteria:** AI Context Validation gate passes.
- **Exit criteria:** same.

### Phase 12 — Legacy Retirement
- **Objectives:** archive (not silently delete, per Principle 8) Generations 1, 2, and 4's tables, and retire the Migration Composition Layer and Command Router.
- **Dependencies:** every prior phase complete and bake-in periods elapsed with no unresolved discrepancy.
- **Deliverables:** the final architecture (Part 4.3) — no transition-era component remains.
- **Success criteria:** no consumer reads from or writes to any legacy table; Repository and Data Validation gates re-confirm this.
- **Exit criteria:** same.

### Phase 13 — Enterprise Verification
- **Objectives:** run the complete Part 11 verification suite end-to-end against the fully-migrated, fully-retired final state.
- **Dependencies:** Phase 12 complete.
- **Deliverables:** a signed-off, comprehensive verification record.
- **Success criteria:** every gate in Part 11 passes fully (including Architecture Validation's external-artifact comparison, no longer partial).
- **Exit criteria:** this migration strategy is formally closed; the domain and runtime landscape are the sole authoritative implementation, with no open transition debt.

---

## PART 15 — Architectural Decision Records (ADR)

### ADR-M01: Consolidate three legitimate lineages rather than declare one "correct" and discard the others

- **Decision:** treat Generations 1, 2, and 4 as three partial, genuine attempts at the same problem, each contributing to the canonical design (per WP-ARCH-01B ADR-01's own reasoning), rather than picking one to "win" and migrating the others' data into it as an afterthought.
- **Alternatives considered:** let Generation 4 (Family C) "win" outright since it is architecturally closest to canonical (rejected identically to how WP-ARCH-01B ADR-01 already rejected this, for the same reason — it is currently unreachable from any live UI, so choosing it as the migration target without also migrating Generations 1/2's live data would abandon real, currently-served users).
- **Architectural rationale:** WP-ARCH-01C's logical model already unifies all three families' concepts into single canonical entities; the migration should honor that unification rather than re-introduce a hierarchy among the sources.
- **Business rationale:** every one of the three families represents real historical student data; none is disposable.
- **Trade-offs:** three-way reconciliation (Part 7.3) is more work than a single-source migration would be; accepted as the cost of not losing data.
- **Risk analysis:** the main risk (conflicting facts across families) is directly addressed by Principle 7's exception-logging discipline rather than assumed away.
- **Long-term impact:** the canonical domain's data is genuinely complete from day one, rather than complete-except-for-whichever-family-was-deprioritized.

### ADR-M02: Cut writes over after reads, never the reverse, for every fact type

- **Decision:** within every fact-type cutover (Part 8, Part 10), canonical reads go live (first in shadow, then live) before canonical writes become authoritative.
- **Alternatives considered:** cut writes over first, on the reasoning that new data would then be canonical-native from the start.
- **Architectural rationale:** a write-first cutover means the read side (Migration Composition Layer or Academic Context) must still reconcile against a system that itself now depends on data quality it hasn't yet verified — reads-first lets every verification gate (Part 11) run against real canonical data before anything depends on it being correct.
- **Business rationale:** a read-side bug is recoverable (route back to legacy read); a write-side bug that has already accepted writes exclusively is a data-loss risk.
- **Trade-offs:** slightly longer time-to-full-cutover per fact type; accepted given the asymmetric risk profile.
- **Risk analysis:** directly mitigates the "dual-write violation" and "downstream runtime degrades silently" risks in Part 12.
- **Long-term impact:** establishes a repeatable, lower-risk pattern usable for any future domain migration this platform undertakes, not just this one.

### ADR-M03: Build the five unconfirmed runtimes only after their upstream dependency has bake-in time, never in parallel with that dependency's own cutover

- **Decision:** Decision Engine, Career Intelligence, Career Outcome Intelligence Engine, FYUGP Intelligence, and AI Context Generation are sequenced strictly after their respective upstream dependencies have passed verification and a bake-in period (Phases 9–11), rather than being built concurrently with earlier phases to save calendar time.
- **Alternatives considered:** build all nine runtimes in parallel from the start, since seven of them are new construction with no legacy coexistence constraint of their own.
- **Architectural rationale:** WP-ARCH-01D's own catalogue already notes these five runtimes have no evidence base at all; building them against a still-migrating upstream risks baking a moving target's temporary shape into a "new" component's assumptions, which is a worse outcome than a legacy-coexistence bug, since it would be mistaken for correct-by-design rather than recognized as transition debt.
- **Business rationale:** the business value of these five runtimes is realized once, correctly, rather than realized early and then re-validated repeatedly against a moving upstream.
- **Trade-offs:** longer overall calendar time to full nine-runtime landscape; accepted, since WP-ARCH-01D itself already establishes only two of nine runtimes are live today — there is no existing production dependency on the other seven that this sequencing puts at risk by taking longer.
- **Risk analysis:** directly mitigates the "new runtimes built against a moving target" risk in Part 12.
- **Long-term impact:** every one of the nine runtimes reaches production with a genuinely stable, verified upstream — the same standard of rigor WP-ARCH-01D itself applied to distinguishing evidence-confirmed from prospective contracts is carried through into how those contracts get built.

---

## Constraints Compliance Statement

This document does not redesign WP-ARCH-01B, WP-ARCH-01C, or WP-ARCH-01D — every reference to their aggregates, entities, events, projections, contracts, and governance rules is a citation, not a restatement or reinterpretation, and every reference to the WP-DB-01 series' findings is likewise a citation of that series' own numbering and conclusions. No SQL, PostgreSQL schema, Supabase migrations, repositories, services, APIs, RPCs, or implementation code appear anywhere above — every stream, matrix entry, and phase is described at the enterprise migration strategy level only, per the WP-ARCH-01E brief's constraints.
