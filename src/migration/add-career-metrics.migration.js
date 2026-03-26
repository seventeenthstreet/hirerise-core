'use strict';
/**
 * migration/add-career-metrics.migration.js
 *
 * Creates the career_metrics table — time-series composite career score storage.
 *
 * Usage:
 *   Dry run:  node src/migration/add-career-metrics.migration.js --dry-run
 *   Live run: node src/migration/add-career-metrics.migration.js --run
 *   Or paste SQL_DDL into the Supabase SQL Editor.
 */
require('dotenv').config();

const SQL_DDL = `
-- =============================================================
--  TABLE: career_metrics
--  Time-series snapshots of a user's composite career score.
--  One row per snapshot event (on login, on score change, weekly).
-- =============================================================

CREATE TABLE IF NOT EXISTS career_metrics (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT          NOT NULL,

  -- Composite score (0-100, weighted)
  composite        NUMERIC(5,2)  NOT NULL DEFAULT 0,

  -- Dimension scores (0-100 each)
  ats_score        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  job_match        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  interview_score  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  activity_score   NUMERIC(5,2)  NOT NULL DEFAULT 0,

  -- Context
  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index: fast user history lookups
CREATE INDEX IF NOT EXISTS idx_career_metrics_user_date
  ON career_metrics (user_id, recorded_at DESC);

-- RLS: users can only read their own rows
ALTER TABLE career_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "career_metrics_owner"
  ON career_metrics FOR ALL
  USING (user_id = auth.uid()::text);
`;

async function run() {
  const isDry = process.argv.includes('--dry-run');
  const isRun = process.argv.includes('--run');

  console.log('career_metrics migration DDL:\n');
  console.log(SQL_DDL);

  if (isDry) { console.log('\n[dry-run] No changes written.'); return; }
  if (!isRun) { console.log('\nPass --run to execute or --dry-run to preview.'); return; }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.rpc('exec_sql', { sql: SQL_DDL });
  if (error) { console.error('Migration failed:', error.message); process.exit(1); }
  console.log('career_metrics table created.');
}

run();








