'use strict';

/**
 * seed-job-database.js — SUPABASE VERSION (NO FIREBASE)
 */

require('dotenv').config();

const path  = require('path');
const fs    = require('fs');
const XLSX  = require('exceljs');
const { supabase } = require('../src/config/supabase');

// ─────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────
const args  = process.argv.slice(2);
const WRITE = args.includes('--write');

const fileArg = args.find(a => a.startsWith('--file='));
const EXCEL_PATH = fileArg
  ? path.resolve(fileArg.replace('--file=', ''))
  : path.resolve(__dirname, '../data/HireRise_Job_Database_Template.xlsx');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function splitPipe(val) {
  if (!val) return [];
  return String(val).split('|').map(s => s.trim()).filter(Boolean);
}

function readSheet(workbook, sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];

  const headers = [];
  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell((cell, col) => {
        headers[col] = String(cell.value ?? '');
      });
    } else {
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (headers[col]) obj[headers[col]] = cell.value ?? null;
      });
      rows.push(obj);
    }
  });

  return rows;
}

// ─────────────────────────────────────────────
// GENERIC UPSERT
// ─────────────────────────────────────────────

async function upsertTable(table, rows, idField = 'id') {
  if (!WRITE) {
    console.log(`🔍 DRY RUN → ${table}: ${rows.length} rows`);
    return;
  }

  const { error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: idField });

  if (error) {
    console.error(`❌ Failed to insert into ${table}:`, error.message);
    throw error;
  }

  console.log(`✅ ${table}: ${rows.length} rows inserted`);
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  console.log('🚀 Seeding job database (Supabase)...');

  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`Excel file not found: ${EXCEL_PATH}`);
  }

  const workbook = new XLSX.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);

  const jobFamilies = readSheet(workbook, 'job_families').map(r => ({
    id: r.job_family_id,
    name: r.job_family_name,
    sector: r.sector,
    description: r.description,
    soft_deleted: false,
  }));

  const jobRoles = readSheet(workbook, 'job_roles').map(r => ({
    id: r.job_role_id,
    title: r.job_title,
    job_family_id: r.job_family_id,
    description: r.description,
  }));

  const salaryBands = readSheet(workbook, 'salary_bands_india').map(r => ({
    role_id: r.job_role_id,
    level: r.level,
    min_salary: r.min_salary_lpa,
    max_salary: r.max_salary_lpa,
  }));

  await upsertTable('job_families', jobFamilies);
  await upsertTable('job_roles', jobRoles);
  await upsertTable('salary_bands', salaryBands);

  console.log('🎉 Seeding complete');
}

main().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});