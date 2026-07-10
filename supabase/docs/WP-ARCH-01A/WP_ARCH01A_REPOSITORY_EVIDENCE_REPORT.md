# WP-ARCH-01A — Student Academic Domain Repository Evidence Report

**Type:** Investigation only. No architecture, schema, or migration recommendations are made in this document, per WP-ARCH-01A scope constraints.
**Predecessor:** WP-DB-01 (migration chain audit). This report does not repeat or revise WP-DB-01's conclusions; it references them only where the same file paths are corroborated.
**Scope note (read first):** This is a targeted evidence investigation, not an exhaustive line-by-line audit of every one of the ~400+ files that contain a broad keyword like "education" or "academic". Section 9 lists what was and wasn't fully traced, so assumptions aren't hidden.

---

## 1. Repository Inventory

### 1.1 Canonical-name search (exact table/entity names from the WP-ARCH-01A brief)

| Term | Files matched | Status |
|---|---|---|
| `student_academic_records` | 7 | Active — Phase-2 canonical table |
| `student_academic_subjects` | 10 | Active — Phase-2 canonical table |
| `student_academic_profiles` | 4 | Present only in backups + one Phase-2b migration; not confirmed as a real, queried table |
| `student_subject_selections` | 4 | Present only in backups + one Phase-2b migration; not confirmed as a real, queried table |
| `student_language_preferences` | 4 | Present only in backups + one Phase-2b migration; not confirmed as a real, queried table |
| `student_academics_profiles` | 3 | Appears in a legacy `recommendation-engine.js` reference only; no migration defines this exact name |
| `student_education_profiles` | 16 | Active — spans backend service, frontend onboarding API/schema/hooks, and one migration |
| `edu_students` | 8 | Active — legacy/parallel canonical table, still live |
| `edu_academic_records` | 5 | Active — legacy/parallel canonical table, still live |
| `edu_stream_scores` | 6 | Active — legacy/parallel canonical table, still live |
| `edu_cognitive_results` | 6 | Active — legacy/parallel canonical table, still live |
| `edu_extracurricular` | 5 | Active — legacy/parallel canonical table, still live |

Full file-level detail behind each row is in `table_files.txt`-equivalent evidence below (Section 1.2).

### 1.2 File-level detail for the two competing "academic data" families

**Family A — `student_academic_*` (Phase-2 / student-onboarding lineage)**
- `core/src/modules/student-onboarding/repositories/academic.repository.js` — repository layer. Confirmed live Supabase queries:
  - `.from('student_academic_records')` (lines 35, 87)
  - `.from('student_academic_subjects')` (lines 41, 132, 163)
- `core/src/modules/student-onboarding/signals/domain-normalizers.js` — references `student_academic_subjects`
- `core/src/modules/knowledge-runtime/student/studentIntelligence.service.js` — references `student_academic_subjects` as a **known but not-yet-wired source** (see Section 6, direct code comment evidence)
- `core/supabase/migrations/20260522000001_student_academic_records.sql` — defines the table
- `core/supabase/migrations/20260522000002_academic_rls_policies.sql` — RLS policies for it
- `core/supabase/migrations/20260527000003_phase2b_student_academic_rpcs_evolution.sql` — RPC layer; contains `student_academic_profiles`, `student_subject_selections`, `student_language_preferences` references
- Frontend: `front/src/modules/student-onboarding/{hooks,api}/*` consume `student_education_profiles` as an API-contract shape (see 1.1 row 7) — this is a **frontend-facing name**, not confirmed 1:1 with any single backend table; treat as a DTO/contract name, not a table name, absent further evidence.

**Family B — `edu_*` (education-intelligence lineage, defined in `000_initial_schema.sql`)**
- `core/src/modules/education-intelligence/models/student.model.js` — defines the canonical `TABLES` map:
  ```
  STUDENTS: 'edu_students'
  ACADEMIC_RECORDS: 'edu_academic_records'
  EXTRACURRICULAR: 'edu_extracurricular'
  COGNITIVE_RESULTS: 'edu_cognitive_results'
  STREAM_SCORES: 'edu_stream_scores'
  ```
- `core/src/modules/education-intelligence/repositories/student.repository.js` — all queries go through this file, using `supabase.from(TABLES.X)`, i.e. it resolves to the `edu_*` names above. **Fact, verified directly:** this repository uses Supabase (`require('../../../config/supabase')`), not Firebase. Any assumption that `edu_*` is "Firebase legacy" is **not supported by this file** — it is a live Supabase-backed table family.
- `core/src/modules/opportunities/services/studentMatching.service.js` — reads `edu_stream_scores`, `edu_cognitive_results`
- `core/src/services/educationIntelligence.service.js` — orchestration layer sitting on top of the same repository; explicitly documents itself as the *only* sanctioned entry point ("Controllers and collectors call this service. They do NOT import engines directly.")
- `core/supabase/migrations/000_initial_schema.sql` — defines all five `edu_*` tables originally.

### 1.3 Broader keyword scan (context only, not fully individually traced — see Section 9)

Counted across `core/src`, `core/supabase/migrations`, and `front/src` (backups, quarantine, and `migrations_original_backup` excluded to avoid double-counting):

| Keyword | Files |
|---|---|
| education | 144 |
| medium | 136 |
| academic | 86 |
| grade | 81 |
| language | 80 |
| stream | 55 |
| subject | 53 |
| board | 29 |
| school | 29 |
| credits | 24 |
| institution | 22 |
| university | 17 |
| curriculum | 12 |
| qualification | 12 |
| college | 3 |
| semester | 1 |
| cgpa | 0 |
| gpa | 0 |

`cgpa`/`gpa` returning zero is a fact of the current codebase — grading appears to be modeled some other way (e.g. `grade`, `credits`) rather than under those literal terms. No inference is made here about what that other modeling is without further tracing.

---

## 2. Dependency Graph (confirmed edges only)

```
server.js
 ├─ mounts  /api/v1/student-onboarding        → routes/student-onboarding.routes.js
 ├─ mounts  /api/v1/student-onboarding/academics → student-onboarding/routes/academics.routes.js
 ├─ mounts  /api/v1/student-context           → knowledge-runtime/student/studentIntelligence.routes.js
 └─ mounts  (education-intelligence prefix)   → education-intelligence/routes/student.routes.js   [ONLY this one education-intelligence route file is mounted]

knowledge-runtime.module.js
 ├─ requires  student/studentIntelligence.service.js
 ├─ requires  student/studentIntelligence.repository.js
 ├─ requires  education-intelligence/repositories/student.repository.js   ← edu_* family
 ├─ requires  student-onboarding/services/education.service.js            ← student_education_profiles
 └─ requires  student-onboarding/services/careerProfile.service.js

studentIntelligence.service.js (Knowledge Runtime)
 ├─ sources from education-intelligence/repositories/student.repository.js#getStudent → edu_students   [CONFIRMED, in-use]
 └─ notes student_academic_subjects (student-onboarding/repositories/academic.repository.js) as
    "located but not wired into this composition" — a documented, unresolved gap, not an assumption.

educationIntelligence.service.js (src/services/, separate from the module of the same domain name)
 └─ requires  education-intelligence/repositories/student.repository.js → edu_students, edu_academic_records, edu_stream_scores, edu_cognitive_results (via TABLES map)
```

**Inbound references to `education-intelligence/repositories/student.repository.js` (i.e. to the `edu_*` family):**
`school/services/school.service.js`, `knowledge-runtime.module.js`, `knowledge-runtime/student/studentIntelligence.repository.js`, `knowledge-runtime/student/studentIntelligence.service.js`, `ai-career-advisor/services/advisor.service.js`, `src/services/educationIntelligence.service.js`, `src/server.js`, `src/routes/careerPrediction.routes.js`.

**Inbound references to the `student_academic_*` repository/service layer:**
`student-onboarding/controllers/studentOnboarding.controller.js`, `student-onboarding/controllers/intelligence.controller.js`, `student-onboarding/controllers/academics.controller.js`, `student-onboarding/index.js`, `knowledge-runtime.module.js`, `knowledge-runtime/student/studentIntelligence.service.js`.

**Fact:** `knowledge-runtime.module.js` and `studentIntelligence.service.js` are the single confirmed point where **both** families are imported into the same runtime.

---

## 3. Data Ownership Matrix

| Data concern | Owning table family | Owning module | Live/queried? |
|---|---|---|---|
| Core student record | `edu_students` | education-intelligence | Yes |
| Academic subject/board records (legacy) | `edu_academic_records` | education-intelligence | Yes |
| Stream/competitive scores (legacy) | `edu_stream_scores` | education-intelligence | Yes |
| Cognitive assessment results (legacy) | `edu_cognitive_results` | education-intelligence | Yes |
| Extracurricular records (legacy) | `edu_extracurricular` | education-intelligence | Yes |
| Academic records (Phase-2 canonical) | `student_academic_records` | student-onboarding | Yes |
| Academic subjects (Phase-2 canonical) | `student_academic_subjects` | student-onboarding | Yes |
| Education profile (frontend contract name) | `student_education_profiles` | student-onboarding (backend) + frontend onboarding module | Yes, as API contract; backend table identity not independently re-confirmed in this pass |
| Academic profile / subject selection / language preference (Phase-2b RPC layer) | `student_academic_profiles`, `student_subject_selections`, `student_language_preferences` | student-onboarding (RPC evolution migration only) | **Not confirmed** — no application code queries these names directly; they only appear inside one migration and the pre/post schema backups. Repository does not contain enough information to state whether these are live tables, RPC-internal parameter shapes, or dead definitions. |

---

## 4. Module Responsibility Matrix

| Module | Primary responsibility (as documented in-repo) | Operational | Analytical | Canonical |
|---|---|---|---|---|
| `student-onboarding` | Owns the onboarding flow and Phase-2 academic/activity/cognitive intake (`academics.repository.js`, `education.service.js`) | Yes | No | Yes, for Phase-2 fields |
| `education-intelligence` | Owns `edu_*` schema: student profile, academic records, stream scores, cognitive results, extracurricular, plus ROI/career-simulation/career-prediction engines | Yes (student.routes.js mounted; repository actively queried) | Yes (engines: `educationROI`, `careerSuccess`, `careerDigitalTwin`, `academicTrend`, `streamIntelligence`, `cognitiveProfile`, `activityAnalyzer`) | Yes, for `edu_*` fields |
| `knowledge-runtime` (Student Context Runtime) | Composes a unified student context for downstream Recommendation/Decision/Explainability services | Yes | Consumer, not source | No — explicitly a composition layer over both families above |
| `services/educationIntelligence.service.js` | Documented as the sole orchestration entry point for career-success/ROI/digital-twin engines, replacing direct engine imports | Yes | Yes | N/A (orchestration, not data owner) |

---

## 5. Active vs Dead Components

**Confirmed active (mounted in `server.js` and/or actively queried):**
- `student-onboarding.routes.js`, `student-onboarding/routes/academics.routes.js`, `student-onboarding/routes/activities.routes.js`, `student-onboarding/routes/cognitive.routes.js`, `student-onboarding/routes/intelligence.routes.js`
- `knowledge-runtime/student/studentIntelligence.routes.js` (mounted at `/api/v1/student-context`)
- `education-intelligence/routes/student.routes.js`

**Confirmed present but NOT mounted anywhere in `server.js`** (repository contains the route files; no `app.use` wires them):
- `education-intelligence/routes/careerSimulation.routes.js`
- `education-intelligence/routes/roiAnalysis.routes.js`
- `education-intelligence/routes/careerPrediction.routes.js`
- `education-intelligence/routes/analysis.routes.js`

This is a fact established by grepping `server.js` for every `app.use(...require(...))` call and cross-checking against the route files that exist on disk — not an inference. (Note: `src/routes/careerPrediction.routes.js` — a *different* file under `src/routes/`, not `education-intelligence/routes/careerPrediction.routes.js` — does reference the education-intelligence repository; that top-level route file's own mount status was not separately re-verified in this pass.)

**Explicitly quarantined (pre-existing, not part of this investigation's findings but relevant context):**
- `core/quarantine/frontend-leakage/` — 2 files
- `core/src/quarantine/` — consensus mesh, routing-policy, resilience, and orphaned service files (~15 files), with its own `README.md` explaining the quarantine rationale. None of these reference the student-academic domain by name; noted for completeness since WP-ARCH-01A asks about dead/duplicated component detection generally.

**Duplicate directory structure (unrelated to quarantine, found incidentally):**
`core/src/modules/education-intelligence/controllers/*` and `core/src/modules/education-intelligence/collectors/*` contain files with identical names (`roiAnalysis.controller.js`, `analysis.controller.js`, `careerSimulation.controller.js`, `student.controller.js`, `careerPrediction.controller.js`) in both `controllers/` and `collectors/`. This report does not have enough evidence to state whether these are duplicates, re-exports, or genuinely different implementations — flagged as a finding requiring direct diff, not resolved here.

---

## 6. Duplicate Concepts

1. **Two independently-schema'd "student academic data" families are simultaneously live**: `edu_*` (education-intelligence, defined in `000_initial_schema.sql`) and `student_academic_*` (student-onboarding, defined in the Phase-2 migrations of May 2026). Both are queried by production code today.
2. **`knowledge-runtime`'s `studentIntelligence.service.js` contains a direct code comment acknowledging this duplication**, stating that `student_academic_subjects` "was located but not wired into this composition — needs confirmation of shape before reuse," while the same service currently sources subjects/skills data from the legacy `edu_students.skills` flat array. This is the clearest first-party evidence in the repository that the duplication is known internally, not just an external observation.
3. **`student_academics_profiles`** (note: "academics" plural, one letter-order variant away from `student_academic_profiles`) appears only inside `student-onboarding/services/recommendation-engine.js` — a third, unconfirmed spelling variant. Repository does not contain enough information to determine if this is a typo, a dead reference, or an intentional distinct concept.
4. **`controllers/` vs `collectors/` duplicate filenames** in education-intelligence (Section 5) — flagged, not resolved.

---

## 7. Repository Integrity Findings

- **Migration file renaming is confirmed and matches WP-DB-01's prior standardization work**: diffing `core/supabase/migrations/` against `core/supabase/migrations_original_backup/` shows 9 files present under new canonical timestamped names (e.g. `20260531000001_migration_1a_01_enums.sql`) that exist under different, non-canonical names in the backup (e.g. `migration_1A_01_enums.sql`), confirming the backup folder predates the standardization pass.
- **The specific migration `20260527000003_phase2b_student_academic_rpcs.sql`** (without the `_evolution` suffix) does **not** exist anywhere in the repository. Only `20260527000003_phase2b_student_academic_rpcs_evolution.sql` exists, at the same timestamp position. This is consistent with — and does not contradict — the prior WP-DB-01 finding that this file should not be reconstructed; it is independently re-confirmed here by direct directory listing rather than assumed.
- **Sensitive credential files exist at the repository root** (`supa api.txt`, `supa data password.txt`, `claudeapi key.txt`, `googlesheets api.txt`). These were not opened or read as part of this investigation since they are out of scope for a student-academic-domain report, but their presence in the root of an archive that gets shared is worth flagging on integrity grounds alone.

---

## 8. Architectural Risks (observed only — no remediation proposed)

1. **Two live, independently-owned table families answer the same conceptual question ("what does this student's academic record look like")**, and the one runtime that has to reconcile them (`knowledge-runtime`) has an open, code-documented gap rather than a resolved mapping.
2. **`education-intelligence`'s student-facing route is mounted, but four of its five route files (`careerSimulation`, `roiAnalysis`, `careerPrediction`, `analysis`) are not mounted anywhere found in `server.js`.** Whether these are (a) intentionally staged for a future release, (b) genuinely dead, or (c) mounted through a path this investigation didn't find, cannot be determined from static evidence alone.
3. **Three Phase-2b table names (`student_academic_profiles`, `student_subject_selections`, `student_language_preferences`) exist only inside one RPC-evolution migration and schema backups, with no corresponding application-code queries found.** Whether they are live-but-unused, RPC-internal-only, or vestigial cannot be determined without direct database inspection (out of scope here — this report is repository-evidence only, as instructed).
4. **Duplicate `controllers/`/`collectors/` file sets in education-intelligence** raise a maintenance-drift risk if one set is edited without the other being kept in sync — unconfirmed whether this is currently happening.

---

## 9. Evidence Coverage & Limitations

- **Fully traced with direct file inspection:** all 12 canonical table/entity names listed in the WP-ARCH-01A brief; the mount table in `server.js`; the migration-backup diff; the `knowledge-runtime` import graph; the `education-intelligence` `TABLES` map and its repository.
- **Counted but not individually opened:** the broader keyword scan in Section 1.3 (144 "education" files, 86 "academic" files, etc.) — these counts establish scale and are accurate as file-match counts, but this report does not claim to have read all of them. Treat Section 1.3 as a map of where to look next, not a statement about what each file does.
- **Not inspected at all:** live database state (this was explicitly out of scope — repository evidence only), `front/dist` build artifacts beyond the one incidental match noted in Section 1.1, and the `.z01/.z02/.z03` split-archive remnants of `hirerise-core` (the `core/` directory itself was already present as extracted files, so these were not needed and were not opened).
- Anywhere this report says "not confirmed" or "repository does not contain enough information," that is a deliberate refusal to infer, per the brief's instruction to distinguish fact from assumption.
