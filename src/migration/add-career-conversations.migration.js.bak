'use strict';

/**
 * src/migration/add-career-conversations.migration.js
 *
 * Migration: Add edu_career_conversations Firestore collection
 *
 * Firestore is schemaless — no table creation is required.
 * This migration creates the required composite index configuration
 * and seeds a sample document to initialise the collection.
 *
 * Run:
 *   node src/migration/add-career-conversations.migration.js
 *
 * ─── Collection: edu_career_conversations ────────────────────────────────────
 *
 * Fields:
 *   id           — auto-generated Firestore doc ID
 *   student_id   — string (user ID) — indexed for .where() queries
 *   user_message — string — the student's question
 *   ai_response  — string — Claude's personalised answer
 *   created_at   — timestamp — ordered for history retrieval
 *
 * Required Firestore index (composite):
 *   Collection: edu_career_conversations
 *   Fields: student_id ASC, created_at ASC
 *
 * Add to firestore.indexes.json:
 *
 * {
 *   "indexes": [
 *     {
 *       "collectionGroup": "edu_career_conversations",
 *       "queryScope": "COLLECTION",
 *       "fields": [
 *         { "fieldPath": "student_id", "order": "ASCENDING" },
 *         { "fieldPath": "created_at", "order": "ASCENDING" }
 *       ]
 *     }
 *   ]
 * }
 */

require('dotenv').config();
require('../config/supabase');

const { db }         = require('../config/supabase');
const { FieldValue } = require('../config/supabase');
const logger         = require('../utils/logger');

const COLLECTION = 'edu_career_conversations';

async function run() {
  logger.info('[Migration] add-career-conversations — starting');

  // Seed a placeholder document to initialise the collection
  // (Firestore collections don't exist until they have at least one document)
  const ref = db.collection(COLLECTION).doc('_migration_init');
  const existing = await ref.get();

  if (existing.exists) {
    logger.info('[Migration] Collection already initialised — skipping seed');
  } else {
    await ref.set({
      student_id:   '_init',
      user_message: 'Migration initialisation record — safe to delete.',
      ai_response:  'Migration initialisation record — safe to delete.',
      created_at:   FieldValue.serverTimestamp(),
    });
    logger.info('[Migration] Seeded _migration_init document');
  }

  logger.info('[Migration] add-career-conversations — complete');
  logger.info('');
  logger.info('ACTION REQUIRED: Add this composite index to firestore.indexes.json:');
  logger.info(JSON.stringify({
    collectionGroup: COLLECTION,
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'student_id', order: 'ASCENDING' },
      { fieldPath: 'created_at', order: 'ASCENDING' },
    ],
  }, null, 2));

  process.exit(0);
}

run().catch(err => {
  logger.error({ err: err.message }, '[Migration] Failed');
  process.exit(1);
});










