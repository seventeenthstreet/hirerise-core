'use strict';

/**
 * migration/add-education-roi.migration.js
 *
 * Required Firestore composite indexes:
 *   Collection: edu_education_roi
 *   Index 1: student_id ASC, roi_score DESC
 *   Index 2: student_id ASC, created_at DESC
 *
 * Usage:
 *   node src/migration/add-education-roi.migration.js --dry-run
 *   node src/migration/add-education-roi.migration.js --run
 */

require('dotenv').config();
require('../config/supabase');

const { db }         = require('../config/supabase');
const { FieldValue } = require('../config/supabase');

const COLLECTION = 'edu_education_roi';
const DRY_RUN    = !process.argv.includes('--run');

async function run(dryRun = true) {
  console.log(`\n📊  Education ROI — Database Migration`);
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
  console.log('  1. Collection: edu_education_roi');
  console.log('     Fields:     student_id ASC, roi_score DESC');
  console.log('  2. Collection: edu_education_roi');
  console.log('     Fields:     student_id ASC, created_at DESC\n');

  if (dryRun) {
    console.log('🔍  DRY RUN complete. No writes performed.');
    return;
  }

  const sentinelRef = db.collection(COLLECTION).doc('_migration_sentinel');
  await sentinelRef.set({
    _type:      'migration_sentinel',
    _migration: 'add-education-roi',
    created_at: FieldValue.serverTimestamp(),
  });
  console.log('✅  Sentinel document written to edu_education_roi.');
  console.log('\n📋  Next steps:');
  console.log('  1. Add indexes above to firestore.indexes.json');
  console.log('  2. Deploy: firebase deploy --only firestore:indexes');
}

run(DRY_RUN)
  .then(() => process.exit(0))
  .catch(err => { console.error('[Migration] Error:', err); process.exit(1); });










