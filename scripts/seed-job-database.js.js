'use strict';

/**
 * seed-job-database.js — PRODUCTION HARDENED (SUPABASE)
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { supabase } = require('../src/config/supabase');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');

const fileArg = args.find((a) => a.startsWith('--file='));

const EXCEL_PATH = fileArg
  ? path.resolve(fileArg.replace('--file=', ''))
  : path.resolve(
      __dirname,
      '../data/HireRise_Job_Database_Template.xlsx',
    );

function readSheet(workbook, sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];

  const headers = [];
  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell((cell, col) => {
        headers[col] = String(cell.value ?? '').trim();
      });
      return;
    }

    const obj = {};

    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      obj[key] = cell.value ?? null;
    });

    rows.push(obj);
  });

  return rows;
}

async function upsertTable(
  table,
  rows,
  conflictColumns,
) {
  if (!rows.length) {
    console.log(`ℹ️ ${table}: 0 rows skipped`);
    return;
  }

  if (!WRITE) {
    console.log(`🔍 DRY RUN → ${table}: ${rows.length} rows`);
    return;
  }

  const { error } = await supabase.from(table).upsert(rows, {
    onConflict: Array.isArray(conflictColumns)
      ? conflictColumns.join(',')
      : conflictColumns,
    returning: 'minimal',
  });

  if (error) {
    console.error(`❌ Failed to upsert ${table}`, {
      message: error.message,
      code: error.code,
      details: error.details,
    });
    throw error;
  }

  console.log(`✅ ${table}: ${rows.length} rows upserted`);
}

async function main() {
  console.log('🚀 Seeding job database (Supabase)...');

  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`Excel file not found: ${EXCEL_PATH}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);

  const jobFamilies = readSheet(workbook, 'job_families')
    .filter((r) => r.job_family_id)
    .map((r) => ({
      id: r.job_family_id,
      name: r.job_family_name ?? null,
      sector: r.sector ?? null,
      description: r.description ?? null,
      soft_deleted: false,
    }));

  const validFamilyIds = new Set(
    jobFamilies.map((r) => r.id),
  );

  const jobRoles = readSheet(workbook, 'job_roles')
    .filter(
      (r) =>
        r.job_role_id &&
        validFamilyIds.has(r.job_family_id),
    )
    .map((r) => ({
      id: r.job_role_id,
      title: r.job_title ?? null,
      job_family_id: r.job_family_id,
      description: r.description ?? null,
    }));

  const validRoleIds = new Set(jobRoles.map((r) => r.id));

  const salaryBands = readSheet(
    workbook,
    'salary_bands_india',
  )
    .filter(
      (r) =>
        r.job_role_id &&
        r.level &&
        validRoleIds.has(r.job_role_id),
    )
    .map((r) => ({
      role_id: r.job_role_id,
      level: r.level,
      min_salary: r.min_salary_lpa ?? null,
      max_salary: r.max_salary_lpa ?? null,
    }));

  await upsertTable('job_families', jobFamilies, 'id');
  await upsertTable('job_roles', jobRoles, 'id');
  await upsertTable(
    'salary_bands',
    salaryBands,
    ['role_id', 'level'],
  );

  console.log('🎉 Seeding complete');
}

main().catch((err) => {
  console.error('❌ Seed failed', {
    message: err?.message,
    stack: err?.stack,
  });

  process.exitCode = 1;
});