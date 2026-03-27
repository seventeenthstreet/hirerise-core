'use strict';

/**
 * migrations/add-education-intelligence.migration.js
 *
 * Validates Supabase table access to all five Education Intelligence tables
 * and prints the indexes that must be added via the Supabase SQL editor.
 *
 * Usage:
 *   node src/migrations/add-education-intelligence.migration.js --dry-run
 *   node src/migrations/add-education-intelligence.migration.js --run
 */
require('dotenv').config();
require('../config/supabase'); // initializes Supabase client

const { supabase } = require('../config/supabase');

const DRY_RUN = process.argv.includes('--dry-run');
const LIVE_RUN = process.argv.includes('--run');

const COLLECTIONS = [
  'edu_students',
  'edu_academic_records',
  'edu_extracurricular',
  'edu_cognitive_results',
  'edu_stream_scores'
];

/**
 * Recommended Supabase composite indexes.
 * Run these in the Supabase SQL editor:
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_academic_records_student_class
 *     ON edu_academic_records (student_id ASC, class_level ASC);
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_extracurricular_student_level
 *     ON edu_extracurricular (student_id ASC, activity_level ASC);
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_students_education_created
 *     ON edu_students (education_level ASC, created_at DESC);
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_students_onboarding_created
 *     ON edu_students (onboarding_step ASC, created_at DESC);
 */
const INDEXES = [
  {
    _comment: 'Academic records per student, ordered by class level',
    table: 'edu_academic_records',
    fields: [
      { fieldPath: 'student_id', order: 'ASCENDING' },
      { fieldPath: 'class_level', order: 'ASCENDING' }
    ]
  },
  {
    _comment: 'Activities per student',
    table: 'edu_extracurricular',
    fields: [
      { fieldPath: 'student_id', order: 'ASCENDING' },
      { fieldPath: 'activity_level', order: 'ASCENDING' }
    ]
  },
  {
    _comment: 'Students by education level (admin analytics)',
    table: 'edu_students',
    fields: [
      { fieldPath: 'education_level', order: 'ASCENDING' },
      { fieldPath: 'created_at', order: 'DESCENDING' }
    ]
  },
  {
    _comment: 'Students by onboarding step (funnel analytics)',
    table: 'edu_students',
    fields: [
      { fieldPath: 'onboarding_step', order: 'ASCENDING' },
      { fieldPath: 'created_at', order: 'DESCENDING' }
    ]
  }
];

async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error('Usage: node migration.js [--dry-run | --run]');
    process.exit(1);
  }

  console.log('\n📚  Education Intelligence — Database Migration');
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}\n`);

  if (DRY_RUN) {
    console.log('Tables that will be used:');
    COLLECTIONS.forEach(c => console.log(`  ✦  ${c}`));
    console.log('\nIndexes to add via Supabase SQL editor:');
    INDEXES.forEach(idx => {
      console.log(`\n  // ${idx._comment}`);
      console.log(`  Table: ${idx.table}`);
      idx.fields.forEach(f => console.log(`    - ${f.fieldPath} (${f.order})`));
    });
    console.log('\n✅  Dry run complete — no writes performed.\n');
    return;
  }

  // Live run: write and delete a probe row in each table to confirm access
  console.log('Validating Supabase table access...\n');
  for (const colName of COLLECTIONS) {
    try {
      const { data: inserted, error: insertError } = await supabase
        .from(colName)
        .insert({
          ok: true,
          at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (insertError) throw new Error(insertError.message);

      const { error: deleteError } = await supabase
        .from(colName)
        .delete()
        .eq('id', inserted.id);

      if (deleteError) throw new Error(deleteError.message);

      console.log(`  ✅  ${colName}`);
    } catch (err) {
      console.error(`  ❌  ${colName} — ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅  All tables accessible.');
  console.log('\n📋  Next: add the indexes above via Supabase SQL editor\n');
}

main().catch(err => {
  console.error('\n❌  Migration failed:', err);
  process.exit(1);
});