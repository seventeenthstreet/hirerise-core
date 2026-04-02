CREATE TABLE IF NOT EXISTS career_metrics (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT          NOT NULL,

  composite        NUMERIC(5,2)  NOT NULL DEFAULT 0,

  ats_score        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  job_match        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  interview_score  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  activity_score   NUMERIC(5,2)  NOT NULL DEFAULT 0,

  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_career_metrics_user_date
  ON career_metrics (user_id, recorded_at DESC);

ALTER TABLE career_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "career_metrics_owner"
  ON career_metrics FOR ALL
  USING (user_id = auth.uid()::text);