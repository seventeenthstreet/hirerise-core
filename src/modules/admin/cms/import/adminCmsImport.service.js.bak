'use strict';

/**
 * adminCmsImport.service.js — CSV Import with Full Duplicate Prevention Pipeline
 *
 * Import pipeline:
 *   1. Parse and validate CSV rows (structural validation)
 *   2. Normalize all name fields
 *   3. Detect internal duplicates (within the uploaded file itself)
 *   4. Detect database duplicates (against Firestore)
 *   5. Separate clean rows from rejected rows
 *   6. Insert clean rows with contributor tracking
 *   7. Return structured summary with row-level details
 *
 * Supported dataset types:
 *   - skills          (UNIQUE: normalizedName)
 *   - roles           (UNIQUE: normalizedName + jobFamilyId)
 *   - jobFamilies     (UNIQUE: normalizedName)
 *   - educationLevels (UNIQUE: normalizedName)
 *
 * Security:
 *   - adminId always from req.user.uid — injected by the controller, never from CSV
 *   - CSV rows are sanitized: fields named adminId/createdByAdminId are stripped
 *
 * @module modules/admin/cms/import/adminCmsImport.service
 */

// File is at: src/modules/admin/cms/import/
// ../../../../ goes up to: src/
const { normalizeText, normalizeForComposite } = require('../../../../shared/utils/normalizeText');
const { AppError, ErrorCodes }                 = require('../../../../middleware/errorHandler');
const logger                                   = require('../../../../utils/logger');

// Lazy requires — avoid circular deps at startup
// From src/modules/admin/cms/import/, one level up (../) reaches src/modules/admin/cms/
const getSkillsRepo   = () => require('../skills/adminCmsSkills.repository');
const getRolesRepo    = () => require('../roles/adminCmsRoles.repository');
const getGenericRepos        = () => require('../adminCmsGeneric.factory');
const getCareerDomainsModule = () => require('../career-domains/adminCmsCareerDomains.module');
const getSkillClustersModule = () => require('../skill-clusters/adminCmsSkillClusters.module');
const getDb           = () => require('../../../../config/supabase').db;

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_IMPORT_ROWS = 1000;

const SUPPORTED_TYPES = [
  'skills', 'roles', 'jobFamilies', 'educationLevels', 'salaryBenchmarks',
  'careerDomains', 'skillClusters',  // ← taxonomy extension
];

const BLOCKED_CSV_FIELDS = new Set([
  'adminId', 'createdByAdminId', 'updatedByAdminId',
  'sourceAgency', 'createdBy', 'updatedBy',
]);

// ── Main Export ───────────────────────────────────────────────────────────────

async function processImport({ datasetType, rows, adminId, agency = null }) {
  if (!SUPPORTED_TYPES.includes(datasetType)) {
    throw new AppError(
      `Unsupported datasetType: ${datasetType}. Supported: ${SUPPORTED_TYPES.join(', ')}`,
      400, { datasetType }, ErrorCodes.VALIDATION_ERROR
    );
  }

  if (!Array.isArray(rows)) {
    throw new AppError('rows must be an array', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(
      `Import limit exceeded. Maximum ${MAX_IMPORT_ROWS} rows per batch.`,
      400, { provided: rows.length, limit: MAX_IMPORT_ROWS }, ErrorCodes.VALIDATION_ERROR
    );
  }

  // For roles: resolve job family names → doc IDs before validation
  const resolvedRows = datasetType === 'roles'
    ? await _resolveJobFamilyIds(rows)
    : rows;

  const { cleanRows, errors: validationErrors } = _sanitizeAndValidateRows(resolvedRows, datasetType);
  const normalizedRows                          = _normalizeRows(cleanRows, datasetType);
  const { withInternalDupes, internalDuplicates } = _detectInternalDuplicates(normalizedRows, datasetType);
  const { cleanForInsert, dbDuplicates }        = await _detectDatabaseDuplicates(withInternalDupes, datasetType);
  const insertedIds                             = await _insertRows(cleanForInsert, datasetType, adminId, agency);
  const duplicates                              = [...internalDuplicates, ...dbDuplicates];

  logger.info('[AdminCmsImport] Import complete', {
    datasetType,
    total:    rows.length,
    inserted: insertedIds.length,
    skipped:  duplicates.length,
    errors:   validationErrors.length,
    admin_id: adminId,
  });

  return {
    total:      rows.length,
    inserted:   insertedIds.length,
    skipped:    duplicates.length + validationErrors.length,
    duplicates,
    errors:     validationErrors,
    insertedIds,
  };
}

// ── Private Helpers ───────────────────────────────────────────────────────────

/**
 * _resolveJobFamilyIds(rows)
 *
 * For roles imports, the CSV may contain a jobFamily NAME (e.g. "Finance & Accounting")
 * instead of a raw Firestore doc ID. This function detects that case and resolves
 * all unique names to their actual doc IDs in a single batched Firestore query.
 *
 * If the value already looks like a Firestore doc ID (no spaces, alphanumeric + hyphens,
 * 10–30 chars) it is left unchanged.
 *
 * Rows whose jobFamilyId cannot be resolved get an _jobFamilyError flag so that
 * _sanitizeAndValidateRows can emit a clear per-row error.
 *
 * @param {object[]} rows  — raw parsed CSV rows
 * @returns {Promise<object[]>} rows with jobFamilyId resolved to doc IDs
 */
async function _resolveJobFamilyIds(rows) {
  const db = getDb();

  // Collect unique values that look like names (not already a doc ID)
  const nameSet = new Set();
  for (const row of rows) {
    const val = row.jobFamilyId || row.jobfamilyid || row['job family'] || row['jobfamily'];
    if (!val) continue;
    // Treat as a name if it contains spaces or is longer than 30 chars or has special chars
    const looksLikeName = /\s/.test(val) || val.length > 30 || /[&'(),]/.test(val);
    if (looksLikeName) nameSet.add(val.trim());
  }

  // Normalise the jobFamilyId key — CSV headers are lowercased by the parser
  for (const row of rows) {
    if (!row.jobFamilyId && row.jobfamilyid) row.jobFamilyId = row.jobfamilyid;
  }

  if (nameSet.size === 0) return rows; // all values already look like doc IDs

  // Batch lookup — normalizeText() matches the same function used when writing
  const { normalizeText: nt } = require('../../../../shared/utils/normalizeText');
  const normalizedToName = new Map();
  for (const name of nameSet) normalizedToName.set(nt(name), name);

  const normalizedNames = [...normalizedToName.keys()];
  const nameToDocId     = new Map();

  // Firestore 'in' limit is 30 per query
  const CHUNK = 30;
  for (let i = 0; i < normalizedNames.length; i += CHUNK) {
    const chunk = normalizedNames.slice(i, i + CHUNK);
    const snap  = await db.collection('cms_job_families')
      .where('normalizedName', 'in', chunk)
      .where('softDeleted', '==', false)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      nameToDocId.set(data.normalizedName, doc.id);
      // Also map the original casing back
      const origName = normalizedToName.get(data.normalizedName);
      if (origName) nameToDocId.set(origName, doc.id);
    }
  }

  logger.info('[AdminCmsImport] Resolved jobFamily names to IDs', {
    requested: nameSet.size,
    resolved:  nameToDocId.size,
  });

  // Rewrite rows
  return rows.map(row => {
    const val = row.jobFamilyId;
    if (!val) return row;
    const looksLikeName = /\s/.test(val) || val.length > 30 || /[&'(),]/.test(val);
    if (!looksLikeName) return row; // already a doc ID

    const docId = nameToDocId.get(val.trim()) || nameToDocId.get(nt(val.trim()));
    if (docId) {
      return { ...row, jobFamilyId: docId };
    }
    // Could not resolve — mark so _sanitizeAndValidateRows can report a clear error
    return { ...row, _jobFamilyError: `Job family "${val}" not found. Import job families first, then retry.` };
  });
}

function _sanitizeAndValidateRows(rows, datasetType) {
  const cleanRows = [];
  const errors    = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const raw    = rows[i];

    const row = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!BLOCKED_CSV_FIELDS.has(key)) row[key] = value;
    }

    if (!row.name || typeof row.name !== 'string' || !row.name.trim()) {
      errors.push({ row: rowNum, field: 'name', message: 'name is required and must be a non-empty string' });
      continue;
    }

    // Support jobfamilyid (lowercase, as CSV parser lowercases all headers)
    if (!row.jobFamilyId && row.jobfamilyid) row.jobFamilyId = row.jobfamilyid;

    if (datasetType === 'roles') {
      if (row._jobFamilyError) {
        errors.push({ row: rowNum, field: 'jobFamilyId', message: row._jobFamilyError });
        continue;
      }
      if (!row.jobFamilyId) {
        errors.push({ row: rowNum, field: 'jobFamilyId', message: 'jobFamilyId is required for roles. Provide the job family name (e.g. "Finance & Accounting") or its Firestore doc ID.' });
        continue;
      }
    }

    cleanRows.push({ ...row, _rowNum: rowNum });
  }

  return { cleanRows, errors };
}

// Parse a semicolon-separated string into a trimmed array of non-empty strings.
// CSV cells like "tag1;tag2;tag3" become ["tag1", "tag2", "tag3"].
// Already-array values are passed through unchanged.
function _parseDelimitedArray(value, delimiter = ';') {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value || typeof value !== 'string') return [];
  return value.split(delimiter).map(s => s.trim()).filter(Boolean);
}

function _normalizeRows(rows, datasetType) {
  return rows.map(row => {
    const normalized          = { ...row };
    normalized.normalizedName = normalizeText(row.name);

    // Parse array fields that CSV delivers as delimited strings
    if (datasetType === 'skills') {
      normalized.aliases           = _parseDelimitedArray(row.aliases);
      normalized.demandScore       = row.demandscore !== undefined ? Number(row.demandscore) || null
                                   : row.demandScore !== undefined ? Number(row.demandScore) || null
                                   : null;
    }
    if (datasetType === 'roles') {
      normalized.alternativeTitles      = _parseDelimitedArray(row.alternativetitles || row.alternativeTitles);
      normalized.normalizedCompositeKey = normalizeForComposite(row.name, row.jobFamilyId);
    }
    if (datasetType === 'educationLevels') {
      const so = row.sortorder ?? row.sortOrder;
      normalized.sortOrder = so !== undefined && so !== '' ? Number(so) || 0 : undefined;
    }
    if (datasetType === 'salaryBenchmarks') {
      const toNum = (k1, k2) => {
        const v = row[k1] ?? row[k2];
        return v !== undefined && v !== '' ? Number(v) || null : null;
      };
      normalized.minSalary    = toNum('minsalary',    'minSalary');
      normalized.maxSalary    = toNum('maxsalary',    'maxSalary');
      normalized.medianSalary = toNum('mediansalary', 'medianSalary');
      normalized.year         = toNum('year',         'year');
    }
    if (datasetType === 'skillClusters') {
      // Normalise domainId field — CSV may use either casing
      normalized.domainId = row.domainid ?? row.domain_id ?? row.domainId ?? null;
    }

    return normalized;
  });
}

function _detectInternalDuplicates(rows, datasetType) {
  const seen               = new Set();
  const withInternalDupes  = [];
  const internalDuplicates = [];

  for (const row of rows) {
    const key = datasetType === 'roles' ? row.normalizedCompositeKey : row.normalizedName;

    if (seen.has(key)) {
      internalDuplicates.push({
        row: row._rowNum, value: row.name, reason: 'file', existingId: null,
        message: `Duplicate within the uploaded file — "${row.name}" appears more than once.`,
      });
      withInternalDupes.push({ ...row, _isDuplicate: true });
    } else {
      seen.add(key);
      withInternalDupes.push({ ...row, _isDuplicate: false });
    }
  }

  return { withInternalDupes, internalDuplicates };
}

async function _detectDatabaseDuplicates(rows, datasetType) {
  const cleanForInsert = [];
  const dbDuplicates   = [];
  const rowsToCheck    = rows.filter(r => !r._isDuplicate);

  if (rowsToCheck.length === 0) return { cleanForInsert, dbDuplicates };

  let existingMap;

  if (datasetType === 'skills') {
    existingMap = await getSkillsRepo().findManyByNormalizedName(rowsToCheck.map(r => r.normalizedName));
  } else if (datasetType === 'roles') {
    existingMap = await getRolesRepo().findManyByCompositeKey(rowsToCheck.map(r => r.normalizedCompositeKey));
  } else {
    const { jobFamiliesModule, educationLevelsModule, salaryBenchmarksModule } = getGenericRepos();
    let repo;
    if (datasetType === 'jobFamilies') {
      repo = jobFamiliesModule.repository;
    } else if (datasetType === 'salaryBenchmarks') {
      repo = salaryBenchmarksModule.repository;
    } else if (datasetType === 'careerDomains') {
      repo = getCareerDomainsModule().repository;
    } else if (datasetType === 'skillClusters') {
      repo = getSkillClustersModule().repository;
    } else {
      repo = educationLevelsModule.repository;
    }
    existingMap = await repo.findManyByNormalizedName(rowsToCheck.map(r => r.normalizedName));
  }

  for (const row of rows) {
    if (row._isDuplicate) continue;

    const lookupKey = datasetType === 'roles' ? row.normalizedCompositeKey : row.normalizedName;
    const existing  = existingMap.get(lookupKey);

    if (existing) {
      logger.warn('[AdminCmsImport] Database duplicate detected', {
        event: 'duplicate_attempt', dataset_type: datasetType,
        dataset_value: row.name, row: row._rowNum,
        existing_id: existing.id, timestamp: new Date().toISOString(),
      });
      dbDuplicates.push({
        row: row._rowNum, value: row.name, reason: 'database',
        existingId: existing.id, message: `"${row.name}" already exists in the database.`,
      });
    } else {
      cleanForInsert.push(row);
    }
  }

  return { cleanForInsert, dbDuplicates };
}

async function _insertRows(rows, datasetType, adminId, agency) {
  const insertedIds = [];

  for (const row of rows) {
    try {
      let created;
      if (datasetType === 'skills') {
        created = await getSkillsRepo().createSkill(row, adminId, agency);
      } else if (datasetType === 'roles') {
        created = await getRolesRepo().createRole(row, adminId, agency);
      } else {
        const { jobFamiliesModule, educationLevelsModule, salaryBenchmarksModule } = getGenericRepos();
        let repo;
        if (datasetType === 'jobFamilies') {
          repo = jobFamiliesModule.repository;
        } else if (datasetType === 'salaryBenchmarks') {
          repo = salaryBenchmarksModule.repository;
        } else if (datasetType === 'careerDomains') {
          repo = getCareerDomainsModule().repository;
        } else if (datasetType === 'skillClusters') {
          repo = getSkillClustersModule().repository;
        } else {
          repo = educationLevelsModule.repository;
        }
        created = await repo.createEntry(row, adminId, agency);
      }
      insertedIds.push(created.id);
    } catch (err) {
      logger.error('[AdminCmsImport] Row insert failed', { row: row._rowNum, name: row.name, error: err.message });
    }
  }

  return insertedIds;
}

module.exports = { processImport, SUPPORTED_TYPES, MAX_IMPORT_ROWS };









