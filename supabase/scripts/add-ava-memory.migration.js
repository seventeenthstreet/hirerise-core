'use strict';

/**
 * add-ava-memory.migration.js — Supabase Production Version
 *
 * Creates the ava_memory table (stateful AI memory layer)
 *
 * Usage:
 *   Dry run:
 *     node add-ava-memory.migration.js
 *
 *   Execute:
 *     node add-ava-memory.migration.js --run
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase Client ──────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

// ─── SQL (FINAL PRODUCTION DDL) ───────────────────────────────────────────────

const SQL = `
-- Enable required extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================
-- TABLE: ava_memory
-- =============================================================

CREATE TABLE IF NOT EXISTS ava_memory (
  user_id TEXT PRIMARY KEY,

  last_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  current_score NUMERIC(5,2) NOT NULL DEFAULT 0,

  skills_added INTEGER NOT NULL DEFAULT 0,
  jobs_applied INTEGER NOT NULL DEFAULT 0,
  resume_improved BOOLEAN NOT NULL DEFAULT FALSE,

  last_active_date TIMESTAMPTZ DEFAULT NOW(),
  last_skill_added_at TIMESTAMPTZ,
  last_resume_update TIMESTAMPTZ,

  weekly_progress NUMERIC(5,2) NOT NULL DEFAULT 0,
  weekly_skills_added INTEGER NOT NULL DEFAULT 0,
  weekly_jobs_applied INTEGER NOT NULL DEFAULT 0,
  week_start_date TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS ava_memory_week_idx
  ON ava_memory (week_start_date);

CREATE INDEX IF NOT EXISTS ava_memory_activity_idx
  ON ava_memory (last_active_date DESC, jobs_applied DESC);

CREATE INDEX IF NOT EXISTS ava_memory_perf_idx
  ON ava_memory (current_score DESC, weekly_progress DESC);

-- ─── Trigger (reuse global if exists) ──────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'trigger_set_updated_at'
  ) THEN
    CREATE OR REPLACE FUNCTION trigger_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS ava_memory_updated_at_trigger ON ava_memory;

CREATE TRIGGER ava_memory_updated_at_trigger
BEFORE UPDATE ON ava_memory
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────

ALTER TABLE ava_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "ava_memory_user_access"
ON ava_memory
FOR ALL
TO authenticated
USING (user_id = auth.uid()::TEXT)
WITH CHECK (user_id = auth.uid()::TEXT);

CREATE POLICY IF NOT EXISTS "ava_memory_service_access"
ON ava_memory
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
`;

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run(dryRun = true) {
  console.log('\n🧠 Ava Memory Migration');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTION'}\n`);

  console.log('--- SQL ---\n');
  console.log(SQL);
  console.log('\n-----------\n');

  if (dryRun) {
    console.log('✔ Dry run complete. Use --run to execute.\n');
    return;
  }

  const supabase = getSupabase();

  console.log('⚠️ Supabase JS cannot execute raw DDL directly.');
  console.log('👉 Please copy the SQL above and run it in Supabase SQL Editor.\n');

  console.log('✔ Migration ready.\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const shouldRun = process.argv.includes('--run');

run(!shouldRun).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});