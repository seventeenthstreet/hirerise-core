'use strict';

/**
 * migrations/add-education-intelligence.migration.js
 *
 * Validates Firestore access to all five Education Intelligence collections
 * and prints the indexes that must be added to firestore.indexes.json.
 *
 * Usage:
 *   node src/migrations/add-education-intelligence.migration.js --dry-run
 *   node src/migrations/add-education-intelligence.migration.js --run
 */

require('dotenv').config();
require('../config/supabase'); // initializes Supabase client

const { db }         = require('../config/supabase');
const { FieldValue } = require('../config/supabase');

const DRY_RUN  = process.argv.includes('--dry-run');
const LIVE_RUN = process.argv.includes('--run');

const COLLECTIONS = [
  'edu_students',
  'edu_academic_records',
  'edu_extracurricular',
  'edu_cognitive_results',
  'edu_stream_scores',
];

/**
 * Recommended Firestore composite indexes.
 * Add these objects to the "indexes" array in firestore.indexes.json
 * then run: firebase deploy --only firestore:indexes
 */
const INDEXES = [
  {
    _comment:        'Academic records per student, ordered by class level',
    collectionGroup: 'edu_academic_records',
    queryScope:      'COLLECTION',
    fields: [
      { fieldPath: 'student_id',  order: 'ASCENDING' },
      { fieldPath: 'class_level', order: 'ASCENDING' },
    ],
  },
  {
    _comment:        'Activities per student',
    collectionGroup: 'edu_extracurricular',
    queryScope:      'COLLECTION',
    fields: [
      { fieldPath: 'student_id',     order: 'ASCENDING' },
      { fieldPath: 'activity_level', order: 'ASCENDING' },
    ],
  },
  {
    _comment:        'Students by education level (admin analytics)',
    collectionGroup: 'edu_students',
    queryScope:      'COLLECTION',
    fields: [
      { fieldPath: 'education_level', order: 'ASCENDING' },
      { fieldPath: 'created_at',      order: 'DESCENDING' },
    ],
  },
  {
    _comment:        'Students by onboarding step (funnel analytics)',
    collectionGroup: 'edu_students',
    queryScope:      'COLLECTION',
    fields: [
      { fieldPath: 'onboarding_step', order: 'ASCENDING' },
      { fieldPath: 'created_at',      order: 'DESCENDING' },
    ],
  },
];

async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error('Usage: node migration.js [--dry-run | --run]');
    process.exit(1);
  }

  console.log('\n📚  Education Intelligence — Database Migration');
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}\n`);

  if (DRY_RUN) {
    console.log('Collections that will be used:');
    COLLECTIONS.forEach(c => console.log(`  ✦  ${c}`));

    console.log('\nIndexes to add to firestore.indexes.json:');
    INDEXES.forEach(idx => {
      console.log(`\n  // ${idx._comment}`);
      console.log(`  Collection: ${idx.collectionGroup}`);
      idx.fields.forEach(f => console.log(`    - ${f.fieldPath} (${f.order})`));
    });

    console.log('\n✅  Dry run complete — no writes performed.\n');
    return;
  }

  // Live run: write and delete a sentinel doc in each collection
  console.log('Validating Firestore collection access...\n');

  for (const colName of COLLECTIONS) {
    try {
      const ref = db.collection(colName).doc('__migration_probe__');
      await ref.set({ ok: true, at: FieldValue.serverTimestamp() });
      await ref.delete();
      console.log(`  ✅  ${colName}`);
    } catch (err) {
      console.error(`  ❌  ${colName} — ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅  All collections accessible.');
  console.log('\n📋  Next: add the indexes above to firestore.indexes.json then run:');
  console.log('    firebase deploy --only firestore:indexes\n');
}

main().catch(err => {
  console.error('\n❌  Migration failed:', err);
  process.exit(1);
});










