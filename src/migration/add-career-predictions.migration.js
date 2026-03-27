'use strict';

/**
 * migrations/add-career-predictions.migration.js
 *
 * Validates Supabase table access for the edu_career_predictions table
 * and documents the composite indexes required.
 *
 * Usage:
 *   node src/migration/add-career-predictions.migration.js --dry-run
 *   node src/migration/add-career-predictions.migration.js --run
 *
 * Table: edu_career_predictions
 *   id                  — auto-generated UUID (primary key)
 *   student_id          — string (user ID)
 *   career_name         — string (e.g. "Software Engineer")
 *   success_probability — number 0–100
 *   created_at          — timestamp
 */
require('dotenv').config();
require('../config/supabase');
const { supabase } = require('../config/supabase');

const DRY_RUN = process.argv.includes('--dry-run');
const LIVE_RUN = process.argv.includes('--run');
const NEW_COLLECTION = 'edu_career_predictions';

/**
 * Required Supabase composite indexes.
 * Run these in the Supabase SQL editor:
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_career_predictions_student_prob
 *     ON edu_career_predictions (student_id ASC, success_probability DESC);
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_career_predictions_student_created
 *     ON edu_career_predictions (student_id ASC, created_at DESC);
 */
const INDEXES = [
  {
    _comment: 'Career predictions per student, ranked by probability',
    table: 'edu_career_predictions',
    fields: [
      { fieldPath: 'student_id', order: 'ASCENDING' },
      { fieldPath: 'success_probability', order: 'DESCENDING' }
    ]
  },
  {
    _comment: 'Career predictions per student, by created_at (history)',
    table: 'edu_career_predictions',
    fields: [
      { fieldPath: 'student_id', order: 'ASCENDING' },
      { fieldPath: 'created_at', order: 'DESCENDING' }
    ]
  }
];

/**
 * Supabase RLS policy addition (run in Supabase SQL editor):
 *
 *   ALTER TABLE edu_career_predictions ENABLE ROW LEVEL SECURITY;
 *
 *   CREATE POLICY "Students can read own predictions"
 *     ON edu_career_predictions FOR SELECT
 *     USING (auth.uid()::text = student_id);
 *
 *   -- Server-only writes: no INSERT/UPDATE/DELETE policy for authenticated users
 */

async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error('Usage: node migration.js [--dry-run | --run]');
    process.exit(1);
  }

  console.log('\n🎯  Career Predictions — Database Migration');
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}\n`);

  if (DRY_RUN) {
    console.log('New table:');
    console.log(`  ✦  ${NEW_COLLECTION}`);
    console.log('\n  Row shape:');
    console.log('    id                  — auto UUID');
    console.log('    student_id          — string (user ID)');
    console.log('    career_name         — string');
    console.log('    success_probability — number 0–100');
    console.log('    created_at          — timestamp');
    console.log('\nIndexes to add via Supabase SQL editor:');
    INDEXES.forEach(idx => {
      console.log(`\n  // ${idx._comment}`);
      console.log(`  Table: ${idx.table}`);
      idx.fields.forEach(f => console.log(`    - ${f.fieldPath} (${f.order})`));
    });
    console.log('\n✅  Dry run complete — no writes performed.\n');
    return;
  }

  // Live run: write a probe row then delete it to confirm table access
  console.log('Validating Supabase table access...\n');
  try {
    const { data: inserted, error: insertError } = await supabase
      .from(NEW_COLLECTION)
      .insert({
        student_id: '__probe__',
        career_name: '__probe__',
        success_probability: 0,
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (insertError) throw new Error(insertError.message);

    const { error: deleteError } = await supabase
      .from(NEW_COLLECTION)
      .delete()
      .eq('id', inserted.id);

    if (deleteError) throw new Error(deleteError.message);

    console.log(`  ✅  ${NEW_COLLECTION}`);
  } catch (err) {
    console.error(`  ❌  ${NEW_COLLECTION} — ${err.message}`);
    process.exit(1);
  }

  console.log('\n✅  Table accessible.');
  console.log('\n📋  Next steps:');
  console.log('  1. Add indexes above via Supabase SQL editor');
  console.log('  2. Add RLS policies via Supabase SQL editor');
  console.log('  3. Deploy application\n');
}

main().catch(err => {
  console.error('\n❌  Migration failed:', err);
  process.exit(1);
});