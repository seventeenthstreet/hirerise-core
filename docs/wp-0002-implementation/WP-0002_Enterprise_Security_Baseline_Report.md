# WP-0002 — Enterprise Security Baseline Report
**Row Level Security Verification & Hardening — Assessment Phase**
Repository: `hirerise.zip` | Report type: Assessment Only (no code/policy changes made)

---

## Methodology & Scope Note

This assessment was performed against the repository as delivered in `hirerise.zip`: the `core` backend (Node/Express services + workers), the `front` client, and `core/supabase` (Postgres schema, 70 migration files / ~43,000 lines in `core/supabase/migrations`, plus a `migrations_original_backup` of 70 additional files).

Given the size of the codebase (263 backend/frontend JS/TS files, 249+ distinct tables across the migration history), this assessment used **automated evidence extraction** (grep/regex/parsing over the full migration set) cross-checked with **targeted manual review** of authentication middleware, dev/internal routes, storage handling, and environment configuration — rather than a line-by-line read of every file. Where a claim is based on a pattern match rather than full manual verification, that is stated explicitly. This is a real limitation of the assessment and should be disclosed alongside the findings below, not treated as exhaustive.

---

## 1. Executive Summary

**Overall implementation maturity: Substantial, but uneven.** The large majority of the schema (≈95% of tables with a matching `ENABLE ROW LEVEL SECURITY` statement) has RLS explicitly enabled, and the backend has a real, fail-closed JWT authentication layer (`core/src/middleware/auth.middleware.js`) plus a separate, IP-allowlisted internal service token guard (`core/src/middleware/internalToken.middleware.js`) for service-to-service routes. This is not a greenfield or unimplemented security posture — there is clear evidence of deliberate RLS and authorization engineering across many migrations (e.g. `202604130005_rls_policies.sql`, `20260421000001_audit_fixes.sql`, `20260526000004_phase1a_governance_hardening.sql`).

**Overall security posture: Not yet production-ready.** The assessment found a small number of tables with **no RLS enabled at all** (some containing governance/audit data), a set of **database RPC functions granted execute access to the unauthenticated `anon` role** including subscription-activation and bulk-import functions, **27 `SECURITY DEFINER` functions without a pinned `search_path`** (a known Postgres privilege-escalation vector), and **live-looking API keys and a Supabase service-role key committed in plaintext `.env` files** that were included in the repository archive delivered for this review.

**Overall production readiness: Blocked** on closing the Critical/High items below before WP-0002 can be marked complete. None of these are architecture-level problems — they are implementation gaps within the already-approved WP-0002 scope (RLS verification & hardening) and do not require new Architecture Requirements or Work Packages.

---

## 2. Repository Security Inventory

| Component | Count / Evidence |
|---|---|
| SQL migration files (active) | 70 files, `core/supabase/migrations/` |
| SQL migration files (backup set) | 70 files, `core/supabase/migrations_original_backup/` |
| Distinct tables created across migration history | ~249 (`CREATE TABLE` statements, deduplicated by name) |
| Tables with an explicit `ENABLE ROW LEVEL SECURITY` statement | 215 |
| `CREATE POLICY` statements | 305 |
| `SECURITY DEFINER` functions | 128 |
| Total `CREATE FUNCTION` statements | 222 (210 unique names) |
| Backend JS/TS/TSX/JSX files (core + front, excl. node_modules) | 1,443 |
| Files referencing `SUPABASE_SERVICE_ROLE_KEY` / service-role client | 22 (`core/src`, `core/shared`, worker services) |
| Central JWT auth middleware | `core/src/middleware/auth.middleware.js` (521 lines) |
| Internal-service auth middleware | `core/src/middleware/internalToken.middleware.js` |
| Dev-only auth bypass route | `core/src/modules/dev/dev.controller.js` + `dev.routes.js` |
| Quarantined/dead code directories | `core/quarantine/`, `core/src/quarantine/` (orphaned services, not wired into `server.js`) |

---

## 3. RLS Assessment

### 3.1 Tables confirmed with RLS enabled
215 tables carry an explicit `ALTER TABLE "public"."<table>" ENABLE ROW LEVEL SECURITY;` statement (e.g. `profiles`, `resumes`, `job_applications`, `career_health_index`, `student_academic_records`, `emp_employer_users`, `admin_users`). Policy density varies by table; a representative sample (`emp_employer_users`, `admin_users`, `ai_cost_tracking`, `change_logs`) uses a `service_role`-only `USING (true) WITH CHECK (true)` policy plus separate owner-scoped policies for the `authenticated` role — this is a standard, acceptable Supabase pattern (service role bypasses RLS at the client level regardless, but explicit policies document intent).

### 3.2 Tables with NO RLS enabled — evidence-confirmed gap

No `ENABLE ROW LEVEL SECURITY` statement exists anywhere in the migration set for the following tables. Because Supabase's bootstrap migration grants blanket table privileges to `anon`/`authenticated` (`ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon"/"authenticated"`, `core/supabase/migrations/…` line ~16150-16153), **the absence of RLS on these tables means Postgres grants — not RLS policies — are the only access control**, and for several of them no compensating `REVOKE` was found either:

| Table | RLS Enabled | Policies Present | Grants Found | Risk |
|---|---|---|---|---|
| `sim_sources` | **No** | None found (`CREATE POLICY` search returned zero matches — only index/trigger references) | None explicit (inherits schema-level `GRANT ALL … TO anon, authenticated`) | **Critical** |
| `sim_source_health_snapshots` | **No** | None found | Inherits default grants | **Critical** |
| `sim_source_relationships` | **No** | None found | Inherits default grants | **Critical** |
| `sim_source_audit_log` | **No** | None found | Inherits default grants | **Critical** |
| `taxonomy_seed_versions` | **No** | None found | Inherits default grants | **High** |
| `academic_rpc_lifecycle` | **No** | None found | Explicit `GRANT SELECT ON public.academic_rpc_lifecycle TO authenticated` (`…phase1a_governance_hardening.sql` ~line 30964) | **High** — every authenticated user can read all rows of this governance/lifecycle table; no row filter exists |
| `academic_rpc_schema_registry` | **No** | None found | Explicit `GRANT SELECT … TO authenticated` (~line 30961) | **High**, same pattern |
| `ai_confidence_language_log` | **No** | None found | `GRANT INSERT … TO service_role` only (no anon/authenticated grant found) — inherits default grants regardless since no REVOKE was found | **Medium** |
| `signal_lineage` | **No** | None found | Migration comment explicitly states *"SECURITY DEFINER — signal_lineage has no SELECT grant for authenticated"* — **but no `REVOKE` statement was found for this table**, so the schema-level default grant to `authenticated`/`anon` still applies, contradicting the stated intent | **Critical** — documented security intent appears not to be enforced |
| `signal_registry_audit_log` | **No** | None found | Same pattern — comment claims `service_role`-only access; no `REVOKE` found | **Critical**, same reasoning |

Partitions `chi_scores_2026_04/05/06` and `chi_scores_default` also showed no direct `ENABLE ROW LEVEL SECURITY` statement, but this is **not a gap**: the parent partitioned table `chi_scores` does have RLS enabled (`ALTER TABLE "public"."chi_scores" ENABLE ROW LEVEL SECURITY;`), and Postgres partitions inherit RLS enforcement from the partitioned parent.

**Recommendation for remediation phase:** For `signal_lineage` and `signal_registry_audit_log` in particular, verify in the live database (via `pg_policies` / `pg_tables.rowsecurity`) whether RLS is actually disabled as the migration text suggests, or whether it was enabled out-of-band (e.g. via the Supabase dashboard, which would not appear in migration files). This assessment could only verify migration-file evidence, not live database state.

### 3.3 Policies flagged for intent verification (not confirmed unsafe, but public-read scope should be reconfirmed)
`CREATE POLICY … FOR SELECT USING (true)` (no role restriction) was found on: `career_opportunity_signals`, `consent_versions`, `cognitive_questions`, `cognitive_options`, and (`TO authenticated`) `signal_weight_versions`. These are SELECT-only and plausibly intentional public/authenticated reference data, but should be confirmed against WP-0002's data classification — `consent_versions` in particular may carry legal/compliance significance and its "read all" scope should be explicitly signed off rather than assumed.

---

## 4. Function Assessment

**128 `SECURITY DEFINER` functions** exist across the migration set (out of 222 total function definitions). These run with the privileges of the function owner (typically `postgres`) regardless of caller, which is the correct pattern for controlled privilege escalation (e.g. RPCs that need to bypass RLS for a specific, validated operation) — but each one is a manual trust boundary that has to be gotten right individually.

**27 of the 128 `SECURITY DEFINER` functions have no `SET search_path`** pinned in their definition, including `add_skills_to_profile`, `aggregate_daily_metrics`, `bulk_import_skills`, `check_rate_limit`, `claim_job`, `cleanup_old_search_events`, `complete_student_onboarding`, `create_cms_role`, `create_role`, `delete_role`, and 17 others. An unpinned `search_path` on a `SECURITY DEFINER` function is a documented Postgres/Supabase hardening finding (also flagged by Supabase's own database linter) because it allows a caller who can influence the session's `search_path` or create objects in a schema earlier in that path to potentially redirect the function's unqualified object references. This is a real, fixable gap, not a theoretical one — mitigation is a one-line `SET search_path = public, pg_temp` addition per function.

**86 functions are granted `EXECUTE`/`ALL` to the `anon` (unauthenticated) role**, including several that read as administrative or state-mutating by name: `activate_subscription_tx`, `approve_pending_entry_transaction` (takes a `p_admin_uid` parameter), `bulk_import_dataset`, `bulk_import_graph`, `bulk_import_skills`. For the four of these inspected in detail, an internal auth/role check pattern (`auth.uid()`, role comparison, or an explicit `RAISE EXCEPTION` guard) was found in the function body, so they are **not confirmed to be exploitable as written** — but this needs a manual, per-function review rather than reliance on the automated scan, since (a) presence of an `auth.uid()` reference doesn't guarantee it's used correctly, and (b) most of these `GRANT ALL … TO anon` statements look like blanket, auto-generated grants from a `pg_dump`/schema-sync process rather than deliberate per-function decisions — which is itself worth fixing regardless of whether each function currently self-guards correctly, since it removes a layer of defense-in-depth.

---

## 5. Authorization Assessment

**Backend authorization flow:** `core/src/middleware/auth.middleware.js` implements a single, fail-closed JWT verification path: it calls Supabase's own `auth.getUser(token)` (not local JWT decoding for trust decisions — the raw JWT is only decoded locally for cache-TTL bookkeeping), enforces a 2-second timeout, and returns `401 UNAUTHORIZED` on any failure. A small, explicit allowlist of public paths exists (`/health`, `/ready`, `/metrics`, `/webhooks*`, `/internal/*`) — `/internal/*` is separately protected by `requireInternalToken`, which fails closed (returns `503` if `INTERNAL_SERVICE_TOKEN` is unset) and applies an IP allowlist (`core/src/middleware/internalToken.middleware.js`).

**Ownership/role enforcement:** `requireRole()` and `requireEmailVerified()` middleware exist and are role/claim-based, sourced from Supabase `app_metadata`/`user_metadata`, not client-supplied data. `requireAdmin` is imported from a dedicated module (`core/src/middleware/requireAdmin.middleware.js`) — not reviewed in full detail in this pass; recommend explicit review in the next phase given its sensitivity.

**Service role usage:** 22 files reference the service-role key. Its two clearest legitimate uses are `auth.middleware.js` (to call `auth.getUser()` and to read `subscriptions.tier` as a plan-resolution fallback) and `dev.controller.js` (development-only). Each of the 22 files should be confirmed in the implementation phase to be either backend-only server code or worker code — none should be reachable from the `front/` client bundle.

**Dev-mode bypass — properly guarded:** `core/src/modules/dev/dev.controller.js` mints a Supabase session token for a hardcoded dev-admin account (`role: 'MASTER_ADMIN'`, default password `DevAdmin123!` if `DEV_ADMIN_PASSWORD` is unset) using the service-role key. This is a real risk pattern in general, but it is **defended in depth correctly**: `dev.routes.js` throws at module-load time if `NODE_ENV === 'production'`, so the route cannot be registered in production even if `server.js` accidentally requires it. No gap found here, but recommend this remains a standing item to re-verify whenever `NODE_ENV` handling changes.

**API protection / storage:** Resume storage (`core/src/modules/resume/resume.service.js`) uses `.createSignedUrl()`, not public bucket URLs, for both upload and read paths — correct pattern. This assessment did **not** find any SQL-defined storage bucket configuration (`storage.buckets` inserts) in the migrations, which means bucket creation and bucket-level RLS policies (`storage.objects` policies) are likely managed outside the SQL migration set (e.g. via Supabase dashboard or a separate script) and were **not verifiable from repository evidence**. This is a documented gap in the evidence trail, not a confirmed finding of insecurity.

---

## 6. Gap Analysis

| # | Location | Description | Impact | Risk | Recommended Action |
|---|---|---|---|---|---|
| G1 | `sim_sources`, `sim_source_health_snapshots`, `sim_source_relationships`, `sim_source_audit_log` (migration `…phase…sim_sources…sql`, ~line 42744 onward) | No `ENABLE ROW LEVEL SECURITY`, no `CREATE POLICY`, no `REVOKE` | With Supabase default grants active, any `anon`/`authenticated` API caller can read/write these tables directly via PostgREST | **Critical** | Enable RLS + add explicit policies (or `REVOKE ALL FROM anon, authenticated` if service-role-only) before go-live |
| G2 | `signal_lineage`, `signal_registry_audit_log` (`…sql` ~line 35022, 35396) | Migration comments assert "no SELECT grant for authenticated," but no RLS enable and no `REVOKE` statement exists in the migration set | Stated security intent likely not enforced at the database level | **Critical** | Verify live `pg_tables.rowsecurity` / `information_schema.role_table_grants`; add RLS + explicit `REVOKE`/policies to match documented intent |
| G3 | `academic_rpc_lifecycle`, `academic_rpc_schema_registry` (`…phase1a_governance_hardening.sql` ~line 30960-30967) | Explicit `GRANT SELECT … TO authenticated` with no RLS enabled | Every authenticated user (any tenant, any role) can read the full governance table with no row filter | **High** | Enable RLS with a role-scoped policy, or move to `service_role`-only if end users never need direct access |
| G4 | 27 `SECURITY DEFINER` functions incl. `bulk_import_skills`, `check_rate_limit`, `claim_job`, `create_role`, `delete_role` | No `SET search_path` pinned | Search-path based object-resolution hijack risk on privileged functions | **High** | Add `SET search_path = public, pg_temp` to each; this is also what Supabase's built-in linter flags |
| G5 | 86 functions with `GRANT ALL … TO anon`, incl. `activate_subscription_tx`, `bulk_import_dataset`, `bulk_import_graph`, `approve_pending_entry_transaction` | Broad, likely auto-generated `anon` execute grants on sensitive-sounding RPCs | Removes defense-in-depth; relies entirely on each function's internal guard being correct | **High** | Audit each function individually; `REVOKE EXECUTE … FROM anon` on any not genuinely meant to be public, or add a common auth-guard wrapper |
| G6 | `core/.env`, `front/.env.local` | Files present in the delivered repository archive contain live-format secrets: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GROK_API_KEY`, `RAZORPAY_KEY_SECRET`, `STRIPE_SECRET_KEY` (test-mode prefix `sk_test`), `MASTER_ENCRYPTION_KEY`, `INTERNAL_SERVICE_TOKEN`. `.gitignore` in both `core/` and `front/` correctly excludes `.env*`, so these were likely never committed to git — but they were present in the archive handed to this review. `front/.env.local` also contains the **server-only** `SUPABASE_SERVICE_ROLE_KEY`, mixed in with client-safe `NEXT_PUBLIC_*`/`VITE_*` keys in a frontend-directory env file | If these values are live, anyone with the archive has full service-role database access and provider API billing/access | **Critical** | Rotate every key listed above immediately, treat them as compromised because they left the controlled environment, and confirm `front/.env.local` server-only keys are not reachable by any client bundling step |
| G7 | `core/src/modules/dev/dev.controller.js` | Hardcoded fallback dev-admin password `DevAdmin123!`, `role: 'MASTER_ADMIN'` | Low in isolation (production-guarded at module load), but a weak default credential pattern | **Low** (mitigated) | Require `DEV_ADMIN_PASSWORD` with no fallback, to remove the hardcoded value entirely |
| G8 | `core/src/middleware/auth.middleware.js` | Verbose `console.log`/`console.error` debug output left in the auth path (e.g. `"🔥🔥🔥 VERIFY TOKEN EXECUTED 🔥🔥🔥"`, full Supabase error object dumps) | Log noise / potential incidental information disclosure in production logs; not a direct access-control gap | **Low** | Gate behind `NODE_ENV !== 'production'` or remove before the WP-0002 hardening sign-off |
| G9 | Storage bucket / `storage.objects` RLS configuration | No SQL evidence found for bucket creation or bucket-level policies anywhere in the migration set | Cannot confirm or deny storage-layer RLS posture from repository evidence alone | **Unknown — evidence gap, not a finding** | Locate and version-control storage bucket policy configuration (export from Supabase dashboard if managed there) so it is auditable in future WP-0002-style reviews |

---

## 7. ERP-01 Traceability

All items above are implementation-level findings against the already-approved WP-0002 objective ("verify and harden Row Level Security throughout the actual HireRise production codebase"). None require a new Architecture Requirement:

- G1–G3, G9 map directly to the WP-0002 "RLS status for every table / missing RLS policies" objective.
- G4–G5 map to the WP-0002 "SECURITY DEFINER functions / RPC functions / grants / privileges" objective.
- G6–G8 map to the WP-0002 "Environment / secret management" and "Backend … authentication … Service Role usage" objectives.

No governance redefinition, architecture rewrite, or new Work Package is proposed or required by this assessment.

---

## 8. Risks

- **Production risk:** G1, G2, G3 mean specific tables are readable/writable outside intended scope right now, if the current schema state matches the migration history.
- **Security risk:** G5 (broad anon grants on privileged RPCs) is a defense-in-depth failure even where individual functions currently self-guard correctly — a future refactor of any one of those 86 functions could silently remove the internal check with no database-level backstop.
- **Deployment risk:** G6 (exposed secrets) is time-sensitive — every day these credentials remain unrotated is additional exposure, independent of the RLS work.
- **Migration risk:** The presence of both `migrations/` and `migrations_original_backup/` (70 files each) means live database state could plausibly diverge from either directory; several conclusions above (especially G2) depend on migration-file evidence and should be cross-checked against the actual live schema (`pg_policies`, `pg_tables.rowsecurity`, `information_schema.role_table_grants`) before remediation work begins.

---

## 9. Blockers

1. **No live database access was available for this assessment** — all RLS/grant findings are derived from migration-file evidence, not a live `pg_policies`/`pg_tables` query. This is the single biggest blocker to full confidence in the RLS status table in Section 3, particularly G2.
2. **Storage bucket policy configuration was not found in-repository** (G9) — this must be located (dashboard export or otherwise) before storage-layer RLS can be assessed at all.
3. **Exposed secrets (G6) should be rotated before any further work proceeds** on this codebase in shared or reviewed contexts, independent of the RLS remediation timeline.

---

## 10. Completion Status

**Recommendation: Blocked.**

The assessment phase itself (this report) is complete. However, WP-0002's underlying objective — a verified, hardened RLS posture — is **not** ready to be marked complete or handed to implementation with a clean bill of health, because:
- Critical-risk gaps (G1, G2, G6) are evidence-confirmed from repository artifacts, not hypothetical.
- Two blockers (live database confirmation, storage policy location) must be resolved before the remaining scope can even be verified, separate from fixing the items already found.

Once G6 is remediated (secret rotation) and live-database confirmation is obtained for G1–G3, this Work Package can move to **Ready for Implementation** for the remaining hardening items (G4, G5, G7, G8) with a scoped, evidence-based fix list already in hand from Section 6.
