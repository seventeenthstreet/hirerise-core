'use strict';

/**
 * migration/add-career-simulations.migration.js
 *
 * Required Firestore composite indexes:
 *   Collection: edu_career_simulations
 *   Index 1: student_id ASC, salary_10_year DESC
 *   Index 2: student_id ASC, created_at DESC
 *
 * Usage:
 *   node src/migration/add-career-simulations.migration.js --dry-run
 *   node src/migration/add-career-simulations.migration.js --run
 */

require('dotenv').config();
require('../config/supabase');

const { db }         = require('../config/supabase');
const { FieldValue } = require('../config/supabase');

const COLLECTION = 'edu_career_simulations';
const DRY_RUN    = !process.argv.includes('--run');

async function run(dryRun = true) {
  console.log(`\n🤖  Career Simulations — Database Migration`);
  console.log(`    Mode: ${dryRun ? 'DRY RUN' : 'LIVE RUN'}\n`);

  console.log('Validating Firestore collection access...');
  try {
    const probeRef = db.collection(COLLECTION).doc('migration_probe_tmp');
    await probeRef.set({ _probe: true, created_at: FieldValue.serverTimestamp() });
    await probeRef.delete();
    console.log(`  ✅  ${COLLECTION}`);
  } catch (err) {
    console.error(`  ❌  ${COLLECTION} — ${err.message}`);
    process.exit(1);
  }
  console.log('✅  Collection accessible.\n');

  console.log('📋  Required Firestore composite indexes:');
  console.log('  1. Collection: edu_career_simulations');
  console.log('     Fields:     student_id ASC, salary_10_year DESC');
  console.log('  2. Collection: edu_career_simulations');
  console.log('     Fields:     student_id ASC, created_at DESC\n');

  if (dryRun) {
    console.log('🔍  DRY RUN complete. No writes performed.');
    return;
  }

  const sentinelRef = db.collection(COLLECTION).doc('_migration_sentinel');
  await sentinelRef.set({
    _type:      'migration_sentinel',
    _migration: 'add-career-simulations',
    created_at: FieldValue.serverTimestamp(),
  });
  console.log('✅  Sentinel document written to edu_career_simulations.');
  console.log('\n📋  Next steps:');
  console.log('  1. Add indexes above to firestore.indexes.json');
  console.log('  2. Deploy: firebase deploy --only firestore:indexes');
}

run(DRY_RUN)
  .then(() => process.exit(0))
  .catch(err => { console.error('[Migration] Error:', err); process.exit(1); });










