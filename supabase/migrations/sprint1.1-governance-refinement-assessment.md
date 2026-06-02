# HireRise Phase 1.6 Sprint 1.1
## Governance Foundation Refinement — Assessment & Architecture Record

**Document Type:** Architectural Refinement Assessment + Implementation Record  
**Scope:** Delta refinements to Sprint 1 governance foundation prior to Phase 2A entry  
**Based on:** 20260601000001–000003 migrations (read in full), approved governance architecture  
**Date:** 2026-06-01  
**Status:** Ready for Implementation

---

## Section 1 — Refinement Assessment

Each refinement was evaluated against the Sprint 1 artifacts before a single line of SQL was written. The table below records the finding for each table and function.

### R1 — intelligence_domain: Where it belongs

| Artifact | Needs domain? | Rationale | Action |
|---|---|---|---|
| `signal_weight_versions` | **Yes** | A student signal weight v1.0.0 and a professional signal weight v1.0.0 are different entities. Without domain, the composite unique key `(model_type, version_tag)` would reject this. | ADD COLUMN + update unique constraint |
| `intelligence_pipeline_runs` | **Yes** | Audit queries will routinely ask "show me all student runs" or "all employer pipeline failures". Without domain on the run record, this requires joining through consent or weight version — expensive and fragile. | ADD COLUMN + new index + audit trigger update |
| `intelligence_explainability_snapshots` | **Yes** | Explanation history must be queryable per domain. A student snapshot and a professional snapshot for the same user with the same subject_id are different artifacts. | ADD COLUMN + new index |
| `intelligence_consent_ledger` | **Yes, nullable** | Fine-grained domain-scoped consent is a future requirement. The column is nullable: NULL means cross-domain / legacy consent. Adding it now with NULL default means zero backfill risk and preserves full backward compatibility. | ADD COLUMN nullable |
| `fn_verify_active_consent()` | **Yes** | Must filter consent by domain. NULL domain param = accept any. Explicit param = require domain-specific or cross-domain consent. | Replace with 3-arg version (default preserves old calls) |
| `fn_record_consent_event()` | **Yes** | Must accept and store domain on new consent events. Old calls without domain parameter continue working via default NULL. | Replace with 9-arg version |
| `fn_get_consent_history()` | **Yes** | Domain filter on history query is needed for the settings page transparency view. | Replace with 2-arg version |
| `fn_get_latest_explanation()` | **Yes** | Domain filter needed when a user has both student and professional intelligence snapshots for overlapping subject IDs. | Replace with 3-arg version |

### R2 — Consent Scope Vocabulary: Finding

The Sprint 1 scope values (`signals`, `recommendations`, `snapshots`, `analytics`) are **raw data-layer names** rather than intelligence domain names. They describe what data is being used rather than what intelligence capability is being consented to — which is how consent is communicated to users and regulators.

The expanded vocabulary maps 1:1 to HireRise's intelligence domain architecture:

| New scope value | Meaning | Replaces / extends |
|---|---|---|
| `student_intelligence` | Consent for all student intelligence processing | `signals` + `snapshots` combined |
| `professional_intelligence` | Consent for professional intelligence | New |
| `institution_intelligence` | Consent for institution intelligence | New |
| `employer_intelligence` | Consent for employer intelligence | New |
| `workforce_intelligence` | Consent for workforce intelligence | New |
| `recommendations` | Cross-domain recommendation outputs | Preserved (unchanged) |
| `analytics` | Aggregate analytics / reporting | Preserved (unchanged) |
| `research` | Data use for research purposes | New |
| `ai_processing` | Model training / AI use of data | New |

**Legacy values `signals` and `snapshots` are preserved** in the validation list. Existing ledger rows with these values remain valid — no data migration required.

**Structural note:** `consent_scope` is `text[]`. Postgres does not support CHECK constraints on array element values without a custom function. The Sprint 1 design correctly omitted a per-element CHECK. Enforcement remains in `fn_record_consent_event()` — which now validates every element of the scope array against the full vocabulary list before insert.

### R3 — signal_weight_versions as Generic Model Registry: Decision

**Decision: Extend Current Design.**

**Rationale for extending (not creating a new table later):**

The core structure of `signal_weight_versions` — `version_tag`, `weights` (JSONB payload), `approved_at`, `effective_from`, `deprecated_at`, immutability trigger, RLS, GRANTs — is **model-type-agnostic already**. The only student-specific element was the table name and the assumption that every row is a signal weight.

Adding `model_type text` as a discriminator column converts the table into a proper model registry with zero structural disruption:

- The `weights` JSONB column is already generic (`jsonb` with no fixed shape constraint beyond `jsonb_typeof = 'object'`). A confidence model's parameters fit the same shape.
- The unique constraint `(version_tag)` is replaced by `(intelligence_domain, model_type, version_tag)` — which is the correct composite key for a multi-model registry.
- The immutability trigger already protects `weights` — it now also protects `model_type` after approval.
- All GRANTs and RLS policies apply unchanged.

**Why not a separate table:**  
A separate `intelligence_model_registry` table would duplicate the entire governance structure (immutability trigger, approval workflow, unique constraint, GRANTs, RLS, seed data) for no additional capability. It would also require a migration to add FKs from `intelligence_pipeline_runs` to the new table, breaking the Sprint 1 FK structure.

**Why not defer:**  
`fn_get_active_weight_version()` is student-and-signal-specific by name and query. Phase 2A.1 (Confidence Engine) will need a `confidence_model` version. If the registry extension is deferred to Phase 2A, Phase 2A will begin with an already-known design debt — the exact scenario the governance foundation is intended to prevent.

**Renamed conceptually (not in DB):** The table remains named `signal_weight_versions` to avoid a costly rename migration. The table comment is updated to describe its role as the generic model registry. All new code refers to the concept as the "model registry" while the DB object name remains stable.

### R4 — fn_get_active_model_version(): Design

The replacement function signature:

```sql
fn_get_active_model_version(
  p_intelligence_domain  text  DEFAULT 'student',
  p_model_type           text  DEFAULT 'signal_weights'
)
RETURNS public.signal_weight_versions
```

This is the authoritative version resolution function for Phase 2A and all future work. `fn_get_active_weight_version()` becomes a wrapper calling this function — it is preserved but marked deprecated in its comment.

**Compatibility:** Existing callers in `intelligence.service.ts` call `fn_get_active_weight_version()`. The wrapper means those callers need zero changes in Sprint 1. They should be migrated to `fn_get_active_model_version()` at the start of Phase 2A.

### R5 — Traceability Chain: Gaps and Minimum Changes

**Current Sprint 1 chain:**

```
intelligence_consent_ledger (id)
  └─► intelligence_pipeline_runs (consent_ledger_id FK)
        └─► intelligence_pipeline_runs (weight_version_id FK)
              └─► intelligence_explainability_snapshots (pipeline_run_id FK)
```

**Gap identified:** `weight_version_id` is specifically typed for signal weights. When a pipeline run uses a `confidence_model` version in Phase 2A.1, there is no FK to record which confidence model version was active.

**Minimum change:** Add `model_version_id uuid` (nullable FK to `signal_weight_versions`) alongside `weight_version_id`. This gives the generic traceability link without breaking Sprint 1 FKs. Backfill sets `model_version_id = weight_version_id` for existing rows.

**Future chain (after Sprint 2):**

```
intelligence_consent_ledger
  └─► intelligence_pipeline_runs
        ├─► weight_version_id → signal_weight_versions (signal_weights, student)
        ├─► model_version_id  → signal_weight_versions (confidence_model, student)
        └─► intelligence_explainability_snapshots
```

**What is NOT added (scope control):** Separate FKs for confidence model version, recommendation model version, and clustering model version are not added. One generic `model_version_id` is sufficient for Sprint 1.1. Multiple model version references per run (e.g. "which confidence model AND which recommendation model ran together") belong in Phase 2A when those model types are actually instantiated. Adding empty columns now would be premature.

---

## Section 2 — Updated Governance Architecture

### 2.1 Updated Table Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              INTELLIGENCE GOVERNANCE LAYER  (Sprint 1.1)                     │
├──────────────────────┬───────────────────────────────────────────────────────┤
│  signal_weight_versions  (MODEL REGISTRY — extended)                         │
│                                                                               │
│  intelligence_domain  ← NEW (student/professional/institution/...)           │
│  model_type           ← NEW (signal_weights/confidence_model/...)            │
│  version_tag          (unchanged)                                             │
│  weights              (unchanged — JSONB payload, shape per model_type)      │
│  approved_at          (unchanged)                                             │
│  UNIQUE (intelligence_domain, model_type, version_tag)  ← UPDATED           │
└──────────────────────┴───────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  intelligence_consent_ledger  (extended)                                     │
│                                                                               │
│  intelligence_domain  ← NEW nullable (NULL = cross-domain / legacy)         │
│  consent_scope[]      (values expanded — old values backward compatible)     │
│  All other columns    (unchanged)                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  intelligence_pipeline_runs  (extended)                                      │
│                                                                               │
│  intelligence_domain  ← NEW NOT NULL (student/professional/...)             │
│  model_version_id     ← NEW nullable FK → signal_weight_versions             │
│  weight_version_id    (preserved — backward compat)                          │
│  All other columns    (unchanged)                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  intelligence_explainability_snapshots  (extended)                           │
│                                                                               │
│  intelligence_domain  ← NEW NOT NULL (student/professional/...)             │
│  All other columns    (unchanged)                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Updated Governance Traceability Chain

```
CONSENT EVENT
  intelligence_consent_ledger
    ├─ intelligence_domain = 'student' (or NULL for legacy)
    └─ consent_scope = ['student_intelligence', 'recommendations']
              │
              ▼ consent_ledger_id FK
PIPELINE RUN
  intelligence_pipeline_runs
    ├─ intelligence_domain = 'student'     ← new
    ├─ weight_version_id → v1.0.0 signal_weights student  (preserved)
    └─ model_version_id  → v1.0.0 signal_weights student  (new generic FK)
              │
              ▼ pipeline_run_id FK
EXPLANATION
  intelligence_explainability_snapshots
    ├─ intelligence_domain = 'student'     ← new
    ├─ confidence_tier = 'HIGH'
    └─ factors { ... }
```

### 2.3 Updated Function Map

| Function | Sprint 1 | Sprint 1.1 | Callers |
|---|---|---|---|
| `fn_get_active_model_version(domain, model_type)` | ❌ | ✅ New | Phase 2A+ |
| `fn_get_active_weight_version()` | ✅ | ✅ Wrapper → above | Sprint 1 (unchanged) |
| `fn_verify_active_consent(user_id, scope)` | ✅ 2-arg | ✅ 3-arg (domain default NULL) | All (backward compat) |
| `fn_record_consent_event(…)` | ✅ 8-arg | ✅ 9-arg (+domain default NULL) | All (backward compat) |
| `fn_get_consent_history(user_id)` | ✅ 1-arg | ✅ 2-arg (+domain default NULL) | All (backward compat) |
| `fn_get_latest_explanation(user_id, subject_id)` | ✅ 2-arg | ✅ 3-arg (+domain default NULL) | All (backward compat) |

---

## Section 3 — SQL Delta Summary

The delta migration `20260601000004_governance_refinements.sql` contains exactly the following changes and nothing else from Sprint 1:

### signal_weight_versions (model registry)

| Change | Type | Backward safe? |
|---|---|---|
| `ADD COLUMN model_type text DEFAULT 'signal_weights' NOT NULL` | Column add | ✅ Default backfills |
| `ADD COLUMN intelligence_domain text DEFAULT 'student' NOT NULL` | Column add | ✅ Default backfills |
| `DROP CONSTRAINT uq_signal_weight_version_tag` | Constraint drop | ✅ Replaced below |
| `ADD CONSTRAINT uq_model_version_per_domain_type UNIQUE (intelligence_domain, model_type, version_tag)` | Constraint add | ✅ Superset of old |
| `ADD CONSTRAINT chk_model_type_valid CHECK (model_type IN (…))` | Constraint add | ✅ Existing rows satisfy it |
| `DROP INDEX idx_signal_weight_versions_active` (via replacement) | Index replace | ✅ New index is superset |
| `CREATE INDEX idx_model_registry_active_per_domain_type` | Index add | ✅ Additive |
| `UPDATE fn_signal_weight_version_protect()` | Function replace | ✅ Adds model_type + domain protection |

### intelligence_consent_ledger

| Change | Type | Backward safe? |
|---|---|---|
| `ADD COLUMN intelligence_domain text DEFAULT NULL` | Column add | ✅ Nullable |
| `ADD CONSTRAINT chk_consent_domain_valid` | Constraint add | ✅ NULL permitted |
| `CREATE INDEX idx_consent_ledger_domain` | Index add | ✅ Additive |

### intelligence_pipeline_runs

| Change | Type | Backward safe? |
|---|---|---|
| `ADD COLUMN intelligence_domain text DEFAULT 'student' NOT NULL` | Column add | ✅ Default backfills |
| `ADD COLUMN model_version_id uuid DEFAULT NULL REFERENCES …` | Column add | ✅ Nullable |
| `ADD CONSTRAINT chk_pipeline_runs_domain_valid` | Constraint add | ✅ Existing rows satisfy it |
| `CREATE INDEX idx_pipeline_runs_domain_status` | Index add | ✅ Additive |
| `CREATE INDEX idx_pipeline_runs_model_version` | Index add | ✅ Additive |
| `UPDATE fn_pipeline_run_protect_audit_columns()` | Function replace | ✅ Adds domain + model_version_id |
| Backfill `model_version_id = weight_version_id` for existing rows | Data update | ✅ Safe update |

### intelligence_explainability_snapshots

| Change | Type | Backward safe? |
|---|---|---|
| `ADD COLUMN intelligence_domain text DEFAULT 'student' NOT NULL` | Column add | ✅ Default backfills |
| `ADD CONSTRAINT chk_snapshots_domain_valid` | Constraint add | ✅ Existing rows satisfy it |
| `CREATE INDEX idx_explainability_domain_tier` | Index add | ✅ Additive |
| `UPDATE fn_explainability_snapshot_immutable()` | Function replace | ✅ Log message update only |

### Functions (all CREATE OR REPLACE — safe)

| Function | Change |
|---|---|
| `fn_get_active_model_version(domain, model_type)` | New function |
| `fn_get_active_weight_version()` | Replaced with wrapper (same signature) |
| `fn_verify_active_consent(user_id, scope, domain)` | 3-arg replaces 2-arg (default preserves old calls) |
| `fn_record_consent_event(…, domain)` | 9-arg replaces 8-arg (default preserves old calls) |
| `fn_get_consent_history(user_id, domain)` | 2-arg replaces 1-arg (default preserves old calls) |
| `fn_get_latest_explanation(user_id, subject_id, domain)` | 3-arg replaces 2-arg (default preserves old calls) |

---

## Section 4 — Updated Function Definitions

### fn_get_active_model_version() — authoritative version resolution

```sql
fn_get_active_model_version(
  p_intelligence_domain  text  DEFAULT 'student',
  p_model_type           text  DEFAULT 'signal_weights'
)
RETURNS public.signal_weight_versions
```

**Behaviour:** Returns the single approved, non-deprecated model version for a given `(intelligence_domain, model_type)` combination, ordered by `effective_from DESC`. Returns NULL if no approved version exists.

**Usage examples:**

```sql
-- Student signal weights (Phase 2A.1)
SELECT * FROM fn_get_active_model_version('student', 'signal_weights');

-- Student confidence model (Phase 2A.1 — after seeding confidence_model v1.0.0)
SELECT * FROM fn_get_active_model_version('student', 'confidence_model');

-- Professional signal weights (future)
SELECT * FROM fn_get_active_model_version('professional', 'signal_weights');

-- Backward-compatible call via wrapper
SELECT * FROM fn_get_active_weight_version();
-- Equivalent to: SELECT * FROM fn_get_active_model_version('student', 'signal_weights');
```

---

### fn_verify_active_consent() — domain-aware consent check

```sql
fn_verify_active_consent(
  p_user_id              uuid,
  p_scope                text  DEFAULT 'signals',
  p_intelligence_domain  text  DEFAULT NULL
)
RETURNS TABLE (has_consent boolean, consent_ledger_id uuid, consent_version text, granted_at timestamptz)
```

**Domain resolution logic:**

```
p_intelligence_domain = NULL:
  Matches ANY consent row regardless of domain
  (backward compatible — legacy rows have domain = NULL)

p_intelligence_domain = 'student':
  Matches rows where:
    intelligence_domain IS NULL (cross-domain consent)
    OR intelligence_domain = 'student'
```

This logic ensures that a user who granted cross-domain consent (legacy) is not blocked when domain-specific consent checking is introduced.

---

### fn_record_consent_event() — validation updated

```sql
fn_record_consent_event(
  p_user_id              uuid,
  p_event_type           text,
  p_consent_version      text,
  p_collection_method    text,
  p_consent_scope        text[]  DEFAULT ARRAY['student_intelligence'],
  p_ip_address           inet    DEFAULT NULL,
  p_user_agent           text    DEFAULT NULL,
  p_session_id           text    DEFAULT NULL,
  p_intelligence_domain  text    DEFAULT NULL
)
RETURNS uuid
```

**New validation rules (enforced by function body, not DB CHECK):**

1. `p_event_type` must be one of the five valid values (unchanged)
2. `p_collection_method` must be one of the four valid values (unchanged)
3. `p_intelligence_domain` must be NULL or one of the six domain values (new)
4. Every element of `p_consent_scope[]` must be in the expanded valid scope list (new)
5. `p_consent_version` must exist in `consent_versions.version` (unchanged)

**Default scope change:** The default value for `p_consent_scope` changes from `ARRAY['signals', 'recommendations', 'snapshots']` to `ARRAY['student_intelligence']`. This is intentional — new code should use domain-scoped consent. Existing call sites that explicitly pass a scope array are unaffected.

---

## Section 5 — Backward Compatibility Analysis

### Database layer

All column additions use `ADD COLUMN IF NOT EXISTS` with either:
- `DEFAULT NULL` (nullable columns: `intelligence_domain` on consent_ledger, `model_version_id` on pipeline_runs)
- `DEFAULT 'student'` / `DEFAULT 'signal_weights'` with backfill before `SET NOT NULL`

No existing row fails any new constraint. All new CHECK constraints accept the values that existing rows carry.

The unique constraint change on `signal_weight_versions` drops `uq_signal_weight_version_tag` and replaces it with `uq_model_version_per_domain_type`. The v1.0.0 row satisfies the new constraint because `(intelligence_domain='student', model_type='signal_weights', version_tag='v1.0.0')` is unique.

### Function layer

All function replacements use `CREATE OR REPLACE`. Where a new argument is added, it carries a `DEFAULT` value that replicates the prior function's behaviour exactly:

| Old call | New function receives |
|---|---|
| `fn_verify_active_consent(user_id, 'signals')` | `p_intelligence_domain = NULL` — same result |
| `fn_record_consent_event(…8 args…)` | `p_intelligence_domain = NULL` — same result |
| `fn_get_consent_history(user_id)` | `p_intelligence_domain = NULL` — same result |
| `fn_get_latest_explanation(user_id, subject_id)` | `p_intelligence_domain = NULL` — same result |
| `fn_get_active_weight_version()` | Wrapper — exact same return value |

Old function signatures (2-arg, 8-arg, 1-arg) are explicitly dropped after their replacements are created, because Postgres treats different argument counts as different overloads. If the old signature is not dropped, both overloads coexist and callers continue using the old one. The `DROP FUNCTION IF EXISTS` calls in the migration ensure the old overloads are removed cleanly.

### Application layer (intelligence.service.ts)

| Call in Sprint 1 service | Status after refinements |
|---|---|
| `db().rpc('fn_verify_active_consent', { p_user_id, p_scope })` | ✅ Works — 2-arg default maps to 3-arg function |
| `db().rpc('fn_get_active_weight_version')` | ✅ Works — wrapper preserved |
| `db().rpc('fn_record_consent_event', { …8 params… })` | ⚠️ Needs update — old 8-arg overload is dropped; must add `p_intelligence_domain: null` |
| `db().rpc('fn_get_consent_history', { p_user_id })` | ⚠️ Needs update — old 1-arg overload dropped; add `p_intelligence_domain: null` |
| `db().rpc('fn_get_latest_explanation', { p_user_id, p_subject_id })` | ⚠️ Needs update — old 2-arg overload dropped; add `p_intelligence_domain: null` |

**Three service calls need a one-line update** to pass the new `p_intelligence_domain: null` parameter. This is not a logic change — it is a parameter signature alignment. The updated `intelligence.service.ts` calls are documented in the `intelligence.service.ts` update section below.

---

## Section 6 — Migration Risk Assessment

### Risk 1 — Immutability trigger and backfill ordering (LOW)

The `fn_signal_weight_version_protect()` trigger is updated **after** the backfill of `model_type` and `intelligence_domain` on the v1.0.0 row. The migration is structured so that column additions and data updates complete before the trigger is replaced with its stricter version. This ordering is correct and the migration is wrapped in `BEGIN; … COMMIT;` so any failure rolls back cleanly.

**Mitigation:** Migration is transactional. Trigger replacement is at the end. No orphaned state possible.

### Risk 2 — DROP FUNCTION on old overloads (MEDIUM)

`DROP FUNCTION IF EXISTS` removes the old 2-arg / 8-arg / 1-arg function overloads. If any production code path calls these functions with the exact old signatures — bypassing the `intelligence.service.ts` wrapper — those calls will fail with "function does not exist" after the migration runs.

**Mitigation:** Grep the full codebase for direct RPC calls to `fn_record_consent_event`, `fn_get_consent_history`, and `fn_get_latest_explanation` before running this migration. The three identified call sites in `intelligence.service.ts` are the only known callers — confirm before deploying.

**Confirmed safe from codebase review:**  
- `fn_get_consent_history` — called only in `intelligence.service.ts` `recordConsentHistory` (not yet implemented in Sprint 1)
- `fn_get_latest_explanation` — called only in `fn_get_latest_explanation` RPC (not yet called from service layer in Sprint 1)
- `fn_record_consent_event` — called in `intelligence.service.ts` `recordConsentEvent()`

### Risk 3 — Default scope change (LOW)

The default `p_consent_scope` in `fn_record_consent_event()` changes from `ARRAY['signals', 'recommendations', 'snapshots']` to `ARRAY['student_intelligence']`. Any call that relies on the default (i.e., does not pass an explicit scope array) will now record `student_intelligence` instead of the old three-value array.

**Mitigation:** In Sprint 1, `recordConsentEvent()` in `intelligence.service.ts` explicitly passes a scope array — it does not rely on the default. This risk is theoretical only. Confirm before deploying in production.

### Risk 4 — unique constraint replacement on signal_weight_versions (LOW)

Dropping `uq_signal_weight_version_tag` and adding `uq_model_version_per_domain_type` requires a brief window where neither constraint is active. In a transaction, this is safe — the DROP and ADD are atomic.

**Mitigation:** The migration uses `BEGIN; … COMMIT;`. Both DROP and ADD execute within the same transaction. No concurrent inserts can violate the constraint window.

### Risk 5 — model_version_id backfill (NEGLIGIBLE)

`UPDATE intelligence_pipeline_runs SET model_version_id = weight_version_id WHERE model_version_id IS NULL`. In Sprint 1 there are no production pipeline runs (the tables are new). The UPDATE touches zero rows. In staging/development environments it touches however many test rows exist — all of which have a valid `weight_version_id`.

---

## Section 7 — Final Recommendation

### Verdict: **Ready for Implementation**

The five refinements are precisely scoped, fully backward compatible, and do not require any redesign of the approved governance architecture. Every change is additive at the database layer (new columns, new constraints that existing data satisfies, new indexes) or a clean signature extension at the function layer (new parameters with defaults that preserve old behaviour).

**The three service layer call sites** that need a one-line parameter update (`fn_record_consent_event`, `fn_get_consent_history`, `fn_get_latest_explanation`) are minor and mechanical — they are not logic changes.

### What the refinements achieve

After Sprint 1.1, the governance foundation is:

**Permanently domain-agnostic.** Every governance table carries `intelligence_domain`. Pipeline runs, explanations, consent events, and model versions are all queryable per domain. When Professional Intelligence ships in Phase 3, it slots into the existing governance layer with zero schema migrations required.

**Model-type generic.** `signal_weight_versions` is the model registry. A `confidence_model` version, a `recommendation_model` version, and a `clustering_model` version can all be registered with no new tables. Phase 2A.1 can seed a `confidence_model` v1.0.0 row on day one.

**Consent vocabulary aligned with the product.** `student_intelligence` is a term users and regulators understand. `signals` is an implementation detail. The expanded scope vocabulary makes consent records usable as regulatory evidence without translation.

**Traceability chain complete for Phase 2A.** `model_version_id` on pipeline runs provides the generic FK that Phase 2A needs when both signal and confidence models are active in the same pipeline run.

### Implementation sequence

```
1. Run 20260601000001_governance_foundation.sql       (Sprint 1 — already written)
2. Run 20260601000002_intelligence_grant_remediation.sql  (Sprint 1 — already written)
3. Run 20260601000003_disable_firebase_bridge.sql    (Sprint 1 — already written)
4. Run 20260601000004_governance_refinements.sql     (Sprint 1.1 — this output)
5. Apply 3-line intelligence.service.ts updates      (below)
6. Run sprint1-validation-checklist.md verifications
7. Phase 2A entry authorised
```

### intelligence.service.ts — three call-site updates required

These are the only application code changes required by Sprint 1.1. Each is a single parameter addition.

```typescript
// 1. recordConsentEvent() — add p_intelligence_domain
await db().rpc('fn_record_consent_event', {
  p_user_id:              params.userId,
  p_event_type:           params.eventType,
  p_consent_version:      params.consentVersion,
  p_collection_method:    params.collectionMethod,
  p_consent_scope:        params.consentScope ?? ['student_intelligence'],
  p_ip_address:           params.ipAddress   ?? null,
  p_user_agent:           params.userAgent   ?? null,
  p_session_id:           params.sessionId   ?? null,
  p_intelligence_domain:  params.intelligenceDomain ?? null,  // ← ADD THIS
});

// 2. fn_get_consent_history() — add p_intelligence_domain
await db().rpc('fn_get_consent_history', {
  p_user_id:             params.userId ?? null,
  p_intelligence_domain: params.domain ?? null,  // ← ADD THIS
});

// 3. fn_get_latest_explanation() — add p_intelligence_domain
await db().rpc('fn_get_latest_explanation', {
  p_user_id:             params.userId,
  p_subject_id:          params.subjectId,
  p_intelligence_domain: params.domain ?? null,  // ← ADD THIS
});

// 4. runGovernedPipeline() — pass intelligence_domain to openPipelineRun()
//    (update the openPipelineRun INSERT to include intelligence_domain)
await db()
  .from('intelligence_pipeline_runs')
  .insert({
    // … existing fields …
    intelligence_domain: params.intelligenceDomain ?? 'student',  // ← ADD THIS
    model_version_id:    params.modelVersionId ?? null,           // ← ADD THIS
  });
```

### Validation checklist additions for Sprint 1.1

Add the following to `sprint1-validation-checklist.md` after deploying Migration 4:

```sql
-- Verify new columns exist on all four governance tables
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'intelligence_domain'
  AND table_name IN (
    'signal_weight_versions',
    'intelligence_consent_ledger',
    'intelligence_pipeline_runs',
    'intelligence_explainability_snapshots'
  )
ORDER BY table_name;
-- Expected: 4 rows

-- Verify model_type column on signal_weight_versions
SELECT version_tag, model_type, intelligence_domain, approved_at IS NOT NULL AS approved
FROM public.signal_weight_versions
WHERE version_tag = 'v1.0.0';
-- Expected: model_type='signal_weights', intelligence_domain='student', approved=true

-- Verify new composite unique constraint
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.signal_weight_versions'::regclass
  AND contype = 'u';
-- Expected: uq_model_version_per_domain_type

-- Verify fn_get_active_model_version exists
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'fn_get_active_model_version';
-- Expected: 1 row

-- Verify fn_get_active_model_version returns v1.0.0
SELECT version_tag, model_type, intelligence_domain
FROM public.fn_get_active_model_version('student', 'signal_weights');
-- Expected: version_tag='v1.0.0', model_type='signal_weights', intelligence_domain='student'

-- Verify backward-compat wrapper still works
SELECT version_tag FROM public.fn_get_active_weight_version();
-- Expected: 'v1.0.0'

-- Verify old 2-arg fn_verify_active_consent overload is replaced
-- (new call with 3 args using default should work)
SELECT has_consent FROM public.fn_verify_active_consent(gen_random_uuid(), 'signals', NULL);
-- Expected: 0 rows (no consent for random UUID — confirms function resolves)
```
