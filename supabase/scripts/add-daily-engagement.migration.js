'use strict';

/**
 * migration/add-daily-engagement.migration.js
 *
 * Creates all three tables required by the Daily Engagement System:
 *
 *   1. daily_career_insights    — personalised daily feed items per user
 *   2. career_progress_history  — longitudinal CHI / skills / job-match snapshots
 *   3. career_alerts            — actionable, prioritised notification records
 *
 * Each table includes:
 *   - UUID primary key
 *   - Appropriate foreign-key-style user_id index
 *   - Row Level Security (authenticated users own their rows)
 *   - Service-role bypass policy for backend writes
 *   - GIN index on JSONB columns for payload querying
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   Dry run (prints DDL, no DB writes):
 *     node src/migration/add-daily-engagement.migration.js --dry-run
 *
 *   Live run:
 *     node src/migration/add-daily-engagement.migration.js --run
 */

require('dotenv').config();

// ─── DDL ──────────────────────────────────────────────────────────────────────

const SQL_DDL = `
-- ==============================================================
--  TABLE 1: daily_career_insights
--  Personalised insight feed items generated per user per day.
-- ==============================================================

CREATE TABLE IF NOT EXISTS daily_career_insights (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT          NOT NULL,

  -- Which type of insight this is
  insight_type    TEXT          NOT NULL
                  CHECK (insight_type IN (
                    'skill_demand',
                    'job_match',
                    'market_trend',
                    'opportunity_signal',
                    'risk_alert',
                    'salary_update'
                  )),

  title           TEXT          NOT NULL,
  description     TEXT          NOT NULL,

  -- Which engine produced the underlying data
  source_engine   TEXT          NOT NULL
                  CHECK (source_engine IN (
                    'labor_market_intelligence',
                    'opportunity_radar',
                    'job_matching',
                    'career_risk_predictor',
                    'skill_graph',
                    'career_digital_twin'
                  )),

  -- Optional structured payload for rich UI rendering
  payload         JSONB         NOT NULL DEFAULT '{}'::jsonb,

  -- Whether the user has viewed this insight
  is_read         BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Priority for feed ordering: 1 = highest
  priority        INTEGER       NOT NULL DEFAULT 3
                  CHECK (priority BETWEEN 1 AND 5),

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for daily_career_insights
CREATE INDEX IF NOT EXISTS idx_dci_user_created
  ON daily_career_insights (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dci_user_type
  ON daily_career_insights (user_id, insight_type);

CREATE INDEX IF NOT EXISTS idx_dci_unread
  ON daily_career_insights (user_id, is_read)
  WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS idx_dci_payload_gin
  ON daily_career_insights USING GIN (payload);

-- RLS
ALTER TABLE daily_career_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS dci_user_policy
  ON daily_career_insights FOR ALL TO authenticated
  USING      (user_id = auth.uid()::TEXT)
  WITH CHECK (user_id = auth.uid()::TEXT);

CREATE POLICY IF NOT EXISTS dci_service_policy
  ON daily_career_insights FOR ALL TO service_role
  USING (true);


-- ==============================================================
--  TABLE 2: career_progress_history
--  Longitudinal snapshots of user's career health metrics.
-- ==============================================================

CREATE TABLE IF NOT EXISTS career_progress_history (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT          NOT NULL,

  -- Core metric values at time of recording
  career_health_index   INTEGER       NOT NULL DEFAULT 0
                        CHECK (career_health_index BETWEEN 0 AND 100),

  skills_count          INTEGER       NOT NULL DEFAULT 0,

  job_match_score       INTEGER       NOT NULL DEFAULT 0
                        CHECK (job_match_score BETWEEN 0 AND 100),

  -- Change deltas vs previous snapshot (can be negative)
  chi_delta             INTEGER,
  skills_delta          INTEGER,
  job_match_delta       INTEGER,

  -- What triggered this snapshot
  trigger_event         TEXT          NOT NULL DEFAULT 'manual'
                        CHECK (trigger_event IN (
                          'cv_parsed',
                          'skill_gap_updated',
                          'new_job_match',
                          'market_trend_updated',
                          'opportunity_detected',
                          'manual',
                          'scheduled'
                        )),

  -- Full structured snapshot for detailed history view
  snapshot              JSONB         NOT NULL DEFAULT '{}'::jsonb,

  recorded_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for career_progress_history
CREATE INDEX IF NOT EXISTS idx_cph_user_recorded
  ON career_progress_history (user_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_cph_user_chi
  ON career_progress_history (user_id, career_health_index DESC);

CREATE INDEX IF NOT EXISTS idx_cph_trigger
  ON career_progress_history (user_id, trigger_event);

CREATE INDEX IF NOT EXISTS idx_cph_snapshot_gin
  ON career_progress_history USING GIN (snapshot);

-- RLS
ALTER TABLE career_progress_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS cph_user_policy
  ON career_progress_history FOR ALL TO authenticated
  USING      (user_id = auth.uid()::TEXT)
  WITH CHECK (user_id = auth.uid()::TEXT);

CREATE POLICY IF NOT EXISTS cph_service_policy
  ON career_progress_history FOR ALL TO service_role
  USING (true);


-- ==============================================================
--  TABLE 3: career_alerts
--  Actionable, prioritised alerts for the notification panel.
-- ==============================================================

CREATE TABLE IF NOT EXISTS career_alerts (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT          NOT NULL,

  -- Alert classification
  alert_type      TEXT          NOT NULL
                  CHECK (alert_type IN (
                    'job_match',
                    'skill_demand',
                    'career_opportunity',
                    'salary_trend',
                    'risk_warning',
                    'market_shift'
                  )),

  title           TEXT          NOT NULL,
  description     TEXT          NOT NULL,

  -- 1 = critical, 2 = high, 3 = medium, 4 = low, 5 = informational
  alert_priority  INTEGER       NOT NULL DEFAULT 3
                  CHECK (alert_priority BETWEEN 1 AND 5),

  -- Optional deep-link / CTA for the frontend
  action_url      TEXT,

  -- Optional structured data (match score, salary figure, etc.)
  payload         JSONB         NOT NULL DEFAULT '{}'::jsonb,

  -- Read / dismissed state
  is_read         BOOLEAN       NOT NULL DEFAULT FALSE,
  read_at         TIMESTAMPTZ,

  -- Deduplication: prevent the same alert firing twice in a window
  dedup_key       TEXT,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for career_alerts
CREATE INDEX IF NOT EXISTS idx_ca_user_created
  ON career_alerts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ca_unread
  ON career_alerts (user_id, is_read)
  WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS idx_ca_priority
  ON career_alerts (user_id, alert_priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ca_type
  ON career_alerts (user_id, alert_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_dedup
  ON career_alerts (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ca_payload_gin
  ON career_alerts USING GIN (payload);

-- RLS
ALTER TABLE career_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS ca_user_policy
  ON career_alerts FOR ALL TO authenticated
  USING      (user_id = auth.uid()::TEXT)
  WITH CHECK (user_id = auth.uid()::TEXT);

CREATE POLICY IF NOT EXISTS ca_service_policy
  ON career_alerts FOR ALL TO service_role
  USING (true);
`;

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run(dryRun = true) {
  console.log('\n🚀  Daily Engagement System — Database Migration');
  console.log(`    Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE RUN'}\n`);

  console.log('─── SQL DDL ────────────────────────────────────────────────────');
  console.log(SQL_DDL);
  console.log('────────────────────────────────────────────────────────────────\n');

  if (dryRun) {
    console.log('🔍  DRY RUN complete. Re-run with --run to apply.');
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.warn('⚠️   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
    console.log('    Copy the DDL above and run it in the Supabase SQL Editor.\n');
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, serviceKey);

  console.log('⚡  Applying DDL via Supabase admin client…');
  const { error } = await supabase.rpc('exec_sql', { sql: SQL_DDL }).catch(e => ({ error: e }));

  if (error) {
    console.warn('  ⚠️   RPC exec_sql failed — run the DDL manually:', error.message);
  } else {
    console.log('  ✅  DDL applied.\n');
  }

  console.log('✅  Migration complete.\n');
  console.log('📋  Next steps:');
  console.log('    1. Register routes in server.js (see server.additions.daily-engagement.js)');
  console.log('    2. Set ENGAGEMENT_CACHE_TTL_SEC=600 in .env');
  console.log('    3. Start the event worker: node src/modules/daily-engagement/workers/engagement.worker.js');
}

run(!process.argv.includes('--run'))
  .then(() => process.exit(0))
  .catch(err => { console.error('[Migration]', err); process.exit(1); });









