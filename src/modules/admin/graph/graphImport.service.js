'use strict';

/**
 * graphImport.service.js
 * Final Production Supabase Import Pipeline
 */

const getSupabase = () => require('../../../config/supabase').supabase;
const { parseCSVBuffer } = require('../import/csvParser.util');
const logger = require('../../../utils/logger');
const { GRAPH_DATASET_TYPES } = require('./graph.constants');
const { normalizeText } = require('../../../shared/utils/normalizeText');

const BATCH_SIZE = 400;

const SCHEMAS = {
  roles: {
    required: ['role_id', 'role_name'],
    optional: ['role_family', 'seniority_level', 'description'],
    collection: 'roles',
    // WP-ADMIN-COMP-08-R18: normalized_name is NOT part of the CSV
    // contract (not required, not optional/pass-through) — it is a
    // NOT NULL, non-derived DB column that this service computes from
    // role_name via applyComputedFields() rather than accepting from
    // the file. See applyComputedFields() for the rationale.
  },
  skills: {
    // old_id is required: public.skills.old_id is `text NOT NULL` with no
    // default (000_initial_schema.sql, unmodified since — DCC-04 Phase 4
    // certification). It is not derived from skill_id or id anywhere in the
    // codebase. The only other place in the repository that defines a
    // contract for this column — the `bulk_import_graph` RPC function and
    // its caller `bulk-import-validator.js` (REQUIRED_FIELDS.skills =
    // ['skill_id', 'old_id']) — treats it as a caller-supplied source
    // identifier with no derivation logic. This mirrors that established
    // contract rather than inventing a new one.
    required: ['skill_id', 'skill_name', 'old_id'],
    optional: ['skill_category', 'difficulty_level', 'demand_score'],
    collection: 'skills',
  },
  role_skills: {
    required: ['role_id', 'skill_id'],
    optional: ['importance_weight'],
    collection: 'role_skills',
    fkChecks: [
      { field: 'role_id', collection: 'roles', column: 'role_id' },
      // WP-ADMIN-COMP-08-R17: Legacy skill identities are validated
      // against public.career_skills_registry.skill_id — public.skills
      // does not exist in the live database (R16D). See R16D-M2.
      { field: 'skill_id', collection: 'career_skills_registry', column: 'skill_id' },
    ],
  },
  role_transitions: {
    required: ['from_role_id', 'to_role_id'],
    optional: ['probability', 'years_required'],
    collection: 'role_transitions',
    fkChecks: [
      { field: 'from_role_id', collection: 'roles', column: 'role_id' },
      { field: 'to_role_id', collection: 'roles', column: 'role_id' },
    ],
  },
  skill_relationships: {
    required: ['skill_id', 'related_skill_id', 'relationship_type'],
    optional: ['strength_score'],
    collection: 'skill_relationships',
    fkChecks: [
      // WP-ADMIN-COMP-08-R17: same skill-authority repoint as role_skills
      // above — see R16D.
      { field: 'skill_id', collection: 'career_skills_registry', column: 'skill_id' },
      { field: 'related_skill_id', collection: 'career_skills_registry', column: 'skill_id' },
    ],
  },
  role_education: {
    required: ['role_id', 'education_level'],
    collection: 'role_education',
    fkChecks: [{ field: 'role_id', collection: 'roles', column: 'role_id' }],
  },
  role_salary_market: {
    required: ['role_id', 'country'],
    collection: 'role_salary_market',
    fkChecks: [{ field: 'role_id', collection: 'roles', column: 'role_id' }],
  },
  role_market_demand: {
    required: ['role_id', 'country'],
    collection: 'role_market_demand',
    fkChecks: [{ field: 'role_id', collection: 'roles', column: 'role_id' }],
  },
};

function castRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

// WP-ADMIN-COMP-08-R18: public.roles.normalized_name is `text NOT NULL`
// with no default and no DB-side generation — no trigger or generated
// column populates it (000_initial_schema.sql; only `composite_key` is a
// generated column on `roles`). The Graph Administration Roles CSV
// contract does not ask callers to supply it, and preview accepted rows
// on that basis, so the write path silently produced NULL. It is
// deterministically derivable from `role_name`, so it is derived exactly
// once here — reusing the same canonical normalization already
// established for role identity elsewhere in the repository
// (normalizeText(), used by adminCmsRoles.repository.js for the
// analogous cms_roles.normalized_name column) — rather than introducing
// a second, divergent normalization rule. Applied to every valid `roles`
// row (never a raw CSV-supplied `normalized_name`), so preview and the
// write payload are always built from the identical value.
function applyComputedFields(rows, datasetType) {
  if (datasetType !== 'roles') return rows;

  return rows.map((row) => ({
    ...row,
    normalized_name: normalizeText(String(row.role_name)),
  }));
}

function validateRowFields(row, schema, rowIndex) {
  const errors = [];

  for (const field of schema.required) {
    if (
      row[field] === undefined ||
      row[field] === null ||
      String(row[field]).trim() === ''
    ) {
      errors.push({
        row: rowIndex,
        field,
        type: 'field',
        message: `Required field "${field}" missing`,
      });
    }
  }

  return errors;
}

function buildDocId(row, datasetType) {
  switch (datasetType) {
    case 'roles':
      return row.role_id;
    case 'skills':
      return row.skill_id;
    case 'role_skills':
      return `${row.role_id}__${row.skill_id}`;
    case 'role_transitions':
      return `${row.from_role_id}__${row.to_role_id}`;
    case 'skill_relationships':
      return `${row.skill_id}__${row.related_skill_id}`;
    case 'role_education':
      return `${row.role_id}__${row.education_level}`;
    case 'role_salary_market':
      return `${row.role_id}__${row.country}`;
    case 'role_market_demand':
      return `${row.role_id}__${row.country}`;
    default:
      return null;
  }
}

function detectFileDuplicates(rows, datasetType) {
  const seen = new Map();
  const dupes = [];

  for (const row of rows) {
    const docId = buildDocId(row, datasetType);
    if (!docId) continue;

    if (seen.has(docId)) {
      dupes.push({
        row: row.__rowNum,
        field: 'id',
        type: 'duplicate',
        message: `Duplicate ID "${docId}"`,
      });
    } else {
      seen.set(docId, row.__rowNum);
    }
  }

  return dupes;
}

// WP-ADMIN-COMP-08-R17: sentinel distinguishing "the query ran and matched
// nothing" (a real empty Set — LOOKUP_SUCCESS with zero values) from "the
// query itself could not be run" (LOOKUP_FAILURE). Previously both cases
// collapsed to an empty Set, which made a database/query failure
// indistinguishable from a successful lookup that legitimately found no
// matching rows — and, downstream, caused every candidate ID to be reported
// as an ordinary FK violation whenever the authority was merely unreachable.
const FK_LOOKUP_FAILED = Symbol('FK_LOOKUP_FAILED');

// 🚀 Optimized FK lookup
//
// NOTE: sets are keyed by "field:collection", not just "collection". Some
// schemas (role_transitions, skill_relationships) declare two fkChecks
// against the *same* collection via different fields (e.g. from_role_id and
// to_role_id both check `roles`). Keying by collection alone would let the
// second lookup silently overwrite the first, producing false FK-violation
// positives/negatives.
async function buildFKSets(rows, fkChecks) {
  if (!fkChecks?.length) return {};

  const supabase = getSupabase();
  const sets = {};

  for (const { field, collection, column } of fkChecks) {
    const setKey = `${field}:${collection}`;
    const values = [...new Set(rows.map((r) => r[field]).filter(Boolean))];

    if (!values.length) {
      // No candidate values to check — a genuine LOOKUP_SUCCESS with an
      // empty identity set; the query never needed to run.
      sets[setKey] = new Set();
      continue;
    }

    const { data, error } = await supabase
      .from(collection)
      .select(column)
      .in(column, values);

    if (error) {
      // LOOKUP_FAILURE — the validation authority could not be queried.
      // Do NOT represent this as an empty Set; that would be silently
      // indistinguishable from a successful empty lookup.
      logger.warn('[GraphImport] FK lookup failed', {
        collection,
        field,
        column,
        error: error.message,
      });
      sets[setKey] = FK_LOOKUP_FAILED;
      continue;
    }

    // LOOKUP_SUCCESS — possibly with zero matching rows, which is fine.
    sets[setKey] = new Set(data.map((r) => String(r[column])));
  }

  return sets;
}

function detectFKErrors(rows, schema, fkSets) {
  const errors = [];

  for (const row of rows) {
    for (const { field, collection } of schema.fkChecks || []) {
      const val = row[field];
      if (!val) continue;

      const setKey = `${field}:${collection}`;
      const set = fkSets[setKey];

      if (set === FK_LOOKUP_FAILED) {
        // Lookup failure surfaces as its own error type — never as an
        // ordinary 'fk' violation, and never silently dropped.
        errors.push({
          row: row.__rowNum,
          field,
          type: 'fk_lookup_failed',
          message: `Cannot validate "${field}": validation authority "${collection}" was unavailable`,
        });
        continue;
      }

      if (set && !set.has(String(val))) {
        errors.push({
          row: row.__rowNum,
          field,
          type: 'fk',
          message: `FK violation: "${val}" not found in ${collection}`,
        });
      }
    }
  }

  return errors;
}

// Same FK-orphan detection as detectFKErrors, but for rows already persisted
// in the database (identified by `id`, not an import-time `__rowNum`).
function detectFKOrphans(rows, schema, fkSets) {
  const orphans = [];

  for (const row of rows) {
    for (const { field, collection } of schema.fkChecks || []) {
      const val = row[field];
      if (!val) continue;

      const setKey = `${field}:${collection}`;
      const set = fkSets[setKey];

      // A failed lookup is not proof the row is orphaned — it's reported
      // separately via collectLookupFailures(), not folded into orphans.
      if (set === FK_LOOKUP_FAILED) continue;

      if (set && !set.has(String(val))) {
        orphans.push({
          id: row.id ?? null,
          field,
          value: val,
          missingFrom: collection,
        });
      }
    }
  }

  return orphans;
}

// Reports which of a schema's fkChecks could not be validated this run
// because their lookup failed (FK_LOOKUP_FAILED), so callers can surface
// that distinctly from "no orphans found".
function collectLookupFailures(schema, fkSets) {
  const failures = [];

  for (const { field, collection } of schema.fkChecks || []) {
    if (fkSets[`${field}:${collection}`] === FK_LOOKUP_FAILED) {
      failures.push({ field, collection });
    }
  }

  return failures;
}

async function logImportEvent(entry) {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('import_logs').insert({
      entity_type: entry.datasetType,
      dataset_name: entry.datasetType,
      admin_user_id: entry.adminId ?? null,
      rows_processed: entry.processed ?? 0,
      rows_imported: entry.imported ?? 0,
      rows_skipped: entry.skipped ?? 0,
      rows_failed:
        (entry.fkErrors ?? 0) +
        (entry.duplicateErrors ?? 0) +
        (entry.writeErrors ?? 0),
      duplicate_errors: entry.duplicateErrors ?? 0,
      fk_errors: entry.fkErrors ?? 0,
      import_mode: entry.mode ?? 'append',
      duration_ms: entry.durationMs ?? null,
      row_results: entry.rowResults ?? [],
    });

    if (error) {
      logger.warn('[GraphImport] Failed to write import log', {
        datasetType: entry.datasetType,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn('[GraphImport] Import log insert failed', {
      datasetType: entry.datasetType,
      error: err.message,
    });
  }
}

async function importGraphDataset({
  buffer,
  datasetType,
  adminId,
  preview = false,
  mode = 'append',
}) {
  if (!GRAPH_DATASET_TYPES.includes(datasetType)) {
    throw new Error(`Unsupported dataset: ${datasetType}`);
  }

  const schema = SCHEMAS[datasetType];
  const rawRows = parseCSVBuffer(buffer);

  const castedRows = rawRows.map((r, i) => ({
    ...castRow(r),
    __rowNum: i + 2,
  }));

  const fieldErrors = castedRows.flatMap((row) =>
    validateRowFields(row, schema, row.__rowNum)
  );

  const fieldInvalid = new Set(fieldErrors.map((e) => e.row));
  const validRows = applyComputedFields(
    castedRows.filter((r) => !fieldInvalid.has(r.__rowNum)),
    datasetType
  );

  const duplicateErrors = detectFileDuplicates(validRows, datasetType);
  const dupInvalid = new Set(duplicateErrors.map((e) => e.row));

  const dedupedRows = validRows.filter((r) => !dupInvalid.has(r.__rowNum));

  const fkSets = await buildFKSets(dedupedRows, schema.fkChecks);
  const fkErrors = detectFKErrors(dedupedRows, schema, fkSets);

  const fkInvalid = new Set(fkErrors.map((e) => e.row));

  const importableRows = dedupedRows.filter(
    (r) => !fkInvalid.has(r.__rowNum)
  );

  if (preview) {
    return {
      datasetType,
      processed: rawRows.length,
      importable: importableRows.length,
      fieldErrors,
      duplicateErrors,
      fkErrors,
      errorCount:
        fieldErrors.length +
        duplicateErrors.length +
        fkErrors.length,
      preview: importableRows.slice(0, 10),
    };
  }

  const supabase = getSupabase();
  let imported = 0;
  const writeErrors = [];

  for (let i = 0; i < importableRows.length; i += BATCH_SIZE) {
    const chunk = importableRows.slice(i, i + BATCH_SIZE);

    const clean = chunk.map(({ __rowNum, ...r }) => r);

    const { error } = await supabase
      .from(schema.collection)
      .upsert(clean);

    if (error) {
      writeErrors.push({
        row: 0,
        type: 'write',
        message: error.message,
      });
    } else {
      imported += clean.length;
    }
  }

  const result = {
    datasetType,
    processed: rawRows.length,
    imported,
    importable: importableRows.length,
    skipped: rawRows.length - importableRows.length,
    fieldErrors,
    duplicateErrors,
    fkErrors,
    writeErrors,
    errorCount:
      fieldErrors.length +
      duplicateErrors.length +
      fkErrors.length +
      writeErrors.length,
    importedAt: new Date().toISOString(),
    mode,
    adminId,
  };

  await logImportEvent({
    datasetType,
    adminId,
    processed: result.processed,
    imported: result.imported,
    skipped: result.skipped,
    duplicateErrors: duplicateErrors.length,
    fkErrors: fkErrors.length,
    writeErrors: writeErrors.length,
    mode,
    rowResults: [...fieldErrors, ...duplicateErrors, ...fkErrors, ...writeErrors].slice(0, 200),
  });

  return result;
}

// ─────────────────────────────────────────────────────────────
// Analytics / Admin read functions
// ─────────────────────────────────────────────────────────────

const EMPTY_METRICS = {
  total_roles: 0,
  total_skills: 0,
  total_role_transitions: 0,
  total_skill_relationships: 0,
  total_role_skills: 0,
};

// Backed by the `graph_metrics` DB view (see 000_initial_schema.sql), which
// already aggregates counts across the graph tables.
async function getGraphMetrics() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('graph_metrics')
    .select('*')
    .maybeSingle();

  if (error) {
    logger.warn('[GraphImport] getGraphMetrics failed', {
      error: error.message,
    });
    return { ...EMPTY_METRICS };
  }

  return data || { ...EMPTY_METRICS };
}

// Walks every dataset that declares fkChecks and reports rows whose foreign
// keys no longer resolve (e.g. a role_skills row pointing at a deleted role).
async function validateGraphIntegrity() {
  const supabase = getSupabase();
  const issues = [];
  const lookupFailures = [];
  let rowsChecked = 0;
  let orphanCount = 0;

  for (const [datasetType, schema] of Object.entries(SCHEMAS)) {
    if (!schema.fkChecks?.length) continue;

    const { data: rows, error } = await supabase
      .from(schema.collection)
      .select('*')
      .limit(20000);

    if (error) {
      logger.warn('[GraphImport] validateGraphIntegrity fetch failed', {
        collection: schema.collection,
        error: error.message,
      });
      continue;
    }

    rowsChecked += rows.length;

    const fkSets = await buildFKSets(rows, schema.fkChecks);
    const orphans = detectFKOrphans(rows, schema, fkSets);
    const failures = collectLookupFailures(schema, fkSets);

    if (failures.length) {
      // A failed lookup is surfaced on its own — it is never treated as
      // proof that the dataset's candidate IDs are invalid.
      lookupFailures.push({
        dataset: datasetType,
        collection: schema.collection,
        failures,
      });
    }

    if (orphans.length) {
      orphanCount += orphans.length;
      issues.push({
        dataset: datasetType,
        collection: schema.collection,
        orphan_count: orphans.length,
        sample: orphans.slice(0, 10),
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    rowsChecked,
    orphanCount,
    valid: orphanCount === 0,
    lookupFailures,
    issues,
  };
}

// Returns recent rows from the shared `import_logs` table, scoped to graph
// dataset types only (the table is also written to by other import
// pipelines, e.g. salary).
async function getImportLogs({ limit = 50 } = {}) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('import_logs')
    .select('*')
    .in('entity_type', GRAPH_DATASET_TYPES)
    .order('imported_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.warn('[GraphImport] getImportLogs failed', {
      error: error.message,
    });
    return [];
  }

  return data || [];
}

// Per-dataset row counts plus the most recent import event for each.
async function getDatasetStatuses() {
  const supabase = getSupabase();

  const recentLogs = await getImportLogs({ limit: 200 });
  const latestByType = new Map();

  for (const log of recentLogs) {
    const type = log.entity_type ?? log.dataset_name;
    if (type && !latestByType.has(type)) {
      latestByType.set(type, log);
    }
  }

  const statuses = await Promise.all(
    GRAPH_DATASET_TYPES.map(async (datasetType) => {
      const schema = SCHEMAS[datasetType];
      const { count, error } = await supabase
        .from(schema.collection)
        .select('*', { count: 'exact', head: true });

      if (error) {
        logger.warn('[GraphImport] getDatasetStatuses count failed', {
          datasetType,
          error: error.message,
        });
      }

      const lastImport = latestByType.get(datasetType) || null;

      return {
        datasetType,
        collection: schema.collection,
        rowCount: error ? null : count ?? 0,
        lastImportedAt: lastImport?.imported_at ?? null,
        lastImportMode: lastImport?.import_mode ?? null,
        lastAdminUserId: lastImport?.admin_user_id ?? null,
        lastRowsImported: lastImport?.rows_imported ?? null,
        lastRowsFailed: lastImport?.rows_failed ?? null,
      };
    })
  );

  return statuses;
}

// Rolls Career Graph metrics + Legacy Bulk Graph integrity into a single
// overall status for a dashboard.
//
// WP-ADMIN-COMP-08-R21: previously this function's `critical` condition
// looked ONLY at Career Graph counts (metrics.total_roles/total_skills).
// Because the Career Graph is populated and stable, a serious failure on
// the Legacy Bulk Graph side could never surface as `critical` here — and,
// worse, a Legacy validation *lookup failure* (the FK authority itself
// being unreachable — see FK_LOOKUP_FAILED above) wasn't looked at by this
// function at all. A lookup failure does not add to `integrity.orphanCount`
// (an unreachable authority is not proof of an orphan — see
// detectFKOrphans()), so `integrity.valid` can still read `true` even while
// validation could not actually run. That combination meant a fully broken
// Legacy validation path could silently report `healthy`.
//
// This keeps the two domains as separate signals and combines them without
// letting either one mask the other:
//   - Career Graph unavailable (authority empty)      → critical
//   - Legacy validation authority unreachable          → critical
//   - Legacy integrity issues (ordinary orphan rows)   → degraded
//   - otherwise                                        → healthy
async function getGraphHealth() {
  const [metrics, integrity] = await Promise.all([
    getGraphMetrics(),
    validateGraphIntegrity(),
  ]);

  // Career Graph domain: the canonical authority itself must have data.
  const careerGraphUnavailable =
    metrics.total_roles === 0 || metrics.total_skills === 0;

  // Legacy Bulk Graph domain: the validation authority could not be
  // queried at all for at least one FK check. This is a genuinely severe
  // monitored failure, distinct from "orphans were found".
  const legacyValidationAuthorityUnavailable = integrity.lookupFailures.length > 0;

  // Legacy Bulk Graph domain: ordinary historical orphan/FK issues. Do not
  // by themselves escalate to critical (see WP-ADMIN-COMP-08-R21 §1.3/1.4 —
  // a Legacy/Career count difference or known Legacy orphan rows are not,
  // by themselves, a defect).
  const legacyIntegrityDegraded = !integrity.valid;

  let status = 'healthy';
  if (careerGraphUnavailable || legacyValidationAuthorityUnavailable) {
    status = 'critical';
  } else if (legacyIntegrityDegraded) {
    status = 'degraded';
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    metrics,
    integrity: {
      valid: integrity.valid,
      orphanCount: integrity.orphanCount,
      rowsChecked: integrity.rowsChecked,
      // Additive field — existing consumers reading valid/orphanCount/
      // rowsChecked are unaffected.
      lookupFailures: integrity.lookupFailures.length,
    },
    // Additive field: per-domain component status, so the cross-domain
    // combination above stays maintainable/inspectable without breaking
    // existing consumers of `status`/`metrics`/`integrity`.
    components: {
      careerGraph: careerGraphUnavailable ? 'critical' : 'healthy',
      legacyBulkGraph: legacyValidationAuthorityUnavailable
        ? 'critical'
        : legacyIntegrityDegraded
        ? 'degraded'
        : 'healthy',
    },
  };
}

// Concrete, actionable alerts derived from integrity issues and recent
// failed import rows. Kept intentionally simple: no invented alert types
// beyond what the underlying data actually supports.
async function getGraphAlerts() {
  const alerts = [];

  const integrity = await validateGraphIntegrity();

  for (const failure of integrity.lookupFailures) {
    alerts.push({
      severity: 'critical',
      type: 'validation_authority_unavailable',
      dataset: failure.dataset,
      message: `Could not validate ${failure.failures.map((f) => f.field).join(', ')} in "${failure.collection}" — the validation authority (${failure.failures.map((f) => f.collection).join(', ')}) was unavailable`,
      detectedAt: integrity.checkedAt,
    });
  }

  for (const issue of integrity.issues) {
    alerts.push({
      severity: issue.orphan_count > 50 ? 'critical' : 'warning',
      type: 'orphaned_fk',
      dataset: issue.dataset,
      message: `${issue.orphan_count} row(s) in "${issue.collection}" reference a missing record`,
      detectedAt: integrity.checkedAt,
    });
  }

  const recentLogs = await getImportLogs({ limit: 20 });
  for (const log of recentLogs) {
    if ((log.rows_failed ?? 0) > 0) {
      alerts.push({
        severity: 'warning',
        type: 'import_failures',
        dataset: log.entity_type ?? log.dataset_name,
        message: `Import on ${log.imported_at} had ${log.rows_failed} failed row(s)`,
        detectedAt: log.imported_at,
      });
    }
  }

  return alerts;
}

// WP-ADMIN-COMP-08-R21: renamed from getCareerGraphStats(). This function
// queries `public.roles` and `public.role_transitions` — the Legacy Bulk
// Graph/import tables (see WP-ADMIN-COMP-08-R21 §1.3), NOT
// career_roles/career_role_transitions. The previous name implied Career
// Graph authority for data that is actually Legacy Bulk Graph connectivity.
// No behavior changed — same tables, same computation — only the name now
// accurately describes the domain being queried.
async function getLegacyBulkGraphStats() {
  const supabase = getSupabase();

  const [{ data: roles, error: rolesError }, { data: transitions, error: transitionsError }] =
    await Promise.all([
      supabase.from('roles').select('role_id'),
      supabase.from('role_transitions').select('from_role_id, to_role_id'),
    ]);

  if (rolesError || transitionsError) {
    logger.warn('[GraphImport] getLegacyBulkGraphStats fetch failed', {
      error: (rolesError || transitionsError).message,
    });
    return {
      totalRoles: 0,
      totalTransitions: 0,
      avgTransitionsPerRole: 0,
      isolatedRoleCount: 0,
      topConnectedRoles: [],
    };
  }

  const connectionCount = new Map();
  for (const role of roles) connectionCount.set(role.role_id, 0);

  for (const t of transitions) {
    connectionCount.set(
      t.from_role_id,
      (connectionCount.get(t.from_role_id) || 0) + 1
    );
    connectionCount.set(
      t.to_role_id,
      (connectionCount.get(t.to_role_id) || 0) + 1
    );
  }

  const isolatedRoleCount = [...connectionCount.values()].filter(
    (c) => c === 0
  ).length;

  const topConnectedRoles = [...connectionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([roleId, connections]) => ({ roleId, connections }));

  return {
    totalRoles: roles.length,
    totalTransitions: transitions.length,
    avgTransitionsPerRole: roles.length
      ? Number((transitions.length / roles.length).toFixed(2))
      : 0,
    isolatedRoleCount,
    topConnectedRoles,
  };
}

module.exports = {
  importGraphDataset,
  validateGraphIntegrity,
  getGraphMetrics,
  getImportLogs,
  getDatasetStatuses,
  getGraphHealth,
  getGraphAlerts,
  getLegacyBulkGraphStats,
  SCHEMAS,
  buildFKSets,
  detectFKErrors,
  detectFKOrphans,
  applyComputedFields,
};