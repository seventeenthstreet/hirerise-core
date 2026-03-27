'use strict';

/**
 * src/migration/add-career-conversations.migration.js
 *
 * Migration: Add edu_career_conversations Supabase table
 *
 * This migration validates Supabase table access and seeds a placeholder
 * row to confirm the table exists and is writable.
 *
 * Run:
 *   node src/migration/add-career-conversations.migration.js
 *
 * ─── Table: edu_career_conversations ─────────────────────────────────────────
 *
 * Fields:
 *   id           — auto-generated UUID (primary key)
 *   student_id   — string (user ID) — indexed for .eq() queries
 *   user_message — string — the student's question
 *   ai_response  — string — Claude's personalised answer
 *   created_at   — timestamp — ordered for history retrieval
 *
 * Required Supabase index (composite):
 *   Table: edu_career_conversations
 *   Fields: student_id ASC, created_at ASC
 *
 * Add via Supabase SQL editor:
 *
 *   CREATE INDEX IF NOT EXISTS idx_edu_career_conversations_student_created
 *     ON edu_career_conversations (student_id ASC, created_at ASC);
 */
require('dotenv').config();
require('../config/supabase');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const COLLECTION = 'edu_career_conversations';

async function run() {
  logger.info('[Migration] add-career-conversations — starting');

  // Check if a migration init record already exists
  const { data: existing, error: fetchError } = await supabase
    .from(COLLECTION)
    .select('id')
    .eq('student_id', '_init')
    .maybeSingle();

  if (fetchError) {
    logger.error('[Migration] Failed to check existing record', { error: fetchError.message });
    process.exit(1);
  }

  if (existing) {
    logger.info('[Migration] Collection already initialised — skipping seed');
  } else {
    // Seed a placeholder row to initialise the table
    const { error: insertError } = await supabase
      .from(COLLECTION)
      .insert({
        student_id: '_init',
        user_message: 'Migration initialisation record — safe to delete.',
        ai_response: 'Migration initialisation record — safe to delete.',
        created_at: new Date().toISOString()
      });

    if (insertError) {
      logger.error('[Migration] Failed to seed _migration_init record', { error: insertError.message });
      process.exit(1);
    }

    logger.info('[Migration] Seeded _migration_init record');
  }

  logger.info('[Migration] add-career-conversations — complete');
  logger.info('');
  logger.info('ACTION REQUIRED: Add this composite index via Supabase SQL editor:');
  logger.info(
    'CREATE INDEX IF NOT EXISTS idx_edu_career_conversations_student_created\n' +
    '  ON edu_career_conversations (student_id ASC, created_at ASC);'
  );
  process.exit(0);
}

run().catch(err => {
  logger.error({ err: err.message }, '[Migration] Failed');
  process.exit(1);
});