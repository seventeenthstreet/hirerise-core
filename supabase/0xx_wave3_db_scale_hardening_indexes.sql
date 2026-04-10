-- =========================================================
-- Hirerise Core — Wave 3 Priority #4
-- Final delta-only DB scale hardening
-- Safe against current production schema
-- =========================================================

-- ---------------------------------------------------------
-- 1) usage_logs tier breakdown queries
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_usage_logs_tier_created
ON usage_logs (tier, created_at DESC);

-- ---------------------------------------------------------
-- 2) notifications unread fast path
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created
ON notifications (user_id, created_at DESC)
WHERE read = false;

-- ---------------------------------------------------------
-- 3) resumes worker processing queue
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_resumes_user_processing_status
ON resumes (user_id, processing_status)
WHERE soft_deleted = false;

-- ---------------------------------------------------------
-- 4) ava_memory weekly cron summary
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ava_memory_week_start_user
ON ava_memory (week_start_date, user_id);