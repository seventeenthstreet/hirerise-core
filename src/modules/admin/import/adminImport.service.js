'use strict';

/**
 * adminImport.service.js
 * Fully Supabase-native CSV import pipeline
 */

const { parseCSVBuffer } = require('./csvParser.util');
const { checkDependencies, getNextStep } = require('./importDependency.service');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const ENTITY_TO_TABLE = {
  'career-domains': 'career_domains',
  'job-families': 'job_families',
  'skill-clusters': 'skill_clusters',
  skills: 'skills',
  roles: 'roles',
  'education-levels': 'education_levels',
  'salary-benchmarks': 'salary_benchmarks',
  'skill-demand': 'skill_demand',
  'role-skills': 'role_skills',
};

const SUPPORTED_ENTITIES = Object.keys(ENTITY_TO_TABLE);

function normalizeEntityType(raw) {
  if (!raw || typeof raw !== 'string') return raw;

  const normalized = raw
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();

  return ENTITY_TO_TABLE[normalized] ? normalized : normalized;
}

function suggestEntity(input) {
  if (!input) return null;
  const norm = input.toLowerCase().replace(/[_\s]/g, '-');

  return (
    SUPPORTED_ENTITIES.find(
      (e) => e.includes(norm) || norm.includes(e.replace(/-/g, ''))
    ) || null
  );
}

function buildRowResult(row, status, name, message = null) {
  return { row, status, name, message };
}

async function bulkUpsert(table, records, conflictColumns) {
  const CHUNK_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);

    const { data, error } = await supabase
      .from(table)
      .upsert(chunk, { onConflict: conflictColumns })
      .select();

    if (error) {
      throw new AppError(
        `Supabase import failed for ${table}: ${error.message}`,
        500,
        { table },
        ErrorCodes.EXTERNAL_SERVICE_ERROR
      );
    }

    inserted += data?.length || chunk.length;
  }

  return inserted;
}

async function importEntityCSV({
  buffer,
  entityType,
  adminId,
  agency = null,
}) {
  const normalizedEntityType = normalizeEntityType(entityType);
  const table = ENTITY_TO_TABLE[normalizedEntityType];

  if (!table) {
    const suggestion = suggestEntity(entityType);

    throw new AppError(
      `Invalid entity type "${entityType}"${
        suggestion ? `. Did you mean "${suggestion}"?` : ''
      }`,
      400,
      {
        supported: SUPPORTED_ENTITIES,
      },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  await checkDependencies(normalizedEntityType);

  let rows;
  try {
    rows = parseCSVBuffer(buffer);
  } catch (err) {
    throw new AppError(
      `CSV parsing failed: ${err.message}`,
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const rowResults = [];
  const validRecords = [];
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = rows[i];

    try {
      const record = {
        ...row,
        updated_at: now,
        imported_by_admin_id: adminId,
        agency,
      };

      validRecords.push(record);

      rowResults.push(
        buildRowResult(
          rowNum,
          'created',
          row.name || row.skill || row.role || `row-${rowNum}`
        )
      );
    } catch (err) {
      rowResults.push(
        buildRowResult(
          rowNum,
          'error',
          `row-${rowNum}`,
          err.message
        )
      );
    }
  }

  const conflictMap = {
    'career-domains': 'name',
    'job-families': 'name',
    'skill-clusters': 'name',
    skills: 'name',
    roles: 'name',
    'education-levels': 'name',
    'salary-benchmarks': 'name',
    'skill-demand': 'skill',
    'role-skills': 'role,skill',
  };

  const inserted = await bulkUpsert(
    table,
    validRecords,
    conflictMap[normalizedEntityType]
  );

  logger.info('[AdminImport] Supabase import complete', {
    table,
    entityType: normalizedEntityType,
    totalRows: rows.length,
    inserted,
    adminId,
  });

  const failed = rowResults.filter((r) => r.status === 'error').length;

  return {
    created: inserted,
    updated: 0,
    skipped: 0,
    failed,
    errors: failed,
    total: rows.length,
    rows: rowResults,
    importedAt: now,
    nextStep: getNextStep(normalizedEntityType),
  };
}

module.exports = {
  importEntityCSV,
  SUPPORTED_ENTITIES,
  normalizeEntityType,
  suggestEntity,
};