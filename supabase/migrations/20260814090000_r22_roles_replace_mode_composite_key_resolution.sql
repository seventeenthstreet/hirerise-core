-- =============================================================================
-- WP-ADMIN-COMP-08-R22 — Roles CSV Replace Semantics & Composite-Key
-- Conflict Resolution
-- =============================================================================
-- File: supabase/migrations/20260814090000_r22_roles_replace_mode_composite_key_resolution.sql
-- Sequence position: after the latest migration in this repository snapshot,
-- 20260813150000_r14_bulk_import_graph_hardening.sql — confirmed by a full
-- directory listing of supabase/migrations/ (no migration with a later
-- timestamp exists in this snapshot). Forward-only: this file does not edit
-- any prior migration.
--
-- ---------------------------------------------------------------------------
-- Root cause (see graphImport.service.js / importGraphDataset before this WP)
-- ---------------------------------------------------------------------------
-- The Graph Admin Roles CSV importer accepted a `mode` of 'append' or
-- 'replace' end-to-end (UI -> route -> controller -> service), but the write
-- path never branched on it: both modes reached the exact same
--   supabase.from('roles').upsert(clean)
-- call, with no `onConflict` target. public.roles has no PRIMARY KEY (see
-- 000_initial_schema.sql — only unique indexes: idx_roles_role_id_unique,
-- uq_roles_composite_key, idx_roles_normalized_name_unique,
-- idx_roles_normalized_name_agency, idx_roles_unique_name_agency), so
-- PostgREST cannot infer a default conflict target and the call degrades to
-- a plain INSERT. Any importable row whose computed `composite_key` already
-- matches an ACTIVE (soft_deleted = false) row therefore raises:
--   duplicate key value violates unique constraint "uq_roles_composite_key"
-- exactly as reported in the live evidence. "Replace" was, in practice,
-- byte-for-byte identical to "Append" — never a distinct code path, and
-- never something that reconciled conflicting active rows first.
--
-- ---------------------------------------------------------------------------
-- Established repository precedent
-- ---------------------------------------------------------------------------
-- public.bulk_import_graph's 'roles' branch (000_initial_schema.sql,
-- unmodified by R14) already treats role_id as the roles identity for
-- conflict resolution: `ON CONFLICT (role_id) DO UPDATE`. That RPC is not
-- actually wired into the Graph Admin CSV pipeline (graphImport.service.js
-- calls supabase.from('roles').upsert(...) directly — bulk-import-validator.js
-- / bulk_import_graph is a separate, unused-by-this-pipeline utility), but it
-- establishes the intended identity semantics for `roles.role_id` in this
-- codebase, which this migration reuses rather than inventing a new rule.
--
-- ---------------------------------------------------------------------------
-- Replace contract implemented here
-- ---------------------------------------------------------------------------
-- Scope: ONLY the rows present in the uploaded CSV (the "defined import
-- scope") are reconciled. This is NOT "DELETE FROM public.roles" and NOT
-- "soft-delete every active role" — the rest of the active legacy `roles`
-- dataset is left untouched, per WP-ADMIN-COMP-08-R22 Critical Safety Rule
-- #3.
--
-- Identity: an incoming row is matched against existing data by, in order:
--   1. role_id            — exact identity match -> UPDATE that row in
--                            place (preserves role_id, so every dependent
--                            legacy table's FK-shaped reference to it
--                            — role_skills, role_transitions, role_education,
--                            role_salary_market, role_market_demand — is left
--                            pointing at a live, unchanged role_id).
--   2. composite_key       — lower(trim(role_name)) || '::' ||
--                            coalesce(role_family, ''), the exact formula of
--                            the GENERATED column (000_initial_schema.sql).
--   3. normalized_name     — the exact value graphImport.service.js already
--                            computed via normalizeText() and is sending as
--                            part of the row (single source of truth — this
--                            function does not re-derive it, so preview,
--                            validation, and write all agree on the same
--                            identity representation per R22 §8.3/8.4).
--   4. (lower(role_name), agency) — the fourth active-uniqueness dimension
--                            (idx_roles_unique_name_agency). Not part of the
--                            CSV contract's fields (agency defaults to ''
--                            for every CSV-imported row per the column
--                            default), included for completeness so Replace
--                            cannot still fail on this constraint after
--                            uq_roles_composite_key is resolved.
--   idx_roles_normalized_name_agency is not checked separately: it is a
--   strict subset of the normalized_name-alone constraint above (any pair of
--   active rows sharing normalized_name already violates the stronger,
--   agency-independent index first).
--
-- Conflict handling: for each incoming row, any ACTIVE row that matches one
-- of the identity dimensions above under a DIFFERENT role_id is SOFT-DELETED
-- (soft_deleted = true, updated_at = now()) — never hard-deleted — which is
-- exactly what frees the four partial unique indexes (all filtered
-- WHERE soft_deleted = false). The incoming row is then written via
-- INSERT ... ON CONFLICT (role_id) DO UPDATE, matching the same role_id
-- semantics already established by bulk_import_graph's roles branch.
--
-- Dependent data: because conflicting rows are soft-deleted rather than
-- deleted, every existing role_id referenced by role_skills,
-- role_transitions, role_education, role_salary_market, and
-- role_market_demand keeps resolving to a real (now-inactive) roles row.
-- No dependent row is rewritten, deleted, or re-pointed by this migration or
-- by the function it creates. Pre-existing orphan counts documented in R22
-- §5 (117/120/75/83) are untouched by this change — this migration does not
-- claim to fix them (see R22 §10 Step 5 / §11.E).
--
-- Transaction semantics: a PL/pgSQL function body executes as a single
-- statement from the caller's perspective — any unhandled exception raised
-- during the loop aborts and rolls back every soft-delete and every
-- insert/update this call has made so far. No explicit BEGIN/EXCEPTION
-- block is used inside the loop, so nothing here can partially commit.
-- (graphImport.service.js still chunks large files into BATCH_SIZE-row
-- calls — that pre-existing chunking boundary, shared by every dataset and
-- both modes, is unchanged by this migration; see the R22 report for the
-- explicit scope note on cross-chunk atomicity.)
--
-- Canonical Career Graph: this migration touches ONLY public.roles. It does
-- not read, write, or reference career_roles, career_skills_registry,
-- career_role_transitions, career_role_skills, or the graph_metrics view.
-- No uniqueness constraint on public.roles is dropped, altered, or weakened.
-- =============================================================================

CREATE OR REPLACE FUNCTION "public"."replace_import_roles"("p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_total      BIGINT := 0;
    v_inserted   BIGINT := 0;
    v_updated    BIGINT := 0;
    v_replaced   BIGINT := 0;
    rec          JSONB;
    v_role_id            TEXT;
    v_role_name          TEXT;
    v_role_family        TEXT;
    v_normalized_name    TEXT;
    v_agency             TEXT;
    v_composite_key      TEXT;
    v_existing_by_id     BOOLEAN;
    v_conflict_count     BIGINT;
BEGIN
    IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
        RETURN jsonb_build_object('inserted', 0, 'updated', 0, 'replaced', 0, 'total', 0);
    END IF;

    IF jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'replace_import_roles: p_rows must be a JSON array, got %', jsonb_typeof(p_rows);
    END IF;

    v_total := jsonb_array_length(p_rows);

    -- Explicit column alias (mirrors the exact working pattern already used
    -- by bulk_import_graph's roles branch: "FROM jsonb_array_elements(p_rows)
    -- AS rec", then rec->>'field' — 000_initial_schema.sql). Without an
    -- alias, a bare setof-jsonb function in FROM has no column named
    -- "value" to select.
    FOR rec IN SELECT elem FROM jsonb_array_elements(p_rows) AS elem
    LOOP
        v_role_id         := rec->>'role_id';
        v_role_name       := rec->>'role_name';
        v_role_family     := rec->>'role_family';
        v_normalized_name := rec->>'normalized_name';
        v_agency          := COALESCE(rec->>'agency', '');

        IF v_role_id IS NULL OR v_role_name IS NULL OR v_normalized_name IS NULL THEN
            RAISE EXCEPTION
                'replace_import_roles: row missing required field(s) (role_id=%, role_name=%, normalized_name=%)',
                v_role_id, v_role_name, v_normalized_name;
        END IF;

        -- Exact formula of roles.composite_key (GENERATED ALWAYS AS ...
        -- STORED, 000_initial_schema.sql) so the conflict check matches
        -- precisely what the database itself will compute on write.
        v_composite_key := lower(trim(v_role_name)) || '::' || COALESCE(v_role_family, '');

        -- --------------------------------------------------------------
        -- Step 1: reconcile any ACTIVE row that collides with this
        -- incoming row's identity under a DIFFERENT role_id, on any of
        -- the three active-uniqueness dimensions (composite_key,
        -- normalized_name, (lower(role_name), agency)). Soft-delete only
        -- — never a hard delete — so dependent legacy rows keep a live
        -- role_id to reference.
        -- --------------------------------------------------------------
        WITH conflicting AS (
            UPDATE "public"."roles" r
            SET soft_deleted = TRUE,
                updated_at = now()
            WHERE r.soft_deleted = FALSE
              AND r.role_id IS DISTINCT FROM v_role_id
              AND (
                    r.composite_key = v_composite_key
                 OR r.normalized_name = v_normalized_name
                 OR (lower(r.role_name) = lower(v_role_name) AND COALESCE(r.agency, '') = v_agency)
              )
            RETURNING 1
        )
        SELECT count(*) INTO v_conflict_count FROM conflicting;

        v_replaced := v_replaced + v_conflict_count;

        -- --------------------------------------------------------------
        -- Step 2: identity match by role_id -> UPDATE in place (preserves
        -- role_id and every dependent FK-shaped reference to it).
        -- Otherwise -> INSERT the new role.
        -- --------------------------------------------------------------
        SELECT EXISTS(SELECT 1 FROM "public"."roles" WHERE role_id = v_role_id)
        INTO v_existing_by_id;

        -- `agency` is intentionally NOT part of this INSERT's column list:
        -- it is not in the Roles CSV contract (SCHEMAS.roles in
        -- graphImport.service.js — required: role_id, role_name; optional:
        -- role_family, seniority_level, description), so a CSV-sourced row
        -- never carries a value for it. Omitting it lets a fresh INSERT
        -- fall back to the column's own DEFAULT '' (matching what the
        -- pre-R22 plain upsert() would have produced for a brand-new row),
        -- and leaves an existing row's `agency` value completely untouched
        -- on UPDATE — this function must not silently blank out a field the
        -- CSV import was never authoritative for.
        INSERT INTO "public"."roles" (
            role_id,
            role_name,
            normalized_name,
            role_family,
            seniority_level,
            description,
            soft_deleted,
            updated_at
        )
        VALUES (
            v_role_id,
            v_role_name,
            v_normalized_name,
            v_role_family,
            rec->>'seniority_level',
            rec->>'description',
            FALSE,
            now()
        )
        ON CONFLICT (role_id) DO UPDATE
            SET role_name       = EXCLUDED.role_name,
                normalized_name = EXCLUDED.normalized_name,
                role_family     = EXCLUDED.role_family,
                seniority_level = EXCLUDED.seniority_level,
                description     = EXCLUDED.description,
                soft_deleted    = FALSE,
                updated_at      = now();

        IF v_existing_by_id THEN
            v_updated := v_updated + 1;
        ELSE
            v_inserted := v_inserted + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'inserted', v_inserted,
        'updated', v_updated,
        'replaced', v_replaced,
        'total', v_total
    );
END;
$$;

ALTER FUNCTION "public"."replace_import_roles"("p_rows" "jsonb") OWNER TO "postgres";

-- Least privilege: this function is only ever called from
-- graphImport.service.js using the backend's Supabase service-role client
-- (src/config/supabase.js — SUPABASE_SERVICE_ROLE_KEY). Unlike
-- bulk_import_graph (granted to anon/authenticated/service_role in
-- 000_initial_schema.sql for reasons outside R22's scope — see R14's grant
-- note), this new function soft-deletes existing admin-managed rows and has
-- no reason to be reachable by anon/authenticated Postgres roles, so only
-- service_role is granted.
REVOKE ALL ON FUNCTION "public"."replace_import_roles"("p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_import_roles"("p_rows" "jsonb") TO "service_role";
