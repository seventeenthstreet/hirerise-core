'use strict';

/**
 * graphImport.service.js
 * Final Production Supabase Import Pipeline
 */

const getSupabase = () => require('../../../config/supabase');
const { parseCSVBuffer } = require('../import/csvParser.util');
const logger = require('../../../utils/logger');
const { GRAPH_DATASET_TYPES } = require('./graph.constants');

const BATCH_SIZE = 400;

const SCHEMAS = {
  roles: {
    required: ['role_id', 'role_name'],
    optional: ['role_family', 'seniority_level', 'description'],
    collection: 'roles',
  },
  skills: {
    required: ['skill_id', 'skill_name'],
    optional: ['skill_category', 'difficulty_level', 'demand_score'],
    collection: 'skills',
  },
  role_skills: {
    required: ['role_id', 'skill_id'],
    optional: ['importance_weight'],
    collection: 'role_skills',
    fkChecks: [
      { field: 'role_id', collection: 'roles' },
      { field: 'skill_id', collection: 'skills' },
    ],
  },
  role_transitions: {
    required: ['from_role_id', 'to_role_id'],
    optional: ['probability', 'years_required'],
    collection: 'role_transitions',
    fkChecks: [
      { field: 'from_role_id', collection: 'roles' },
      { field: 'to_role_id', collection: 'roles' },
    ],
  },
  skill_relationships: {
    required: ['skill_id', 'related_skill_id', 'relationship_type'],
    optional: ['strength_score'],
    collection: 'skill_relationships',
    fkChecks: [
      { field: 'skill_id', collection: 'skills' },
      { field: 'related_skill_id', collection: 'skills' },
    ],
  },
  role_education: {
    required: ['role_id', 'education_level'],
    collection: 'role_education',
    fkChecks: [{ field: 'role_id', collection: 'roles' }],
  },
  role_salary_market: {
    required: ['role_id', 'country'],
    collection: 'role_salary_market',
    fkChecks: [{ field: 'role_id', collection: 'roles' }],
  },
  role_market_demand: {
    required: ['role_id', 'country'],
    collection: 'role_market_demand',
    fkChecks: [{ field: 'role_id', collection: 'roles' }],
  },
};

function castRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
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

// 🚀 Optimized FK lookup
async function buildFKSets(rows, fkChecks) {
  if (!fkChecks?.length) return {};

  const supabase = getSupabase();
  const sets = {};

  for (const { field, collection } of fkChecks) {
    const values = [...new Set(rows.map((r) => r[field]).filter(Boolean))];

    if (!values.length) {
      sets[collection] = new Set();
      continue;
    }

    const column = collection === 'skills'
      ? 'skill_id'
      : 'role_id';

    const { data, error } = await supabase
      .from(collection)
      .select(column)
      .in(column, values);

    if (error) {
      logger.warn('[GraphImport] FK lookup failed', {
        collection,
        error: error.message,
      });
      sets[collection] = new Set();
      continue;
    }

    sets[collection] = new Set(data.map((r) => String(r[column])));
  }

  return sets;
}

function detectFKErrors(rows, schema, fkSets) {
  const errors = [];

  for (const row of rows) {
    for (const { field, collection } of schema.fkChecks || []) {
      const val = row[field];

      if (
        val &&
        fkSets[collection] &&
        !fkSets[collection].has(String(val))
      ) {
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
  const validRows = castedRows.filter((r) => !fieldInvalid.has(r.__rowNum));

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

  return {
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
}

// keep your analytics functions unchanged below
// validateGraphIntegrity
// getGraphMetrics
// getImportLogs
// getDatasetStatuses
// getGraphHealth
// getGraphAlerts
// getCareerGraphStats

module.exports = {
  importGraphDataset,
  validateGraphIntegrity,
  getGraphMetrics,
  getImportLogs,
  getDatasetStatuses,
  getGraphHealth,
  getGraphAlerts,
  getCareerGraphStats,
  SCHEMAS,
};