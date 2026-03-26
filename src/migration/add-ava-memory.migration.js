'use strict';

/**
 * migration/add-ava-memory.migration.js
 *
 * Creates the ava_memory table — Ava's per-user retention engine.
 *
 * One row per user. Upserted on every meaningful career event.
 * Drives personalised summaries, reminders, and weekly progress reports.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *   Dry run (prints DDL, no DB writes):
 *     node src/migration/add-ava-memory.migration.js --dry-run
 *
 *   Live run:
 *     node src/migration/add-ava-memory.migration.js --run
 *
 *   Or paste SQL_DDL directly into the Supabase SQL Editor.
 */

require('dotenv').config();

// ─── DDL ──────────────────────────────────────────────────────────────────────

const SQL_DDL = `
-- =============================================================
--  TABLE: ava_memory
--  One row per user. Upserted on each career event.
--  Drives personalised Ava insights, reminders, and reports.
-- =============================================================

CREATE TABLE IF NOT EXISTS ava_memory (
  -- Identity
  user_id              TEXT          PRIMARY KEY,

  -- Score tracking (for delta calculations)
  last_score           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  current_score        NUMERIC(5,2)  NOT NULL DEFAULT 0,

  -- Event counters (reset each weekly cycle)
  skills_added         INTEGER       NOT NULL DEFAULT 0,
  jobs_applied         INTEGER       NOT NULL DEFAULT 0,
  resume_improved      BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Activity timestamps
  last_active_date     TIMESTAMPTZ,
  last_skill_added_at  TIMESTAMPTZ,
  last_resume_update   TIMESTAMPTZ,

  -- Weekly snapshot (written by updateWeeklyMemory cron)
  weekly_progress      NUMERIC(5,2)  NOT NULL DEFAULT 0,
  weekly_skills_added  INTEGER       NOT NULL DEFAULT 0,
  weekly_jobs_applied  INTEGER       NOT NULL DEFAULT 0,
  week_start_date      TIMESTAMPTZ,

  -- Lifecycle
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- For cron: fetch all rows due for weekly snapshot
CREATE INDEX IF NOT EXISTS ava_memory_week_start_idx
  ON ava_memory (week_start_date);

-- For recency queries
CREATE INDEX IF NOT EXISTS ava_memory_last_active_idx
  ON ava_memory (last_active_date DESC);

-- ── Auto-update updated_at ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_ava_memory_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ava_memory_updated_at_trigger ON ava_memory;
CREATE TRIGGER ava_memory_updated_at_trigger
  BEFORE UPDATE ON ava_memory
  FOR EACH ROW EXECUTE FUNCTION update_ava_memory_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────────────────

ALTER TABLE ava_memory ENABLE ROW LEVEL SECURITY;

-- Authenticated users can only read/write their own row
CREATE POLICY "ava_memory_owner_policy"
  ON ava_memory
  FOR ALL
  TO authenticated
  USING      (user_id = auth.uid()::TEXT)
  WITH CHECK (user_id = auth.uid()::TEXT);

-- Service role (backend) bypasses RLS
CREATE POLICY "ava_memory_service_role_policy"
  ON ava_memory
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);
`;

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run(dryRun = true) {
  console.log('\n🧠  Ava Memory System — Database Migration');
  console.log(`    Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE RUN'}\n`);

  console.log('─── SQL DDL ────────────────────────────────────────────────────');
  console.log(SQL_DDL);
  console.log('────────────────────────────────────────────────────────────────\n');

  if (dryRun) {
    console.log('🔍  DRY RUN complete. Re-run with --run to apply to Supabase.');
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.warn('⚠️   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
    console.log('    Copy the DDL above and paste it into the Supabase SQL Editor.\n');
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await client.rpc('exec_sql', { sql: SQL_DDL });
  if (error) {
    // Supabase doesn't expose exec_sql by default — print instructions
    console.warn('⚠️   Cannot run DDL via RPC. Paste the SQL above into the Supabase SQL Editor.');
    console.warn('    Error:', error.message);
  } else {
    console.log('✅  ava_memory table created successfully.\n');
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const dryRun = !process.argv.includes('--run');
run(dryRun).catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});








