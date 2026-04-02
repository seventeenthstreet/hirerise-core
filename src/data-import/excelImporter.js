'use strict';

require('dotenv').config();
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 500;

/* ─────────────────────────────────────────────
   🔧 Utility: Batch Insert
───────────────────────────────────────────── */
async function batchInsert(table, rows, conflict = null) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);

    const query = supabase.from(table).upsert(chunk, {
      onConflict: conflict || undefined
    });

    const { error } = await query;
    if (error) {
      console.error(`❌ Error inserting into ${table}:`, error);
      throw error;
    }

    console.log(`✅ Inserted ${i + chunk.length}/${rows.length} into ${table}`);
  }
}

/* ─────────────────────────────────────────────
   🔧 Load Excel Sheet
───────────────────────────────────────────── */
async function loadSheet(filePath, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Sheet ${sheetName} not found`);

  const headers = sheet.getRow(1).values.slice(1);

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const obj = {};
    row.values.slice(1).forEach((val, i) => {
      obj[headers[i]] = val ?? null;
    });

    rows.push(obj);
  });

  return rows;
}

/* ─────────────────────────────────────────────
   🔥 Import Roles
───────────────────────────────────────────── */
async function importRoles(rows) {
  const formatted = rows.map(r => ({
    role_name: r.title,
    seniority_level: parseInt(r.level, 10),
    role_family: r.jobFamilyId,
    description: r.description || ''
  }));

  await batchInsert('roles', formatted, 'role_name');
}

/* ─────────────────────────────────────────────
   🔥 Import Skills
───────────────────────────────────────────── */
async function importSkills(rows) {
  const uniqueSkills = new Map();

  rows.forEach(r => {
    if (!uniqueSkills.has(r.skill)) {
      uniqueSkills.set(r.skill, {
        name: r.skill
      });
    }
  });

  await batchInsert('skills', Array.from(uniqueSkills.values()), 'name');
}

/* ─────────────────────────────────────────────
   🔥 Import Courses
───────────────────────────────────────────── */
async function importCourses(rows) {
  const uniqueCourses = new Map();

  rows.forEach(r => {
    if (!uniqueCourses.has(r.course_name)) {
      uniqueCourses.set(r.course_name, {
        name: r.course_name,
        provider: r.provider,
        level: r.level,
        duration_hours: parseInt(r.duration_hours || 0, 10),
        url: r.url
      });
    }
  });

  await batchInsert('courses', Array.from(uniqueCourses.values()), 'name');
}

/* ─────────────────────────────────────────────
   🔥 Build Mapping (Skill ↔ Course)
───────────────────────────────────────────── */
async function importSkillCourses(rows) {
  const { data: skills } = await supabase.from('skills').select('id, name');
  const { data: courses } = await supabase.from('courses').select('id, name');

  const skillMap = new Map(skills.map(s => [s.name, s.id]));
  const courseMap = new Map(courses.map(c => [c.name, c.id]));

  const mappings = [];

  rows.forEach(r => {
    const skillId = skillMap.get(r.skill);
    const courseId = courseMap.get(r.course_name);

    if (!skillId || !courseId) return;

    mappings.push({
      skill_id: skillId,
      course_id: courseId
    });
  });

  await batchInsert('skill_courses', mappings, 'skill_id,course_id');
}

/* ─────────────────────────────────────────────
   🔥 Import Career Paths
───────────────────────────────────────────── */
async function importCareerPaths(rows) {
  const { data: roles } = await supabase.from('roles').select('id, role_name');

  const roleMap = new Map(roles.map(r => [r.role_name, r.id]));

  const paths = [];

  rows.forEach(r => {
    const fromId = roleMap.get(r.from_role);
    const toId = roleMap.get(r.to_role);

    if (!fromId || !toId) return;

    paths.push({
      from_role_id: fromId,
      to_role_id: toId,
      years_to_next: parseInt(r.years_to_next, 10)
    });
  });

  await batchInsert('career_paths', paths, 'from_role_id,to_role_id');
}

/* ─────────────────────────────────────────────
   🚀 MAIN RUNNER
───────────────────────────────────────────── */
async function run({ file, sheet }) {
  console.log(`🚀 Importing ${sheet} from ${file}`);

  const rows = await loadSheet(file, sheet);

  switch (sheet) {
    case 'roles':
      await importRoles(rows);
      break;

    case 'skills':
      await importSkills(rows);
      break;

    case 'courses':
      await importCourses(rows);
      break;

    case 'skillCourses':
      await importSkillCourses(rows);
      break;

    case 'careerPaths':
      await importCareerPaths(rows);
      break;

    default:
      throw new Error(`Unsupported sheet: ${sheet}`);
  }

  console.log(`✅ Import completed: ${sheet}`);
}

/* ─────────────────────────────────────────────
   CLI
───────────────────────────────────────────── */
if (require.main === module) {
  const args = process.argv.slice(2);

  const file = args[args.indexOf('--file') + 1];
  const sheet = args[args.indexOf('--sheet') + 1];

  if (!file || !sheet) {
    console.error('Usage: node excelImporter.js --file <path> --sheet <sheet>');
    process.exit(1);
  }

  run({ file, sheet }).catch(err => {
    console.error('❌ Import failed:', err);
    process.exit(1);
  });
}

module.exports = { run };