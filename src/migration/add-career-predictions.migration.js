'use strict';

/**
 * migrations/add-career-predictions.migration.js
 *
 * Validates Firestore access to the new edu_career_predictions collection
 * and documents the composite indexes required.
 *
 * Usage:
 *   node src/migration/add-career-predictions.migration.js --dry-run
 *   node src/migration/add-career-predictions.migration.js --run
 *
 * New collection:
 *   edu_career_predictions
 *     id                  — auto-generated Firestore doc ID
 *     student_id          — string (user ID)
 *     career_name         — string (e.g. "Software Engineer")
 *     success_probability — number 0–100
 *     created_at          — serverTimestamp
 */

require('dotenv').config();
require('../config/supabase');

const { db }         = require('../config/supabase');
const { FieldValue } = require('../config/supabase');

const DRY_RUN  = process.argv.includes('--dry-run');
const LIVE_RUN = process.argv.includes('--run');

const NEW_COLLECTION = 'edu_career_predictions';

/**
 * Required Firestore composite indexes.
 * Add to the "indexes" array in firestore.indexes.json, then run:
 *   firebase deploy --only firestore:indexes
 */
const INDEXES = [
  {
    _comment:        'Career predictions per student, ranked by probability',
    collectionGroup: 'edu_career_predictions',
    queryScope:      'COLLECTION',
    fields: [
      { fieldPath: 'student_id',          order: 'ASCENDING'  },
      { fieldPath: 'success_probability', order: 'DESCENDING' },
    ],
  },
  {
    _comment:        'Career predictions per student, by created_at (history)',
    collectionGroup: 'edu_career_predictions',
    queryScope:      'COLLECTION',
    fields: [
      { fieldPath: 'student_id', order: 'ASCENDING'  },
      { fieldPath: 'created_at', order: 'DESCENDING' },
    ],
  },
];

/**
 * Firestore security rule addition (merge into firestore.rules):
 *
 *   match /edu_career_predictions/{predictionId} {
 *     allow read:  if request.auth != null
 *                  && request.auth.uid == resource.data.student_id;
 *     allow write: if false; // server-only writes
 *   }
 */

async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error('Usage: node migration.js [--dry-run | --run]');
    process.exit(1);
  }

  console.log('\n🎯  Career Predictions — Database Migration');
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}\n`);

  if (DRY_RUN) {
    console.log('New collection:');
    console.log(`  ✦  ${NEW_COLLECTION}`);
    console.log('\n  Document shape:');
    console.log('    id                  — auto Firestore ID');
    console.log('    student_id          — string (user ID)');
    console.log('    career_name         — string');
    console.log('    success_probability — number 0–100');
    console.log('    created_at          — serverTimestamp');

    console.log('\nIndexes to add to firestore.indexes.json:');
    INDEXES.forEach(idx => {
      console.log(`\n  // ${idx._comment}`);
      console.log(`  Collection: ${idx.collectionGroup}`);
      idx.fields.forEach(f => console.log(`    - ${f.fieldPath} (${f.order})`));
    });

    console.log('\n✅  Dry run complete — no writes performed.\n');
    return;
  }

  // Live run: probe the collection
  console.log('Validating Firestore collection access...\n');
  try {
    const ref = db.collection(NEW_COLLECTION).doc('migration_probe_tmp');
    await ref.set({
      student_id:          '__probe__',
      career_name:         '__probe__',
      success_probability: 0,
      created_at:          FieldValue.serverTimestamp(),
    });
    await ref.delete();
    console.log(`  ✅  ${NEW_COLLECTION}`);
  } catch (err) {
    console.error(`  ❌  ${NEW_COLLECTION} — ${err.message}`);
    process.exit(1);
  }

  console.log('\n✅  Collection accessible.');
  console.log('\n📋  Next steps:');
  console.log('  1. Add indexes above to firestore.indexes.json');
  console.log('  2. Add security rules to firestore.rules');
  console.log('  3. Deploy: firebase deploy --only firestore\n');
}

main().catch(err => {
  console.error('\n❌  Migration failed:', err);
  process.exit(1);
});










