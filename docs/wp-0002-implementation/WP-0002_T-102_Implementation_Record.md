# WP-0002 — Task T-102 Implementation Record
**Enable RLS on the `sim_sources` Table Family**
Scope: Task T-102 only. No other task (T-103, T-104, T-201, T-301, T-401, ...) was touched.

---

## 1. Implementation Summary

Repository evidence traced every legitimate access path to the four affected tables and found a single, consistent pattern: the entire `source-intelligence` (SIM) module is (a) mounted behind `authenticate` + `requireAdmin` at the API layer, and (b) exclusively backed by a Supabase client constructed with `SUPABASE_SERVICE_ROLE_KEY`, never the anon or authenticated keys. No frontend code, RPC function, or worker was found referencing these tables. This matches the "internal system table" case in the Task T-102 instructions, so the implementation grants **service-role-only** access — no authenticated-user policy was needed or added, because no repository evidence supports end users needing direct table access.

One SQL migration was written. No backend code, service, API, or test file required modification, because the application's existing data-access path (service-role client) is unaffected by enabling RLS with a service-role policy — the service role bypasses RLS regardless, so this change only closes off the unintended `anon`/`authenticated` PostgREST exposure without altering any code path the application actually uses.

## 2. Repository Changes

| File | Change |
|---|---|
| `core/supabase/migrations/20260710000001_wp_0002_t102_sim_sources_rls.sql` | **New file.** Enables RLS, adds four service-role-only policies, and revokes/re-grants table privileges on `sim_sources`, `sim_source_health_snapshots`, `sim_source_relationships`, `sim_source_audit_log`. |

No other file was modified. No existing migration was edited (per constraint: "Do not modify unrelated SQL").

## 3. SQL Migration

See `20260710000001_wp_0002_t102_sim_sources_rls.sql` (delivered alongside this record). Structure:
1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for all four tables.
2. One `CREATE POLICY ..._service_role_full_access ... TO "service_role" USING (true) WITH CHECK (true)` per table, matching this repository's existing naming/shape convention (e.g. `emp_employer_users_service_role_full_access` in `000_initial_schema.sql`), each preceded by `DROP POLICY IF EXISTS` for idempotency.
3. `REVOKE ALL ... FROM "anon", "authenticated"` on all four tables, to remove reliance on the schema-level default-privilege grant, followed by an explicit `GRANT ALL ... TO "service_role"` for clarity.
4. A commented, ready-to-run rollback block at the end of the file.

The migration is wrapped in a single `BEGIN;` / `COMMIT;` transaction and every statement is idempotent (`IF EXISTS` guards throughout), consistent with the style of the migration that created these tables (`20260706000001_wp_p2_01_sim_enterprise_foundation.sql`).

## 4. Backend Changes

**None required.** Evidence supporting this conclusion:
- `core/src/server.js` (line ~4555): `app.use('${API_PREFIX}/admin/source-intelligence', authenticate, requireAdmin, require('./modules/source-intelligence').routes)` — the entire SIM route surface already requires both a valid JWT and the admin role at the application layer, independent of this migration.
- `core/src/modules/source-intelligence/routes/source.routes.js` header comment confirms the same intent: *"SIM is an internal enterprise-governance system, not student/employer facing, so admin-only is the correct default."*
- All four repositories (`sourceRegistry.repository.js`, `sourceHealth.repository.js`, `sourceRelationship.repository.js`, `sourceAudit.repository.js`) import `{ supabase }` from `core/src/config/supabase.js`, which is constructed from `SUPABASE_SERVICE_ROLE_KEY` (confirmed by direct file read — `config/supabase.js` throws at startup if `SUPABASE_SERVICE_ROLE_KEY` is missing, and never references `SUPABASE_ANON_KEY`).
- No file under `front/src` references any of the four table names (`grep -rl` returned zero matches), so no frontend code path talks to these tables directly (via anon key) at all.
- No `CREATE POLICY`, RPC `GRANT`, or `SECURITY DEFINER` function referencing any of the four tables was found anywhere in the 43k-line migration set beyond index/constraint/comment references, confirming there is no other access path this migration could break.

Because the service role bypasses RLS by design, and every real access path already uses the service role, enabling RLS with a service-role policy is expected to be **behavior-preserving** for the application while closing the unintended direct-API exposure.

## 5. Validation Results

| Validation | Result | Justification |
|---|---|---|
| Database validation (RLS enabled) | **Not Tested** | No live database or staging Postgres instance was available in this environment to execute the migration and query `pg_class.relrowsecurity`. The migration syntax was manually reviewed against this repository's own established, working RLS-migration patterns (e.g. `emp_employer_users_service_role_full_access`) rather than executed. |
| Policy validation | **Not Tested** (same reason) | Policy SQL was hand-verified against Postgres `CREATE POLICY` syntax and against this repository's own equivalent, already-deployed policies for structural correctness, but not executed against a live catalog. |
| Authorization validation (negative test: anon/authenticated denied) | **Not Tested** | Requires a live Supabase project with an issued `anon` key to attempt a PostgREST call; not available in this environment. |
| Authorization validation (positive test: service_role / admin API still works) | **Not Tested** | Same reason; additionally would require running the Node backend against a live database. |
| Regression testing | **Not Tested** | No existing automated test in `core/src/modules/source-intelligence/__tests__/` exercises RLS directly (they test service/model logic, not database-level access control), and no live database was available to add or run a new integration test against. |
| Dependency validation (no other consumer of these tables exists) | **Passed** | Verified by exhaustive text search: zero frontend references, zero RPC/function references, zero other backend module references outside `source-intelligence`'s own repositories — all confirmed by direct `grep` against the full repository and the full migration set (Section 4 above). |
| Migration validation (idempotency, transactional safety, style conformance) | **Passed** | Manually verified: single `BEGIN`/`COMMIT` block, every statement uses an `IF EXISTS`/`DROP ... IF EXISTS` guard, naming matches the project's existing `<table>_service_role_full_access` convention, no unrelated object touched. |

**This is a real limitation of this implementation phase, not an oversight**: this environment has no live Postgres/Supabase instance to execute against. The migration is written to this repository's own proven, already-deployed pattern (the identical shape is already running successfully for `emp_employer_users`, `admin_users`, and others), which is the strongest available substitute for live execution absent database access — but it is not a substitute for actually running it. **Before this migration is applied to any real environment, Database validation, Policy validation, and both Authorization validation rows above must be executed against a staging database and re-recorded as Passed/Failed, not left as Not Tested.**

## 6. Implementation Evidence

- Table creation source: `core/supabase/migrations/20260706000001_wp_p2_01_sim_enterprise_foundation.sql`, lines 61 (`sim_sources`), 119 (`sim_source_health_snapshots`), 137 (`sim_source_audit_log`), 292 (`sim_source_relationships`).
- Route mounting / auth guard: `core/src/server.js`, line ~4555.
- Route-level admin-only intent statement: `core/src/modules/source-intelligence/routes/source.routes.js`, file header comment.
- Service-role-only DB client: `core/src/config/supabase.js` (constructed from `SUPABASE_SERVICE_ROLE_KEY`); confirmed imported identically by all four repositories under `core/src/modules/source-intelligence/repositories/`.
- Absence of alternate access paths: full-text search of `front/src` (zero hits) and the concatenated migration set (zero `CREATE POLICY`/`GRANT`/`SECURITY DEFINER` hits beyond index/constraint/comment references) for all four table names.
- Existing project convention for service-role-only policies: `000_initial_schema.sql`, e.g. `CREATE POLICY "emp_employer_users_service_role_full_access" ON "public"."emp_employer_users" TO "service_role" USING (true) WITH CHECK (true);`.
- New migration: `core/supabase/migrations/20260710000001_wp_0002_t102_sim_sources_rls.sql` (delivered).

## 7. Risk Assessment

- **Residual risk — low:** Because the fix is scoped to a service-role-only policy and the application never uses anything but the service-role client for these tables, the risk of this specific change breaking application functionality is low, based on the exhaustive dependency search in Section 4.
- **Unverified risk — live execution:** As stated in Section 5, this migration has not been executed against any real database. There is a non-zero chance a live database's actual current state (e.g. if these tables were altered out-of-band, outside the migration history — a possibility the baseline report already flagged as Blocker #1 for the whole Work Package) differs from what the migration assumes. This must be checked before deployment: confirm via `SELECT relrowsecurity FROM pg_class WHERE relname IN ('sim_sources','sim_source_health_snapshots','sim_source_relationships','sim_source_audit_log');` that RLS is not already enabled in a conflicting way, and confirm no policy with the same name already exists (the `DROP POLICY IF EXISTS` guard handles this safely either way).
- **Unverified risk — the COM `/eligible` endpoint:** `source.routes.js` notes `router.get('/eligible', controller.listEligibleSources)` is on the same admin-guarded router "for now," with a comment that it may later move to service-to-service (`internalToken.middleware.js`) auth once a separate COM service exists. This migration does not change that plan or timeline — flagged here only so the future COM extraction work is aware the underlying tables are now service-role-only, which is compatible with either an admin-guarded or an internal-token-guarded caller (both use the backend's service-role client), but would NOT be compatible with a future design where COM calls Postgres directly with its own anon/authenticated key. This is a forward-looking note, not a defect in this implementation.
- **No risk identified requiring escalation beyond the "Not Tested" validation gap already documented in Section 5.**

## 8. WP-0002 Status Update — Task T-102 Only

**Task T-102 status: Partially Completed.**

Justification: the migration is written, evidence-backed, scoped correctly, and follows the project's established conventions — the engineering artifact itself is complete. It is rated **Partially Completed** rather than **Completed** solely because Section 5's Database/Policy/Authorization validations could not be executed in this environment (no live database access), and the task's own quality standard requires those to be run and recorded before the fix can be considered verified rather than merely implemented. **Not Blocked** — there is no unresolved repository-evidence question preventing progress; the only remaining step is execution against a real database, which is an environment/access precondition, not an open engineering question.

**Recommended next step (informational only, not a new task per the scope constraint):** run this migration against staging, execute the negative/positive authorization tests described in Section 5, and update this record's Section 5 and the status line above to Completed once done. This does not require any further repository investigation — the evidence and the migration are both already in hand.

No other WP-0002 task's status is affected or updated by this record.
