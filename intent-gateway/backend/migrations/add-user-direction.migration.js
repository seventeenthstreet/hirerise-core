'use strict';

/**
 * migrations/add-user-direction.migration.js
 * ==================================================
 * Supabase-safe schema verification + optional controlled backfill
 *
 * Usage:
 *   node migrations/add-user-direction.migration.js --dry-run
 *   node migrations/add-user-direction.migration.js --run
 *   node migrations/add-user-direction.migration.js --run --default-direction=exploring
 *
 * IMPORTANT:
 * - Schema ALTER must already be executed:
 *     ALTER TABLE public.users
 *     ADD COLUMN IF NOT EXISTS user_direction TEXT;
 *
 * Behavior:
 * - Verifies column exists
 * - Dry-run previews sample users + NULL count
 * - Backfills ONLY when --default-direction=<value> is supplied
 * - Preserves NULLs safely otherwise
 * - Final validation is informational
 */

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────
// ENV VALIDATION
// ─────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
  );
  process.exit(1);
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

// ─────────────────────────────────────────────────────────────
// FLAGS
// ─────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const LIVE_RUN = process.argv.includes('--run');

const DEFAULT_DIRECTION = (() => {
  const arg = process.argv.find((a) =>
    a.startsWith('--default-direction=')
  );

  if (!arg) return null;

  const value = arg.split('=')[1]?.trim();
  return value || null;
})();

const BATCH_SIZE = 500;

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  if (!DRY_RUN && !LIVE_RUN) {
    console.error(
      'Usage: node migrations/add-user-direction.migration.js [--dry-run | --run] [--default-direction=<value>]'
    );
    process.exit(1);
  }

  console.log('\n🗂 Supabase Migration: add user_direction\n');

  if (DEFAULT_DIRECTION) {
    console.log(`📌 Backfill default = "${DEFAULT_DIRECTION}"`);
  } else {
    console.log(
      '📌 No default supplied — existing NULL values will remain unchanged.'
    );
  }

  await verifyColumnAvailability();

  if (DRY_RUN) {
    await previewUsers();
    console.log('\n✅ Dry run complete.\n');
    return;
  }

  if (DEFAULT_DIRECTION) {
    await runBackfill(DEFAULT_DIRECTION);
  } else {
    console.log('\n⏭ Skipping backfill by design.');
  }

  await validateMigration();

  console.log('\n✅ Migration completed successfully.\n');
}

// ─────────────────────────────────────────────────────────────
// VERIFY COLUMN EXISTS
// ─────────────────────────────────────────────────────────────

async function verifyColumnAvailability() {
  const { error } = await supabaseAdmin
    .from('users')
    .select('id, user_direction')
    .limit(1);

  if (error) {
    console.error(
      '\n❌ Column verification failed.\n' +
        'Run SQL first:\n' +
        'ALTER TABLE public.users ADD COLUMN IF NOT EXISTS user_direction TEXT;\n',
      error.message
    );
    process.exit(1);
  }

  console.log('✅ Column user_direction verified.');
}

// ─────────────────────────────────────────────────────────────
// DRY RUN PREVIEW
// ─────────────────────────────────────────────────────────────

async function previewUsers() {
  console.log('\n🔍 Sample users:\n');

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, user_direction, updated_at')
    .limit(5);

  if (error) {
    console.error('❌ Preview fetch failed:', error.message);
    process.exit(1);
  }

  console.table(data || []);

  const { count, error: countError } = await supabaseAdmin
    .from('users')
    .select('*', { count: 'exact', head: true })
    .is('user_direction', null);

  if (countError) {
    console.error('❌ NULL count failed:', countError.message);
    process.exit(1);
  }

  console.log(`\n📊 Existing NULL rows: ${count ?? 0}`);

  if ((count ?? 0) > 0 && !DEFAULT_DIRECTION) {
    console.log(
      'ℹ️ To populate them, rerun with --run --default-direction=<value>'
    );
  }
}

// ─────────────────────────────────────────────────────────────
// SAFE BATCHED BACKFILL
// IMPORTANT:
// Always fetch first N NULL rows.
// Do NOT use offset/range on mutating result sets.
// ─────────────────────────────────────────────────────────────

async function runBackfill(defaultDirection) {
  console.log(
    `\n📦 Running safe controlled backfill → "${defaultDirection}"...\n`
  );

  let processed = 0;

  while (true) {
    const { data: rows, error: fetchError } = await supabaseAdmin
      .from('users')
      .select('id')
      .is('user_direction', null)
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error('❌ Failed to fetch batch:', fetchError.message);
      process.exit(1);
    }

    if (!rows || rows.length === 0) {
      break;
    }

    const ids = rows.map((row) => row.id);

    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        user_direction: defaultDirection,
        updated_at: new Date().toISOString(),
      })
      .in('id', ids);

    if (updateError) {
      console.error('❌ Batch update failed:', updateError.message);
      process.exit(1);
    }

    processed += ids.length;
    console.log(`✅ Processed batch: ${processed} rows`);
  }

  console.log(`\n✅ Backfill complete. Total rows updated: ${processed}`);
}

// ─────────────────────────────────────────────────────────────
// FINAL VALIDATION
// NULLs remain valid if no default supplied
// ─────────────────────────────────────────────────────────────

async function validateMigration() {
  const { count, error } = await supabaseAdmin
    .from('users')
    .select('*', { count: 'exact', head: true })
    .is('user_direction', null);

  if (error) {
    console.error('❌ Validation failed:', error.message);
    process.exit(1);
  }

  const remaining = count ?? 0;

  if (remaining === 0) {
    console.log('🔎 Remaining NULL rows: 0');
  } else {
    console.log(`🔎 Remaining NULL rows: ${remaining}`);
    console.log(
      'ℹ️ NULLs are valid for legacy users unless a default was supplied.'
    );
  }
}

// ─────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});