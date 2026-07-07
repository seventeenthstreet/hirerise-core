'use strict';

/**
 * migration/add-career-simulations.migration.js
 *
 * Required Supabase composite indexes:
 *   Table: edu_career_simulations
 *   Index 1: student_id ASC, salary_10_year DESC
 *   Index 2: student_id ASC, created_at DESC
 *
 * Run these in the Supabase SQL editor:
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_career_simulations_student_salary
 *     ON edu_career_simulations (student_id ASC, salary_10_year DESC);
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_career_simulations_student_created
 *     ON edu_career_simulations (student_id ASC, created_at DESC);
 *
 * Usage:
 *   node src/migration/add-career-simulations.migration.js --dry-run
 *   node src/migration/add-career-simulations.migration.js --run
 */
require('dotenv').config();
require('../config/supabase');
const { supabase } = require('../config/supabase');

const COLLECTION = 'edu_career_simulations';
const DRY_RUN = !process.argv.includes('--run');

async function run(dryRun = true) {
  console.log(`\n🤖  Career Simulations — Database Migration`);
  console.log(`    Mode: ${dryRun ? 'DRY RUN' : 'LIVE RUN'}\n`);
  console.log('Validating Supabase table access...');

  try {
    // Insert a probe row then delete it to confirm table access
    const { data: inserted, error: insertError } = await supabase
      .from(COLLECTION)
      .insert({
        _probe: true,
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (insertError) throw new Error(insertError.message);

    const { error: deleteError } = await supabase
      .from(COLLECTION)
      .delete()
      .eq('id', inserted.id);

    if (deleteError) throw new Error(deleteError.message);

    console.log(`  ✅  ${COLLECTION}`);
  } catch (err) {
    console.error(`  ❌  ${COLLECTION} — ${err.message}`);
    process.exit(1);
  }

  console.log('✅  Table accessible.\n');
  console.log('📋  Required Supabase composite indexes:');
  console.log('  1. Table: edu_career_simulations');
  console.log('     Fields: student_id ASC, salary_10_year DESC');
  console.log('  2. Table: edu_career_simulations');
  console.log('     Fields: student_id ASC, created_at DESC\n');

  if (dryRun) {
    console.log('🔍  DRY RUN complete. No sentinel writes performed.');
    return;
  }

  // Write sentinel row to confirm live write capability
  const { error: sentinelError } = await supabase
    .from(COLLECTION)
    .upsert({
      id: '_migration_sentinel',
      _type: 'migration_sentinel',
      _migration: 'add-career-simulations',
      created_at: new Date().toISOString()
    });

  if (sentinelError) {
    console.error(`  ❌  Failed to write sentinel: ${sentinelError.message}`);
    process.exit(1);
  }

  console.log('✅  Sentinel row upserted to edu_career_simulations.');
  console.log('\n📋  Next steps:');
  console.log('  1. Add indexes above via Supabase SQL editor');
  console.log('  2. Deploy: apply application migrations');
}

run(DRY_RUN).then(() => process.exit(0)).catch(err => {
  console.error('[Migration] Error:', err);
  process.exit(1);
});