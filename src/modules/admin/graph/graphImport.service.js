'use strict';

/**
 * graphImport.service.js — Enterprise Graph Data Ingestion Pipeline
 *
 * 7-stage pipeline:
 *   1. CSV Parse
 *   2. Schema validation (required fields)
 *   3. Duplicate ID detection (within-file + Firestore)
 *   4. Foreign key validation (batch Firestore lookups)
 *   5. Row classification (valid / rejected)
 *   6. Batch Firestore writes (append or replace mode)
 *   7. Import log → import_logs collection
 */

function getSupabase() { return require('../../../core/supabaseClient'); }
const { parseCSVBuffer }           = require('../import/csvParser.util');
const logger                       = require('../../../utils/logger');

const BATCH_SIZE = 400;

const GRAPH_DATASET_TYPES = [
  'roles', 'skills', 'role_skills', 'role_transitions',
  'skill_relationships', 'role_education', 'role_salary_market',
  'role_market_demand',
];

const SCHEMAS = {
  roles: {
    required: ['role_id', 'role_name'],
    optional: ['role_family', 'seniority_level', 'description'],
    collection: 'roles',
    idField: 'role_id',
  },
  skills: {
    required: ['skill_id', 'skill_name'],
    optional: ['skill_category', 'difficulty_level', 'demand_score'],
    collection: 'skills',
    idField: 'skill_id',
  },
  role_skills: {
    required: ['role_id', 'skill_id'],
    optional: ['importance_weight'],
    collection: 'role_skills',
    fkChecks: [
      { field: 'role_id',  collection: 'roles' },
      { field: 'skill_id', collection: 'skills' },
    ],
  },
  role_transitions: {
    required: ['from_role_id', 'to_role_id'],
    optional: ['probability', 'years_required', 'transition_type'],
    collection: 'role_transitions',
    fkChecks: [
      { field: 'from_role_id', collection: 'roles' },
      { field: 'to_role_id',   collection: 'roles' },
    ],
  },
  skill_relationships: {
    required: ['skill_id', 'related_skill_id', 'relationship_type'],
    optional: ['strength_score'],
    collection: 'skill_relationships',
    fkChecks: [
      { field: 'skill_id',         collection: 'skills' },
      { field: 'related_skill_id', collection: 'skills' },
    ],
  },
  role_education: {
    required: ['role_id', 'education_level'],
    optional: ['match_score'],
    collection: 'role_education',
    fkChecks: [{ field: 'role_id', collection: 'roles' }],
  },
  role_salary_market: {
    required: ['role_id', 'country'],
    optional: ['median_salary', 'p25', 'p75', 'currency'],
    collection: 'role_salary_market',
    fkChecks: [{ field: 'role_id', collection: 'roles' }],
  },
  role_market_demand: {
    required: ['role_id', 'country'],
    optional: ['job_postings', 'growth_rate', 'competition_score', 'remote_ratio', 'last_updated'],
    collection: 'role_market_demand',
    fkChecks: [{ field: 'role_id', collection: 'roles' }],
  },
};

const NUMERIC_FIELDS = {
  role_skills:         ['importance_weight'],
  role_transitions:    ['probability', 'years_required'],
  skill_relationships: ['strength_score'],
  role_education:      ['match_score'],
  role_salary_market:  ['median_salary', 'p25', 'p75'],
  role_market_demand:  ['job_postings', 'growth_rate', 'competition_score', 'remote_ratio'],
  skills:              ['difficulty_level', 'demand_score'],
};

// Column name remapping: CSV column -> DB column
const COLUMN_REMAP = {
  skills: {
    skill_name:     'name',
    skill_category: 'category',
  },
  roles: {
    role_name:      'name',
    role_family:    'role_family',   // keep as-is - check DB column
    seniority_level:'seniority_level', // keep as-is
  },
};

function remapColumns(row, datasetType) {
  const remap = COLUMN_REMAP[datasetType];
  if (!remap) return row;
  const out = { ...row };
  for (const [csvCol, dbCol] of Object.entries(remap)) {
    if (csvCol in out) {
      out[dbCol] = out[csvCol];
      delete out[csvCol];
    }
  }
  return out;
}

function castRow(row, datasetType) {
  const cast = {};
  for (const [k, v] of Object.entries(row)) {
    cast[k] = typeof v === 'string' ? v.trim() : v;
  }
  for (const field of (NUMERIC_FIELDS[datasetType] || [])) {
    if (cast[field] !== undefined && cast[field] !== '') {
      const n = parseFloat(cast[field]);
      cast[field] = isNaN(n) ? null : n;
    }
  }
  return cast;
}

function validateRowFields(row, schema, rowIndex) {
  const errors = [];
  for (const field of schema.required) {
    const val = row[field];
    if (val === undefined || val === null || String(val).trim() === '') {
      errors.push({ row: rowIndex, field, type: 'field', message: `Required field "${field}" is missing or empty` });
    }
  }
  return errors;
}

function buildDocId(row, datasetType) {
  switch (datasetType) {
    case 'roles':               return row.role_id;
    case 'skills':              return row.skill_id;
    case 'role_skills':         return `${row.role_id}__${row.skill_id}`;
    case 'role_transitions':    return `${row.from_role_id}__${row.to_role_id}`;
    case 'skill_relationships': return `${row.skill_id}__${row.related_skill_id}`;
    case 'role_education':      return `${row.role_id}__${row.education_level.replace(/\s+/g, '_').toLowerCase()}`;
    case 'role_salary_market':  return `${row.role_id}__${row.country.toLowerCase()}`;
    case 'role_market_demand':  return `${row.role_id}__${row.country.toLowerCase()}`;
    default:                    return null;
  }
}

function detectFileDuplicates(rows, datasetType) {
  const seen  = new Map();
  const dupes = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNum = rows[i].__rowNum;
    const docId  = buildDocId(rows[i], datasetType);
    if (!docId) continue;
    if (seen.has(docId)) {
      dupes.push({ row: rowNum, field: 'id', type: 'duplicate',
        message: `Duplicate ID "${docId}" — first seen on row ${seen.get(docId)}` });
    } else {
      seen.set(docId, rowNum);
    }
  }
  return dupes;
}

async function buildFKSets(rows, fkChecks) {
  if (!fkChecks || !fkChecks.length) return {};
  const supabase = getSupabase();
  const sets = {};
  for (const { collection } of fkChecks) {
    if (sets[collection]) continue;
    sets[collection] = new Set();
    const domainField = collection === 'skills' ? 'skill_id' : 'role_id';

    // Query with pagination to get ALL records (default limit may be 1000)
    let allRows = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from(collection)
        .select('*')
        .range(from, from + PAGE - 1);

      if (error) {
        logger.warn('[GraphImport] FK lookup failed', { collection, error: error.message });
        break;
      }
      if (!data || data.length === 0) break;
      allRows = allRows.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    logger.info('[GraphImport] FK set built', { collection, count: allRows.length });

    for (const row of allRows) {
      // Add every possible ID field value to the set
      ['id', 'skill_id', 'role_id', domainField].forEach(f => {
        if (row[f] != null) sets[collection].add(String(row[f]).trim());
      });
    }

    // Safety: if no records found, warn clearly
    if (sets[collection].size === 0) {
      logger.warn('[GraphImport] FK set is EMPTY — ' + collection + ' may not be loaded');
    }
  }
  return sets;
}

function detectFKErrors(validRows, schema, fkSets) {
  const errors = [];
  for (const row of validRows) {
    for (const { field, collection } of (schema.fkChecks || [])) {
      const val = row[field];
      if (val && fkSets[collection] && !fkSets[collection].has(String(val).trim())) {
        errors.push({ row: row.__rowNum, field, type: 'fk',
          message: `FK violation: "${val}" not found in ${collection}` });
      }
    }
  }
  return errors;
}

async function deleteCollection(tableName) {
  const supabase = getSupabase();
  // Count first, then delete all rows
  const { count } = await supabase.from(tableName).select('*', { count: 'exact', head: true });
  if (count > 0) {
    await supabase.from(tableName).delete().neq('id', '00000000-0000-0000-0000-000000000000'); // delete all
  }
  return count || 0;
}

async function getDatasetStatuses() {
  const supabase = getSupabase();
  const tables = [
    'roles', 'skills', 'role_skills', 'role_transitions',
    'skill_relationships', 'role_education', 'role_salary_market',
  ];

  const counts = await Promise.all(
    tables.map(async t => {
      const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
      return count || 0;
    })
  );

  // Read recent import logs from Supabase import_logs table
  const { data: logs } = await supabase.from('import_logs')
    .select('entity_type, imported_at, failed_count, created_count')
    .order('imported_at', { ascending: false }).limit(100);

  const lastImport = {};
  const lastStatus = {};
  for (const log of (logs || [])) {
    if (!lastImport[log.entity_type]) {
      lastImport[log.entity_type] = log.imported_at;
      lastStatus[log.entity_type] = log.failed_count > 0 && log.created_count === 0 ? 'error'
        : log.failed_count > 0 ? 'partial' : 'success';
    }
  }

  return tables.map((tbl, i) => {
    const count = counts[i];
    const status = count === 0 ? 'missing'
      : lastStatus[tbl] === 'error' ? 'missing'
      : lastStatus[tbl] === 'partial' ? 'partial' : 'loaded';
    return { dataset: tbl, count, status, last_import: lastImport[tbl] || null, last_result: lastStatus[tbl] || null };
  });
}

async function importGraphDataset({ buffer, datasetType, adminId, preview = false, mode = 'append' }) {
  if (!GRAPH_DATASET_TYPES.includes(datasetType)) {
    throw new Error(`Unsupported dataset type: "${datasetType}"`);
  }
  const schema    = SCHEMAS[datasetType];
  const startTime = Date.now();

  let rawRows;
  try { rawRows = parseCSVBuffer(buffer); }
  catch (err) { throw new Error(`CSV parse failed: ${err.message}`); }

  if (!rawRows.length) {
    return {
      datasetType, processed: 0, importable: 0, imported: 0,
      fieldErrors: [], duplicateErrors: [], fkErrors: [], writeErrors: [],
      errors: [], errorCount: 0, preview: [], skipped: 0, mode,
      schema: { required: schema.required, optional: schema.optional || [] },
    };
  }

  const castedRows = rawRows.map((r, i) => ({ ...castRow(r, datasetType), __rowNum: i + 2 }));

  // Stage 2: field validation
  const fieldErrors = [];
  for (const row of castedRows) fieldErrors.push(...validateRowFields(row, schema, row.__rowNum));
  const fieldInvalidRows = new Set(fieldErrors.map(e => e.row));
  const fieldValidRows   = castedRows.filter(r => !fieldInvalidRows.has(r.__rowNum));

  // Stage 3: duplicate detection
  const duplicateErrors = detectFileDuplicates(fieldValidRows, datasetType);
  const dupInvalidRows  = new Set(duplicateErrors.map(e => e.row));
  const dedupedRows     = fieldValidRows.filter(r => !dupInvalidRows.has(r.__rowNum));

  // Stage 4: FK validation
  const fkSets   = await buildFKSets(dedupedRows, schema.fkChecks);
  const fkErrors = detectFKErrors(dedupedRows, schema, fkSets);
  const fkInvalidRows  = new Set(fkErrors.map(e => e.row));
  const importableRows = dedupedRows.filter(r => !fkInvalidRows.has(r.__rowNum));

  const cleanRow = r => { const { __rowNum, ...rest } = r; return rest; };

  if (preview) {
    return {
      datasetType,
      processed:       rawRows.length,
      importable:      importableRows.length,
      fieldErrors,
      duplicateErrors,
      fkErrors,
      errors:          [...fieldErrors, ...duplicateErrors, ...fkErrors],
      errorCount:      fieldErrors.length + duplicateErrors.length + fkErrors.length,
      preview:         importableRows.slice(0, 10).map(cleanRow),
      schema:          { required: schema.required, optional: schema.optional || [] },
      mode,
    };
  }

  // Stage 6: batch writes
  let deleted  = 0;
  let imported = 0;
  const writeErrors = [];

  if (mode === 'replace') {
    try { deleted = await deleteCollection(schema.collection); }
    catch (err) { throw new Error(`Replace mode delete failed: ${err.message}`); }
  }

  const supabase = getSupabase();
  for (let i = 0; i < importableRows.length; i += BATCH_SIZE) {
    const chunk = importableRows.slice(i, i + BATCH_SIZE);
    const records = chunk.map(row => {
      const clean = remapColumns(cleanRow(row), datasetType);
      const id = buildDocId(clean, datasetType);
      if (!id) {
        writeErrors.push({ row: row.__rowNum, field: 'id', type: 'write', message: 'Could not build row ID' });
        return null;
      }
      // Use the id field appropriate to each table
      const idField = datasetType === 'skills' ? 'skill_id'
        : datasetType === 'roles' ? 'role_id' : null;
      // skills/roles: table PK is 'id' (text), set id = domain key value
      // Also keep the domain field for FK lookups
      const idAssign = idField
        ? { [idField]: id, id }   // e.g. { skill_id: 'python', id: 'python' }
        : {};                      // junction tables: uuid PK auto-generated
      return { ...clean, ...idAssign, updated_at: new Date().toISOString() };
    }).filter(Boolean);

    if (!records.length) continue;
        // roles/skills: conflict on their domain PK column
    // junction tables: conflict on composite unique index
    const conflictMap = {
      roles:               'id',   // PK is 'id' (text) = role_id value
      skills:              'id',   // PK is 'id' (text) = skill_id value
      role_skills:         'role_id,skill_id',
      role_transitions:    'from_role_id,to_role_id',
      skill_relationships: 'skill_id,related_skill_id',
      role_education:      'role_id,education_level',
      role_salary_market:  'role_id,country',
      role_market_demand:  'role_id,country',
    };
    const conflictOn = conflictMap[datasetType];
    const { error } = conflictOn
      ? await supabase.from(schema.collection).upsert(records, { onConflict: conflictOn })
      : await supabase.from(schema.collection).upsert(records);

    if (error) {
      logger.error('[GraphImport] Supabase upsert failed', { datasetType, err: error.message });
      writeErrors.push({ row: 0, field: 'batch', type: 'write', message: `Write error: ${error.message}` });
    } else {
      imported += records.length;
    }
  }

  const allErrors  = [...fieldErrors, ...duplicateErrors, ...fkErrors, ...writeErrors];
  const durationMs = Date.now() - startTime;

  try {
    const supabaseLog = getSupabase();
    await supabaseLog.from('import_logs').insert({
      dataset_name:      datasetType,
      entity_type:       datasetType,
      admin_user_id:     adminId || 'unknown',
      admin_id:          adminId || 'unknown',
      rows_processed:    rawRows.length,
      total_rows:        rawRows.length,
      rows_imported:     imported,
      created_count:     imported,
      rows_skipped:      rawRows.length - importableRows.length,
      skipped_count:     rawRows.length - importableRows.length,
      rows_failed:       allErrors.length,
      failed_count:      allErrors.length,
      duplicate_errors:  duplicateErrors.length,
      fk_errors:         fkErrors.length,
      row_results:       allErrors.slice(0, 100),
      import_mode:       mode || 'append',
      duration_ms:       Date.now() - startTime,
      import_time:       new Date().toISOString(),
      imported_at:       new Date().toISOString(),
    });
  } catch (logErr) {
    logger.warn('[GraphImport] Failed to write import log', { err: logErr.message });
  }

  return {
    datasetType, processed: rawRows.length, imported, importable: importableRows.length,
    skipped: rawRows.length - importableRows.length, deleted,
    fieldErrors, duplicateErrors, fkErrors, writeErrors,
    errors: allErrors, errorCount: allErrors.length,
    importedAt: new Date().toISOString(), durationMs, mode,
  };
}

async function validateGraphIntegrity() {
  const supabase = getSupabase();
  const [
    _vr1, _vr2, _vr3, _vr4, _vr5, _vr6, _vr7,
  ] = await Promise.all([
    supabase.from('roles').select('role_id'),
    supabase.from('skills').select('skill_id'),
    supabase.from('role_skills').select('role_id, skill_id'),
    supabase.from('role_transitions').select('id, from_role_id, to_role_id'),
    supabase.from('skill_relationships').select('id, skill_id, related_skill_id'),
    supabase.from('role_education').select('id, role_id'),
    supabase.from('role_salary_market').select('id, role_id'),
  ]);
  const roles       = _vr1.data || [];
  const skills      = _vr2.data || [];
  const roleSkills  = _vr3.data || [];
  const transitions = _vr4.data || [];
  const skillRels   = _vr5.data || [];
  const roleEdu     = _vr6.data || [];
  const roleSalary  = _vr7.data || [];

  const roleIds  = new Set(roles.map(r => r.role_id));
  const skillIds = new Set(skills.map(r => r.skill_id));
  const issues   = { orphan_roles: [], orphan_skills: [], broken_role_transitions: [],
    role_skills_missing_skills: [], skill_rels_missing_skills: [],
    role_edu_missing_roles: [], salary_missing_roles: [] };

  const rolesInSkills = new Set(roleSkills.map(r => r.role_id));
  const rolesInTrans  = new Set([...transitions.map(r => r.from_role_id), ...transitions.map(r => r.to_role_id)]);
  for (const id of roleIds) { if (!rolesInSkills.has(id) && !rolesInTrans.has(id)) issues.orphan_roles.push(id); }

  const skillsInRoleSkills = new Set(roleSkills.map(r => r.skill_id));
  const skillsInRels = new Set([...skillRels.map(r => r.skill_id), ...skillRels.map(r => r.related_skill_id)]);
  for (const id of skillIds) { if (!skillsInRoleSkills.has(id) && !skillsInRels.has(id)) issues.orphan_skills.push(id); }

  for (const row of transitions) {
    const { id, from_role_id, to_role_id } = row;
    if (!roleIds.has(from_role_id) || !roleIds.has(to_role_id))
      issues.broken_role_transitions.push({ id, from_role_id, to_role_id,
        reason: !roleIds.has(from_role_id) ? `from_role_id "${from_role_id}" not found` : `to_role_id "${to_role_id}" not found` });
  }
  for (const row of roleSkills)   { if (!skillIds.has(row.skill_id)) issues.role_skills_missing_skills.push(row); }
  for (const row of skillRels)    {
    if (!skillIds.has(row.skill_id) || !skillIds.has(row.related_skill_id))
      issues.skill_rels_missing_skills.push({ ...row,
        reason: !skillIds.has(row.skill_id) ? `skill_id "${row.skill_id}" not found` : `related_skill_id "${row.related_skill_id}" not found` });
  }
  for (const row of roleEdu)    { if (!roleIds.has(row.role_id)) issues.role_edu_missing_roles.push(row); }
  for (const row of roleSalary) { if (!roleIds.has(row.role_id)) issues.salary_missing_roles.push(row); }

  const totalIssues = Object.values(issues).reduce((s, arr) => s + arr.length, 0);
  return { valid: totalIssues === 0,
    counts: { roles: roleIds.size, skills: skillIds.size, role_skills: roleSkills.length,
      role_transitions: transitions.length, skill_relationships: skillRels.length,
      role_education: roleEdu.length, role_salary_market: roleSalary.length },
    issues, total_issues: totalIssues, checked_at: new Date().toISOString() };
}

async function getGraphMetrics() {
  const supabase = getSupabase();
  const tables = ['roles','skills','role_skills','role_transitions','skill_relationships','role_education','role_salary_market'];
  const counts = await Promise.all(
    tables.map(t => supabase.from(t).select('*', { count: 'exact', head: true }).then(({ count }) => count || 0).catch(() => 0))
  );
  let logs = [];
  try {
    const { data: logsData } = await supabase.from('import_logs').select('imported_at').order('imported_at', { ascending: false }).limit(1);
    logs = logsData || [];
  } catch (_) { logs = []; }
  return {
    total_roles:              counts[0], total_skills:            counts[1],
    total_role_skills:        counts[2], total_role_transitions:  counts[3],
    total_skill_relationships:counts[4], total_role_education:    counts[5],
    total_salary_records:     counts[6],
    last_import_at: logs?.[0]?.imported_at ?? null,
  };
}

async function getImportLogs({ limit = 50 } = {}) {
  const supabase = getSupabase();
  let data = [];
  try {
    const { data: logsData } = await supabase.from('import_logs').select('*').order('imported_at', { ascending: false }).limit(limit);
    data = logsData || [];
  } catch (_) { data = []; }
  return (data || []).map(d => ({ ...d, createdAt: d.imported_at }));
}


// ─── Graph Health — coverage percentages ──────────────────────────────────────

async function getGraphHealth() {
  const supabase = getSupabase();
  const [h1, h2, h3, h4, h5] = await Promise.all([
    supabase.from('roles').select('role_id'),
    supabase.from('role_skills').select('role_id'),
    supabase.from('role_transitions').select('from_role_id'),
    supabase.from('role_education').select('role_id'),
    supabase.from('role_salary_market').select('role_id'),
  ]);
  const rolesData       = h1.data || [];
  const roleSkillsData  = h2.data || [];
  const transitionsData = h3.data || [];
  const roleEduData     = h4.data || [];
  const roleSalaryData  = h5.data || [];

  const totalRoles = rolesData.length;
  if (totalRoles === 0) {
    return { total_roles: 0, roles_with_skills_pct: 0, roles_with_transitions_pct: 0,
      roles_with_education_pct: 0, roles_with_salary_pct: 0, roles_with_skills: 0,
      roles_with_transitions: 0, roles_with_education: 0, roles_with_salary: 0,
      checked_at: new Date().toISOString() };
  }

  const rolesWithSkills      = new Set(roleSkillsData.map(r => r.role_id)).size;
  const rolesWithTransitions = new Set(transitionsData.map(r => r.from_role_id)).size;
  const rolesWithEdu         = new Set(roleEduData.map(r => r.role_id)).size;
  const rolesWithSalary      = new Set(roleSalaryData.map(r => r.role_id)).size;
  const pct = (n) => Math.round((n / totalRoles) * 100);

  return {
    total_roles: totalRoles,
    roles_with_skills: rolesWithSkills, roles_with_transitions: rolesWithTransitions,
    roles_with_education: rolesWithEdu, roles_with_salary: rolesWithSalary,
    roles_with_skills_pct: pct(rolesWithSkills), roles_with_transitions_pct: pct(rolesWithTransitions),
    roles_with_education_pct: pct(rolesWithEdu), roles_with_salary_pct: pct(rolesWithSalary),
    checked_at: new Date().toISOString(),
  };
}

async function getGraphAlerts() {
  const supabase = getSupabase();
  const [r1, r2, r3, r4, r5, r6] = await Promise.all([
    supabase.from('roles').select('role_id'),
    supabase.from('skills').select('skill_id'),
    supabase.from('role_skills').select('role_id, skill_id'),
    supabase.from('role_transitions').select('from_role_id, to_role_id'),
    supabase.from('role_education').select('role_id'),
    supabase.from('role_salary_market').select('role_id'),
  ]);
  const roles       = r1.data || [];
  const skills      = r2.data || [];
  const roleSkills  = r3.data || [];
  const transitions = r4.data || [];
  const roleEdu     = r5.data || [];
  const roleSalary  = r6.data || [];

  const roleIds  = new Set(roles.map(r => r.role_id));
  const skillIds = new Set(skills.map(r => r.skill_id));

  const rolesWithSkills      = new Set(roleSkills.map(r => r.role_id));
  const rolesWithTransitions = new Set([
    ...transitions.map(r => r.from_role_id),
    ...transitions.map(r => r.to_role_id),
  ]);
  const rolesWithEdu    = new Set(roleEdu.map(r => r.role_id));
  const rolesWithSalary = new Set(roleSalary.map(r => r.role_id));
  const skillsInGraph   = new Set(roleSkills.map(r => r.skill_id));

  const alerts = [];

  const missingSkills      = [...roleIds].filter(id => !rolesWithSkills.has(id)).length;
  const missingTransitions = [...roleIds].filter(id => !rolesWithTransitions.has(id)).length;
  const missingEdu         = [...roleIds].filter(id => !rolesWithEdu.has(id)).length;
  const missingSalary      = [...roleIds].filter(id => !rolesWithSalary.has(id)).length;
  const unusedSkills       = [...skillIds].filter(id => !skillsInGraph.has(id)).length;

  if (missingSkills > 0)
    alerts.push({ type: 'warn', code: 'ROLES_MISSING_SKILLS',      count: missingSkills,      message: `${missingSkills} role${missingSkills !== 1 ? 's' : ''} missing skill mappings` });
  if (missingTransitions > 0)
    alerts.push({ type: 'warn', code: 'ROLES_MISSING_TRANSITIONS',  count: missingTransitions,  message: `${missingTransitions} role${missingTransitions !== 1 ? 's' : ''} missing career transitions` });
  if (missingEdu > 0)
    alerts.push({ type: 'info', code: 'ROLES_MISSING_EDUCATION',    count: missingEdu,          message: `${missingEdu} role${missingEdu !== 1 ? 's' : ''} missing education mapping` });
  if (missingSalary > 0)
    alerts.push({ type: 'info', code: 'ROLES_MISSING_SALARY',       count: missingSalary,       message: `${missingSalary} role${missingSalary !== 1 ? 's' : ''} missing salary benchmarks` });
  if (unusedSkills > 0)
    alerts.push({ type: 'warn', code: 'SKILLS_UNUSED',              count: unusedSkills,        message: `${unusedSkills} skill${unusedSkills !== 1 ? 's' : ''} not connected to any role` });

  return {
    alerts,
    alert_count: alerts.length,
    has_critical: alerts.some(a => a.type === 'critical'),
    has_warnings: alerts.some(a => a.type === 'warn'),
    checked_at:   new Date().toISOString(),
  };
}

// ─── Career Graph Statistics ─────────────────────────────────────────────────

async function getCareerGraphStats() {
  const supabase = getSupabase();
  const [rolesResult, transitionsResult] = await Promise.all([
    supabase.from('roles').select('role_id'),
    supabase.from('role_transitions').select('from_role_id, to_role_id'),
  ]);
  const roles       = rolesResult.data       || [];
  const transitions = transitionsResult.data || [];

  if (!transitions.length) {
    return { avg_path_depth: 0, longest_path: 0, shortest_path: 0, total_roles: roles.length, total_transitions: 0 };
  }

  // Build adjacency list
  const adj = {};
  for (const r of transitions) {
    const { from_role_id, to_role_id } = r;
    if (!adj[from_role_id]) adj[from_role_id] = [];
    adj[from_role_id].push(to_role_id);
  }

  const roleIds = roles.map(r => r.role_id);

  // BFS from each role node to find max reachable depth
  function bfsDepth(start) {
    const visited = new Set([start]);
    let queue = [start], depth = 0;
    while (queue.length) {
      const next = [];
      for (const node of queue) {
        for (const nb of (adj[node] || [])) {
          if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
        }
      }
      if (next.length) depth++;
      queue = next;
    }
    return depth;
  }

  // Sample up to 200 roles for performance
  const sample = roleIds.slice(0, 200);
  const depths = sample.map(id => bfsDepth(id)).filter(d => d > 0);

  if (!depths.length) {
    return { avg_path_depth: 0, longest_path: 0, shortest_path: 0, total_roles: roles.length, total_transitions: transitions.length };
  }

  return {
    avg_path_depth:    Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 10) / 10,
    longest_path:      Math.max(...depths),
    shortest_path:     Math.min(...depths),
    total_roles:       roles.length,
    total_transitions: transitions.length,
    sampled_roles:     sample.length,
  };
}

module.exports = { importGraphDataset, validateGraphIntegrity, getGraphMetrics, getImportLogs, getDatasetStatuses, getGraphHealth, getGraphAlerts, getCareerGraphStats, GRAPH_DATASET_TYPES, SCHEMAS };








