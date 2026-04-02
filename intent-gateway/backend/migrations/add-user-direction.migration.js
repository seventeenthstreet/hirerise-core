'use strict';

/**
 * migrations/add-user-direction.migration.js
 *
 * FINAL FIXED VERSION (Supabase Safe)
 *
 * Usage:
 *   node migrations/add-user-direction.migration.js --dry-run
 *   node migrations/add-user-direction.migration.js --run
 */

import { createClient } from '@supabase/supabase-js';

// ─── ENV ─────────────────────────────────────────────

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ✅ MUST be service role
);

// ─── Flags ───────────────────────────────────────────

const DRY_RUN  = process.argv.includes('--dry-run');
const LIVE_RUN = process.argv.includes('--run');

// ─── Main ────────────────────────────────────────────

async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error('Usage: node migration.js [--dry-run | --run]');
    process.exit(1);
  }

  console.log('\n🗂 Supabase Migration: add user_direction\n');

  if (DRY_RUN) {
    await verifyUsers();
    return;
  }

  if (LIVE_RUN) {
    await runMigration();
  }
}

// ─── Verify ──────────────────────────────────────────

async function verifyUsers() {
  console.log('🔍 Fetching sample users...\n');

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, user_direction')
    .limit(5);

  if (error) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }

  console.table(data || []);
  console.log('\n✅ Dry run complete.\n');
}

// ─── Migration ───────────────────────────────────────

async function runMigration() {
  console.log('📦 Running migration...\n');

  // ⚠️ IMPORTANT: Supabase JS CANNOT run ALTER TABLE directly
  console.log(`
⚠️ ACTION REQUIRED:

Run this SQL in Supabase SQL Editor:

----------------------------------------
ALTER TABLE users
ADD COLUMN IF NOT EXISTS user_direction TEXT;
----------------------------------------
`);

  console.log('⏳ Waiting 10 seconds before continuing...\n');
  await new Promise(r => setTimeout(r, 10000));

  // Optional backfill (only if needed)
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      updated_at: new Date().toISOString(),
    })
    .is('user_direction', null);

  if (error) {
    console.error('❌ Backfill failed:', error.message);
    process.exit(1);
  }

  console.log('✅ Migration completed.\n');
}

// ─── Run ─────────────────────────────────────────────

main().catch(err => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});