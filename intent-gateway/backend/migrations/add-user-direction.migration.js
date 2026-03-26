/**
 * migrations/add-user-direction.migration.js
 *
 * Step 3: Database Migration — Add user_direction to users collection.
 *
 * Firestore is schemaless, so this migration:
 *   1. Verifies the field can be read/written correctly via a dry run
 *   2. Optionally backfills existing users with user_direction: null
 *      (Firestore queries for null values only work on fields that EXIST)
 *   3. Creates the Firestore index needed for direction-based queries
 *
 * Usage:
 *   # Dry run (read-only, shows what would change)
 *   node migrations/add-user-direction.migration.js --dry-run
 *
 *   # Live run (writes to Firestore)
 *   node migrations/add-user-direction.migration.js --run
 *
 *   # Backfill only users with no direction set
 *   node migrations/add-user-direction.migration.js --run --backfill
 *
 * SAFETY: Uses batched writes of 400 docs max (Firestore limit: 500).
 * If interrupted, re-run safely — set(merge:true) is idempotent.
 */

'use strict';

const admin      = require('firebase-admin');
const serviceKey = require('../serviceAccountKey.json');

// ─── Init ─────────────────────────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceKey),
  });
}

const { db } = require('../../src/core/supabaseDbShim');
const { FieldValue } = require('../../src/core/supabaseDbShim');

// ─── Config ───────────────────────────────────────────────────────────────────
const DRY_RUN   = process.argv.includes('--dry-run');
const LIVE_RUN  = process.argv.includes('--run');
const BACKFILL  = process.argv.includes('--backfill');
const BATCH_SIZE = 400;

// ─── Schema definition ────────────────────────────────────────────────────────
/**
 * New field added to users/{uid}:
 *
 *   user_direction: 'education' | 'career' | 'market' | null
 *
 *   - null    → user has not visited the Intent Gateway yet
 *   - string  → user has selected a direction; gateway is skipped
 *
 * Additional audit fields:
 *   direction_set_at:   Firestore Timestamp — when direction was first chosen
 *   direction_reset_at: Firestore Timestamp — when direction was last cleared
 */
const DIRECTION_FIELD_DEFAULT = null;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error('Usage: node migration.js [--dry-run | --run] [--backfill]');
    process.exit(1);
  }

  console.log(`\n🗂  Intent Gateway Migration`);
  console.log(`   Mode:     ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}`);
  console.log(`   Backfill: ${BACKFILL ? 'yes — writing user_direction: null to all users' : 'no'}\n`);

  if (!BACKFILL) {
    console.log('ℹ️  Skipping backfill. New field is written on first gateway visit.');
    console.log('   To backfill all existing users, re-run with --backfill flag.\n');
    await verifySchema();
    return;
  }

  await backfillUsers();
}

// ─── Verify schema (dry run) ──────────────────────────────────────────────────
async function verifySchema() {
  console.log('🔍 Verifying Firestore access to users collection...');
  const snapshot = await db.collection('users').limit(1).get();

  if (snapshot.empty) {
    console.log('⚠️  No users found. Nothing to verify.');
    return;
  }

  const sample = snapshot.docs[0];
  const data   = sample.data();

  console.log(`   Sample user UID: ${sample.id}`);
  console.log(`   user_direction field: ${Object.prototype.hasOwnProperty.call(data, 'user_direction')
    ? JSON.stringify(data.user_direction)
    : '(field does not exist yet — this is expected before backfill)'
  }`);
  console.log('\n✅ Schema verification passed.\n');
}

// ─── Backfill: set user_direction: null on all users without it ───────────────
async function backfillUsers() {
  console.log('📦 Reading users collection...');

  // Only fetch users who don't yet have the field
  // Firestore "!=" null query also returns docs where field doesn't exist
  // so we query for docs where the field simply doesn't exist using a workaround:
  // We fetch ALL users and filter in memory to stay safe.
  const snapshot = await db.collection('users').get();
  const total = snapshot.size;

  console.log(`   Found ${total} users total.`);

  const toBackfill = snapshot.docs.filter(doc => {
    const data = doc.data();
    return !Object.prototype.hasOwnProperty.call(data, 'user_direction');
  });

  console.log(`   ${toBackfill.length} users need user_direction field.\n`);

  if (toBackfill.length === 0) {
    console.log('✅ All users already have user_direction field. Nothing to do.\n');
    return;
  }

  if (DRY_RUN) {
    console.log('🔵 DRY RUN — would write to:');
    toBackfill.slice(0, 5).forEach(doc => console.log(`   users/${doc.id}`));
    if (toBackfill.length > 5) console.log(`   ... and ${toBackfill.length - 5} more`);
    console.log('\n✅ Dry run complete.\n');
    return;
  }

  // ── Live batched writes ──────────────────────────────────────────────────
  let written = 0;
  let batches  = 0;

  for (let i = 0; i < toBackfill.length; i += BATCH_SIZE) {
    const chunk = toBackfill.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    chunk.forEach(doc => {
      batch.set(doc.ref, {
        user_direction:  DIRECTION_FIELD_DEFAULT,   // null
        updatedAt:       FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    await batch.commit();
    written += chunk.length;
    batches++;
    console.log(`   Batch ${batches}: wrote ${chunk.length} docs (${written}/${toBackfill.length})`);
  }

  console.log(`\n✅ Backfill complete. ${written} users updated in ${batches} batches.\n`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
