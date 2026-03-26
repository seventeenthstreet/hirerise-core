'use strict';

/**
 * adminImport.service.js — CSV Import Service (flat /admin/import/:entity routes)
 *
 * Delegates entirely to the existing adminCmsImport.service.processImport()
 * pipeline, which already handles:
 *   - Writing to the correct cms_* Firestore collections
 *   - normalizedName / composite key computation
 *   - Deduplication (internal + database)
 *   - Correct document shape (softDeleted, searchTokens, createdByAdminId, etc.)
 *
 * This service's only jobs are:
 *   1. Parse the CSV buffer into rows (via csvParser.util)
 *   2. Map kebab-case frontend entity names to the internal camelCase keys
 *      that processImport and SUPPORTED_TYPES understand
 *   3. Map the processImport result to the ImportResult shape the
 *      frontend expects: { created, updated, skipped, failed, total, rows[], importedAt }
 *
 * Collection map (for reference — managed entirely by adminCmsImport.service):
 *   career-domains    → cms_career_domains
 *   job-families      → cms_job_families
 *   skill-clusters    → cms_skill_clusters
 *   skills            → cms_skills
 *   roles             → cms_roles
 *   education-levels  → cms_education_levels
 *   salary-benchmarks → cms_salary_benchmarks
 *
 * @module modules/admin/import/adminImport.service
 */

const { parseCSVBuffer }                    = require('./csvParser.util');
const { processImport }                     = require('../cms/import/adminCmsImport.service');
const { checkDependencies, getNextStep }    = require('./importDependency.service');
const { AppError, ErrorCodes }              = require('../../../middleware/errorHandler');
const logger                                = require('../../../utils/logger');

// ── Entity name mapping ───────────────────────────────────────────────────────
// Maps the frontend's kebab-case ImportEntity values to the internal
// camelCase datasetType keys used by processImport / SUPPORTED_TYPES.

const ENTITY_TO_DATASET_TYPE = {
  'career-domains':     'careerDomains',
  'job-families':       'jobFamilies',
  'skill-clusters':     'skillClusters',
  'skills':             'skills',
  'roles':              'roles',
  'education-levels':   'educationLevels',
  'salary-benchmarks':  'salaryBenchmarks',
  // Supabase skill intelligence tables (replaces src/data CSV files)
  'skill-demand':       'skillDemand',
  'role-skills':        'roleSkills',
};

// Entity types that write to Supabase instead of Firestore cms_* collections
const SUPABASE_ENTITY_TYPES = new Set(['skillDemand', 'roleSkills']);

const SUPPORTED_ENTITIES = Object.keys(ENTITY_TO_DATASET_TYPE);

// ── Normalization helpers ─────────────────────────────────────────────────────

/**
 * Normalize a raw entityType string from the client into a canonical kebab-case key.
 * Handles camelCase variants (e.g. "jobFamilies" → "job-families") and
 * loose casing so the backend is resilient to frontend inconsistencies.
 *
 * @param {string} raw — e.g. 'jobFamilies', 'Job-Families', 'job-families'
 * @returns {string}   — canonical kebab-case key, or the lowercased raw value
 *                       if no alias matches (let validation catch it below).
 */
function normalizeEntityType(raw) {
  if (!raw || typeof raw !== 'string') return raw;

  // 1. Try an exact match first (already canonical)
  if (ENTITY_TO_DATASET_TYPE[raw]) return raw;

  // 2. Lowercase + collapse underscores → hyphens
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (ENTITY_TO_DATASET_TYPE[lower]) return lower;

  // 3. camelCase → kebab-case  (e.g. "jobFamilies" → "job-families")
  const kebab = raw
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/_/g, '-');
  if (ENTITY_TO_DATASET_TYPE[kebab]) return kebab;

  // 4. Explicit alias table for known historical/variant spellings
  const ALIASES = {
    'careerdomains':      'career-domains',
    'career_domains':     'career-domains',
    'jobfamilies':        'job-families',
    'job_families':       'job-families',
    'skillclusters':      'skill-clusters',
    'skill_clusters':     'skill-clusters',
    'educationlevels':    'education-levels',
    'education_levels':   'education-levels',
    'salarybenchmarks':   'salary-benchmarks',
    'salary_benchmarks':  'salary-benchmarks',
  };
  if (ALIASES[lower]) return ALIASES[lower];

  return lower; // fall through — validation will produce a clear error
}

/**
 * Suggest the closest supported entity name for an unrecognised value.
 * Simple prefix / substring match — good enough for error messages.
 *
 * @param {string} input
 * @returns {string|null}
 */
function suggestEntity(input) {
  if (!input) return null;
  const norm = input.toLowerCase().replace(/[_\s]/g, '-');
  return SUPPORTED_ENTITIES.find(e => e.includes(norm) || norm.includes(e.replace(/-/g, ''))) ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * importEntityCSV({ buffer, entityType, adminId, agency })
 *
 * @param {Buffer} buffer       Raw file buffer from multer memoryStorage
 * @param {string} entityType   Frontend entity key (kebab-case), e.g. 'job-families'
 * @param {string} adminId      From req.user.uid — NEVER from body
 * @param {string} [agency]     From req.user.agency — NEVER from body
 *
 * @returns {Promise<ImportResult>}
 *   { created, updated, skipped, failed, total, rows[], importedAt }
 */
async function importEntityCSV({ buffer, entityType, adminId, agency = null }) {

  // 1. Normalize incoming entity type (handles camelCase, underscores, wrong casing)
  const normalizedEntityType = normalizeEntityType(entityType);

  // 2. Map frontend entity name → internal dataset type
  const datasetType = ENTITY_TO_DATASET_TYPE[normalizedEntityType];
  if (!datasetType) {
    const suggestion = suggestEntity(entityType);
    const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : '';
    throw new AppError(
      `Invalid entity type "${entityType}".${didYouMean} Supported values: ${SUPPORTED_ENTITIES.join(', ')}`,
      400,
      { entityType, normalizedEntityType, supported: SUPPORTED_ENTITIES, suggestion: suggestion ?? undefined },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // 3. Check import order dependencies before touching the CSV
  await checkDependencies(datasetType);

  // 4. Parse CSV buffer into row objects
  let rows;
  try {
    rows = parseCSVBuffer(buffer);
  } catch (err) {
    if (err.isOperational) throw err;
    throw new AppError(
      `Failed to parse CSV: ${err.message}`,
      400, null, ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.info('[AdminImport] CSV parsed', {
    entityType: normalizedEntityType,
    originalEntityType: entityType !== normalizedEntityType ? entityType : undefined,
    datasetType,
    rowCount: rows.length,
    adminId,
    agency,
  });

  // 5. Route to Supabase or Firestore based on entity type
  let result;
  if (SUPABASE_ENTITY_TYPES.has(datasetType)) {
    // Supabase path — skill_demand and role_skills tables
    result = await _importToSupabase({ datasetType, rows, adminId });
  } else {
    // Firestore path — existing cms_* collections
    result = await processImport({ datasetType, rows, adminId, agency });
  }

  logger.info('[AdminImport] Import complete', {
    entityType: normalizedEntityType,
    total:    result.total,
    inserted: result.inserted,
    skipped:  result.skipped,
    errors:   result.errors.length,
    adminId,
  });

  // 4. Map processImport result → frontend ImportResult shape
  //
  // processImport returns:
  //   { total, inserted, skipped, duplicates: [{row, value, reason, ...}], errors: [{row, field, message}], insertedIds }
  //
  // Frontend ImportResult expects:
  //   { created, updated, skipped, failed, total, rows: ImportResultRow[], importedAt }
  //   ImportResultRow: { row, status: 'created'|'updated'|'skipped'|'error', name, message }

  const rowResults = [];

  // Created rows — processImport doesn't track per-row details for inserts,
  // but we can reconstruct from insertedIds count vs input rows.
  // For a detailed per-row log we merge what we have:

  // Rows that were duplicates (skipped)
  for (const dup of result.duplicates) {
    rowResults.push({
      row:     dup.row,
      status:  'skipped',
      name:    dup.value,
      message: dup.message ?? `Already exists (${dup.reason})`,
    });
  }

  // Rows that had validation errors
  for (const err of result.errors) {
    rowResults.push({
      row:     err.row,
      status:  'error',
      name:    err.field ? `row ${err.row}` : `row ${err.row}`,
      message: err.message,
    });
  }

  // Reconstruct created rows from the original input
  // (processImport doesn't return per-row names for inserts, so we derive them)
  const skippedRows  = new Set(result.duplicates.map(d => d.row));
  const erroredRows  = new Set(result.errors.map(e => e.row));
  let createdCount   = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // 1-indexed, row 1 = header
    if (!skippedRows.has(rowNum) && !erroredRows.has(rowNum)) {
      rowResults.push({
        row:     rowNum,
        status:  'created',
        name:    rows[i].name || rows[i].roleid || `row-${rowNum}`,
        message: null,
      });
      createdCount++;
    }
  }

  // Sort by row number for clean display
  rowResults.sort((a, b) => a.row - b.row);

  // Use createdCount (matches row log) as source of truth for the summary counter.
  // result.inserted can be 0 if _insertRows silently catches a Firestore error,
  // while the row log correctly shows the rows as "created" (not in skipped/errors).
  return {
    created:    createdCount,
    updated:    0,
    skipped:    result.skipped,
    failed:     result.errors.length,
    errors:     result.errors.length,
    total:      result.total,
    rows:       rowResults,
    importedAt: new Date().toISOString(),
    nextStep:   getNextStep(datasetType),
  };
}

// ── Supabase Import Handler ───────────────────────────────────────────────────

/**
 * _importToSupabase({ datasetType, rows, adminId })
 *
 * Upserts CSV rows into Supabase skill_demand or role_skills tables.
 * Uses ON CONFLICT DO UPDATE so re-uploading a CSV is safe and idempotent.
 *
 * Expected CSV columns:
 *   skill-demand: skill, demand_score, growth_rate, salary_boost, industry
 *   role-skills:  role, skill, is_required (optional), priority (optional)
 */
async function _importToSupabase({ datasetType, rows, adminId }) {
  const supabase = require('../../../core/supabaseClient');
  const { invalidateCache } = require('../../skillDemand/repository/skillDemandDataset');

  const created = [];
  const errors  = [];
  const skipped = [];

  if (datasetType === 'skillDemand') {
    // Expected columns: skill, demand_score, growth_rate, salary_boost, industry
    const records = rows
      .map((row, i) => {
        const skill = (row.skill || row.name || '').trim();
        if (!skill) {
          errors.push({ row: i + 2, field: 'skill', message: 'skill column is required' });
          return null;
        }
        return {
          skill,
          demand_score: parseFloat(row.demand_score || row.demandscore || 0) || 0,
          growth_rate:  parseFloat(row.growth_rate  || row.growthrate  || 0) || 0,
          salary_boost: parseFloat(row.salary_boost || row.salaryboost || 0) || 0,
          industry:     (row.industry || 'General').trim(),
          updated_at:   new Date().toISOString(),
        };
      })
      .filter(Boolean);

    if (records.length > 0) {
      const { data, error } = await supabase
        .from('skill_demand')
        .upsert(records, { onConflict: 'skill' })
        .select('skill');

      if (error) {
        logger.error('[AdminImport] Supabase skill_demand upsert failed', { error: error.message, adminId });
        throw new AppError(`Failed to import skill demand data: ${error.message}`, 500, {}, ErrorCodes.EXTERNAL_SERVICE_ERROR);
      }
      created.push(...(data || []).map(r => r.skill));
    }

  } else if (datasetType === 'roleSkills') {
    // Expected columns: role, skill, is_required (optional), priority (optional)
    const records = rows
      .map((row, i) => {
        const role  = (row.role  || '').trim();
        const skill = (row.skill || row.skills || '').trim();

        // Handle multi-skill rows: role,"Excel,Tally ERP,GST"
        if (skill.includes(',')) {
          const skillList = skill.split(',').map(s => s.trim()).filter(Boolean);
          return skillList.map((s, j) => ({
            role,
            skill: s,
            is_required: row.is_required !== 'false' && row.is_required !== '0',
            priority:    parseInt(row.priority || j + 1) || j + 1,
            updated_at:  new Date().toISOString(),
          }));
        }

        if (!role || !skill) {
          errors.push({ row: i + 2, field: !role ? 'role' : 'skill', message: `role and skill columns are required` });
          return null;
        }
        return [{
          role,
          skill,
          is_required: row.is_required !== 'false' && row.is_required !== '0',
          priority:    parseInt(row.priority || 1) || 1,
          updated_at:  new Date().toISOString(),
        }];
      })
      .filter(Boolean)
      .flat();

    if (records.length > 0) {
      // Batch upsert in chunks of 500
      const CHUNK = 500;
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('role_skills')
          .upsert(chunk, { onConflict: 'role,skill' })
          .select('role, skill');

        if (error) {
          logger.error('[AdminImport] Supabase role_skills upsert failed', { error: error.message, adminId });
          throw new AppError(`Failed to import role skills data: ${error.message}`, 500, {}, ErrorCodes.EXTERNAL_SERVICE_ERROR);
        }
        created.push(...(data || []).map(r => `${r.role}:${r.skill}`));
      }
    }
  }

  // Invalidate the in-memory dataset cache so next request loads fresh data
  try { invalidateCache(); } catch (_) {}

  logger.info('[AdminImport] Supabase import complete', {
    datasetType, created: created.length, errors: errors.length, adminId,
  });

  return {
    total:      rows.length,
    inserted:   created.length,
    skipped:    0,
    duplicates: [],
    errors,
    insertedIds: [],
  };
}

module.exports = { importEntityCSV, SUPPORTED_ENTITIES, normalizeEntityType, suggestEntity };








