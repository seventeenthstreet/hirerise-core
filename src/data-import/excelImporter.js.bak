/**
 * excelImporter.js — Bulk Firestore Data Import from Excel
 *
 * Usage: node src/data-import/excelImporter.js --sheet salaryBands --file ./data/hirerise_data.xlsx
 *
 * Supported sheets (must match --sheet argument):
 *   - jobFamilies
 *   - roles
 *   - salaryBands
 *   - roleSkills
 *   - certifications
 *   - careerPaths
 *
 * Scalability note:
 *   Firestore has a max batch size of 500 ops. This importer automatically
 *   chunks writes into 400-op batches with a delay between them to avoid
 *   overwhelming Firestore on large initial datasets.
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
require('../config/supabase');

const ExcelJS = require('exceljs'); // D-06 FIX: replaced xlsx (CVE-2023-30533) with exceljs
const { db }  = require('../config/supabase');
const logger  = require('../utils/logger');

// Max Firestore batch size is 500; use 400 for safety headroom
const BATCH_SIZE   = 400;
const BATCH_DELAY_MS = 500; // Pause between batches to avoid quota spikes

// ── Sheet-to-collection mapping ───────────────────────────────────────────────
const SHEET_CONFIG = {
  jobFamilies: {
    collection: 'jobFamilies',
    idField:    'id',
    transform:  (row) => ({
      name:        row.name,
      description: row.description || '',
      icon:        row.icon || null,
      tracks:      row.tracks ? row.tracks.split(',').map(t => t.trim()) : ['individual_contributor'],
      createdAt:   db.Timestamp?.now?.() || new Date(),
    }),
  },

  roles: {
    collection: 'roles',
    idField:    'id',
    transform:  (row) => ({
      title:       row.title,
      level:       row.level,
      jobFamilyId: row.jobFamilyId,
      track:       row.track || 'individual_contributor',
      description: row.description || '',
      alternativeTitles: row.alternativeTitles
        ? row.alternativeTitles.split(',').map(t => t.trim())
        : [],
      updatedAt:   db.Timestamp?.now?.() || new Date(),
    }),
  },

  salaryBands: {
    collection: 'salaryBands',
    idField:    'roleId',
    transform:  (rows, roleId) => {
      // Multiple rows per role (one per level): aggregate into levels map
      const levels = {};
      rows.forEach(row => {
        levels[row.level] = {
          min:    parseInt(row.salaryMin, 10),
          max:    parseInt(row.salaryMax, 10),
          median: parseInt(row.salaryMedian, 10),
          percentiles: {
            p25: parseInt(row.p25 || row.salaryMin, 10),
            p50: parseInt(row.salaryMedian, 10),
            p75: parseInt(row.p75 || row.salaryMax, 10),
            p90: parseInt(row.p90 || row.salaryMax, 10),
          },
        };
      });
      return { roleId, levels, updatedAt: new Date() };
    },
    groupByField: 'roleId',
  },

  roleSkills: {
    collection: 'roleSkills',
    idField:    'roleId',
    transform:  (rows, roleId) => {
      const skills = rows.map(row => ({
        name:               row.skillName,
        category:           row.category || 'technical',
        criticality:        parseInt(row.criticality || '3', 10),
        minimumProficiency: row.minimumProficiency || 'intermediate',
        roleWeight:         parseFloat(row.roleWeight || '0.5'),
        learningWeeks:      row.learningWeeks ? parseInt(row.learningWeeks, 10) : null,
        resources:          row.resources ? row.resources.split('|').map(r => r.trim()) : [],
      }));
      return { roleId, skills, updatedAt: new Date() };
    },
    groupByField: 'roleId',
  },

  certifications: {
    collection: 'certifications',
    idField:    'id',
    transform:  (row) => ({
      title:          row.title,
      provider:       row.provider,
      url:            row.url || null,
      estimatedHours: parseInt(row.estimatedHours || '0', 10),
      relatedSkills:  row.relatedSkills
        ? row.relatedSkills.split(',').map(s => s.trim().toLowerCase())
        : [],
      difficulty:     row.difficulty || 'intermediate',
      free:           row.free === 'true' || row.free === true,
      createdAt:      new Date(),
    }),
  },

  careerPaths: {
    collection: 'careerPaths',
    idField:    'fromRoleId',
    transform:  (rows, fromRoleId) => {
      const nextRoles = rows.map(row => ({
        roleId:           row.toRoleId,
        transitionType:   row.transitionType || 'vertical',
        estimatedYears:   row.estimatedYears ? parseFloat(row.estimatedYears) : null,
        prerequisites:    row.prerequisites
          ? row.prerequisites.split(',').map(p => p.trim())
          : [],
      }));
      return { fromRoleId, nextRoles, updatedAt: new Date() };
    },
    groupByField: 'fromRoleId',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Core: Write documents in chunked batches
// ─────────────────────────────────────────────────────────────────────────────
const batchWrite = async (collection, documents) => {
  let written = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const chunk = documents.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    chunk.forEach(({ id, data }) => {
      const ref = db.collection(collection).doc(String(id));
      batch.set(ref, data, { merge: true });
    });

    await batch.commit();
    written += chunk.length;
    logger.info(`[Importer] Committed batch: ${written}/${documents.length} docs to '${collection}'`);

    if (i + BATCH_SIZE < documents.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return written;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Main import function
// ─────────────────────────────────────────────────────────────────────────────
const importSheet = async (sheetName, filePath) => {
  const config = SHEET_CONFIG[sheetName];
  if (!config) {
    throw new Error(
      `Unknown sheet: '${sheetName}'. Valid options: ${Object.keys(SHEET_CONFIG).join(', ')}`
    );
  }

  logger.info(`[Importer] Starting import: sheet='${sheetName}', file='${filePath}'`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.getWorksheet(sheetName);

  if (!worksheet) {
    const available = workbook.worksheets.map(ws => ws.name).join(', ');
    throw new Error(`Sheet '${sheetName}' not found in workbook. Available: ${available}`);
  }

  // ExcelJS uses 1-based rows; row 1 is the header row
  const headerRow  = worksheet.getRow(1).values.slice(1); // slice(1) removes leading undefined
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const obj = {};
    row.values.slice(1).forEach((val, i) => {
      const key = headerRow[i];
      if (key) obj[key] = val ?? null;
    });
    rows.push(obj);
  });
  logger.info(`[Importer] Parsed ${rows.length} rows from sheet '${sheetName}'`);

  if (rows.length === 0) {
    logger.warn('[Importer] No rows found in sheet — nothing to import');
    return;
  }

  let documents;

  // Grouped sheets (multiple rows per document, e.g., salaryBands)
  if (config.groupByField) {
    const grouped = {};
    rows.forEach(row => {
      const groupKey = row[config.groupByField];
      if (!grouped[groupKey]) grouped[groupKey] = [];
      grouped[groupKey].push(row);
    });

    documents = Object.entries(grouped).map(([key, groupRows]) => ({
      id:   key,
      data: config.transform(groupRows, key),
    }));
  } else {
    // One row per document
    documents = rows.map(row => {
      const id = row[config.idField];
      if (!id) {
        logger.warn('[Importer] Row missing ID field, skipping:', row);
        return null;
      }
      return { id, data: config.transform(row) };
    }).filter(Boolean);
  }

  logger.info(`[Importer] Prepared ${documents.length} documents for collection '${config.collection}'`);

  const written = await batchWrite(config.collection, documents);
  logger.info(`[Importer] ✅ Import complete: ${written} documents written to '${config.collection}'`);
};

// ─────────────────────────────────────────────────────────────────────────────
//  CLI entry point
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args      = process.argv.slice(2);
  const sheetIdx  = args.indexOf('--sheet');
  const fileIdx   = args.indexOf('--file');

  const sheetName = sheetIdx !== -1 ? args[sheetIdx + 1] : null;
  const filePath  = fileIdx  !== -1 ? args[fileIdx  + 1] : null;

  if (!sheetName || !filePath) {
    console.error('Usage: node excelImporter.js --sheet <sheetName> --file <path>');
    console.error('Valid sheets:', Object.keys(SHEET_CONFIG).join(', '));
    process.exit(1);
  }

  importSheet(sheetName, filePath)
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('[Importer] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { importSheet };








