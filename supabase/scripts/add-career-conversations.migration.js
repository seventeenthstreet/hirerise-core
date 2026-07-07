'use strict';

/**
 * src/migration/add-career-conversations.migration.js
 *
 * Migration: Add edu_career_conversations Supabase table
 */

require('dotenv').config();

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const TABLE = 'edu_career_conversations';

async function run() {
  logger.info('[Migration] add-career-conversations — starting');

  // 🔒 Validate Supabase client
  if (!supabase) {
    logger.error('[Migration] Supabase client not initialized');
    process.exit(1);
  }

  // ✅ Check if init record exists
  const { data: existing, error: fetchError } = await supabase
    .from(TABLE)
    .select('id')
    .eq('student_id', '_init')
    .maybeSingle();

  if (fetchError) {
    logger.error('[Migration] Failed to check existing record', {
      error: fetchError.message
    });
    process.exit(1);
  }

  if (existing) {
    logger.info('[Migration] Table already initialized — skipping seed');
  } else {
    // ✅ Insert seed row
    const { error: insertError } = await supabase
      .from(TABLE)
      .insert([
        {
          student_id: '_init',
          user_message: 'Migration initialization record — safe to delete.',
          ai_response: 'Migration initialization record — safe to delete.',
          created_at: new Date().toISOString()
        }
      ]);

    if (insertError) {
      logger.error('[Migration] Failed to insert init record', {
        error: insertError.message
      });
      process.exit(1);
    }

    logger.info('[Migration] Init record inserted successfully');
  }

  logger.info('[Migration] add-career-conversations — complete');

  logger.info('\nACTION REQUIRED: Run this in Supabase SQL editor:\n');
  logger.info(`
CREATE INDEX IF NOT EXISTS idx_edu_career_conversations_student_created
ON edu_career_conversations (student_id ASC, created_at ASC);
  `);

  process.exit(0);
}

// 🚀 Execute migration
run().catch((err) => {
  logger.error('[Migration] Unexpected failure', {
    error: err.message
  });
  process.exit(1);
});