'use strict';

/**
 * seed-job-database.js
 *
 * Reads HireRise_Job_Database_Template.xlsx and seeds Firestore with:
 *   - jobFamilies
 *   - jobRoles
 *   - jobRoleLevels
 *   - salaryBands
 *   - careerProgression
 *   - relatedRoles
 *
 * Usage:
 *   node scripts/seed-job-database.js                          # dry-run
 *   node scripts/seed-job-database.js --write                  # write to Firestore
 *   node scripts/seed-job-database.js --write --file=path.xlsx # custom file path
 *
 * Prerequisites:
 *   npm install xlsx
 *   Set Firebase credentials in .env
 */

require('dotenv').config();

const path  = require('path');
const fs    = require('fs');
const admin = require('firebase-admin');
const XLSX  = require('exceljs'); // D-06 FIX: replaced xlsx (CVE-2023-30533) with exceljs

// ─────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const WRITE = args.includes('--write');
const MERGE = args.includes('--merge');

const fileArg = args.find(a => a.startsWith('--file='));
const EXCEL_PATH = fileArg
  ? path.resolve(fileArg.replace('--file=', ''))
  : path.resolve(__dirname, '../data/HireRise_Job_Database_Template.xlsx');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/** Parse pipe-separated string into array, or return empty array */
function splitPipe(val) {
  if (!val) return [];
  return String(val).split('|').map(s => s.trim()).filter(Boolean);
}

/** Read a sheet and return array of row objects keyed by header */
function readSheet(workbook, sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    console.warn(`  ⚠️  Sheet "${sheetName}" not found in workbook`);
    return [];
  }
  // ExcelJS: build row objects from header row + data rows (mirrors xlsx sheet_to_json defval:null).
  const headers = [];
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell((cell, col) => { headers[col] = String(cell.value ?? ''); });
    } else {
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (headers[col]) obj[headers[col]] = cell.value ?? null;
      });
      headers.forEach((h, i) => { if (h && !(h in obj)) obj[h] = null; });
      rows.push(obj);
    }
  });
  return rows;
}

// ─────────────────────────────────────────────────────────────
// TRANSFORMERS
// Each function takes raw Excel rows and returns
// { docId, data } pairs ready for Firestore
// ─────────────────────────────────────────────────────────────

function transformJobFamilies(rows) {
  return rows.map(row => ({
    docId: row.job_family_id,
    data: {
      id:          row.job_family_id,
      name:        row.job_family_name,
      sector:      row.sector       || null,
      description: row.description  || null,
      softDeleted: false,
    },
  }));
}

function transformJobRoles(rows) {
  return rows.map(row => ({
    docId: row.job_role_id,
    data: {
      id:              row.job_role_id,
      title:           row.job_title,
      alternateTitles: splitPipe(row.alternate_titles),
      jobFamilyId:     row.job_family_id,
      description:     row.description  || null,
      entryPaths:      splitPipe(row.entry_paths),
      softDeleted:     false,
    },
  }));
}

function transformJobRoleLevels(rows) {
  // Group by job_role_id so each role gets one doc with levels map
  const grouped = {};

  for (const row of rows) {
    const id = row.job_role_id;
    if (!grouped[id]) {
      grouped[id] = {
        docId: id,
        data: {
          roleId:      id,
          levels:      {},
          softDeleted: false,
        },
      };
    }

    grouped[id].data.levels[row.level] = {
      experienceYears:        row.experience_years      || null,
      minimumQualification:   row.minimum_qualification || null,
      allowedDegrees:         splitPipe(row.allowed_degrees),
      allowedDiplomas:        splitPipe(row.allowed_diplomas),
      preferredCertifications:splitPipe(row.preferred_certifications),
      coreSkills:             splitPipe(row.core_skills),
    };
  }

  return Object.values(grouped);
}

function transformSalaryBands(rows) {
  // Group by job_role_id so each role gets one doc with levels map
  const grouped = {};

  for (const row of rows) {
    const id = row.job_role_id;
    if (!grouped[id]) {
      grouped[id] = {
        docId: id,
        data: {
          roleId:      id,
          currency:    'INR',
          unit:        'LPA',
          levels:      {},
          softDeleted: false,
        },
      };
    }

    grouped[id].data.levels[row.level] = {
      min:          row.min_salary_lpa  ?? null,
      max:          row.max_salary_lpa  ?? null,
      confidence:   row.confidence      || null,
      lastReviewed: row.last_reviewed   || null,
    };
  }

  return Object.values(grouped);
}

function transformCareerProgression(rows) {
  // Group by job_role_id
  const grouped = {};

  for (const row of rows) {
    const id = row.job_role_id;
    if (!grouped[id]) {
      grouped[id] = {
        docId: id,
        data: {
          roleId:      id,
          nextRoles:   [],
          softDeleted: false,
        },
      };
    }
    if (row.next_role) {
      grouped[id].data.nextRoles.push(row.next_role);
    }
  }

  return Object.values(grouped);
}

function transformRelatedRoles(rows) {
  // Group by job_role_id
  const grouped = {};

  for (const row of rows) {
    const id = row.job_role_id;
    if (!grouped[id]) {
      grouped[id] = {
        docId: id,
        data: {
          roleId:       id,
          relatedRoles: [],
          softDeleted:  false,
        },
      };
    }
    if (row.related_role) {
      grouped[id].data.relatedRoles.push(row.related_role);
    }
  }

  return Object.values(grouped);
}

// ─────────────────────────────────────────────────────────────
// FIRESTORE WRITER
// ─────────────────────────────────────────────────────────────
async function seedCollection(db, collectionName, records) {
  console.log(`\n📦  ${collectionName} — ${records.length} documents`);

  const writeOpts = MERGE ? { merge: true } : {};

  for (const { docId, data } of records) {
    if (!docId) {
      console.warn(`  ⚠️  Skipping record with missing docId in ${collectionName}`);
      continue;
    }

    if (WRITE) {
      await db.collection(collectionName).doc(docId).set(data, writeOpts);
      console.log(`  ✅  ${docId}`);
    } else {
      console.log(`  🔍  [DRY-RUN] ${collectionName}/${docId}:`, JSON.stringify(data, null, 4));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────────────────────
function initAdmin() {
  if (admin.apps.length > 0) return;

  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const absPath    = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    const svcAccount = require(absPath);
    credential       = admin.credential.cert(svcAccount);
  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  } else {
    throw new Error(
      'No Firebase credentials found.\n' +
      'Set FIREBASE_SERVICE_ACCOUNT_PATH or ' +
      'FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in .env'
    );
  }

  admin.initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID });
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  HireRise — Job Database Seed Script');
  console.log(`  Mode  : ${WRITE ? (MERGE ? 'WRITE + MERGE' : 'WRITE (overwrite)') : 'DRY-RUN'}`);
  console.log(`  File  : ${EXCEL_PATH}`);
  console.log('═══════════════════════════════════════════════════════');

  // ── Validate Excel file exists ────────────────────────────
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`\n❌  Excel file not found: ${EXCEL_PATH}`);
    console.error('    Pass the correct path with --file=path/to/file.xlsx');
    process.exit(1);
  }

  if (!WRITE) {
    console.log('\n⚠️  Dry-run mode — pass --write to actually write to Firestore.\n');
  }

  // ── Read Excel ────────────────────────────────────────────
  console.log('\n📖  Reading Excel file...');
  const workbook = new XLSX.Workbook(); // D-06 FIX: ExcelJS uses async readFile
  await workbook.xlsx.readFile(EXCEL_PATH);
  const sheetNames = workbook.worksheets.map(ws => ws.name);
  console.log(`    Sheets found: ${sheetNames.join(', ')}`);

  // ── Transform all sheets ──────────────────────────────────
  const jobFamilies       = transformJobFamilies(readSheet(workbook, 'job_families'));
  const jobRoles          = transformJobRoles(readSheet(workbook, 'job_roles'));
  const jobRoleLevels     = transformJobRoleLevels(readSheet(workbook, 'job_role_levels'));
  const salaryBands       = transformSalaryBands(readSheet(workbook, 'salary_bands_india'));
  const careerProgression = transformCareerProgression(readSheet(workbook, 'career_progression'));
  const relatedRoles      = transformRelatedRoles(readSheet(workbook, 'related_roles'));

  // ── Init Firebase & seed ──────────────────────────────────
  initAdmin();
  const { db } = require('../src/core/supabaseDbShim');
  db.settings({ ignoreUndefinedProperties: true });

  await seedCollection(db, 'jobFamilies',       jobFamilies);
  await seedCollection(db, 'jobRoles',          jobRoles);
  await seedCollection(db, 'jobRoleLevels',     jobRoleLevels);
  await seedCollection(db, 'salaryBands',       salaryBands);
  await seedCollection(db, 'careerProgression', careerProgression);
  await seedCollection(db, 'relatedRoles',      relatedRoles);

  console.log('\n✨  Seed complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌  Seed failed:', err.message);
  process.exit(1);
});