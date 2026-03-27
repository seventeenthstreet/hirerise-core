'use strict';

/**
 * src/migration/add-school-platform.migration.js
 *
 * Migration: Initialise the School & Counselor Platform collections.
 *
 * Run:
 *   node src/migration/add-school-platform.migration.js
 *
 * ─── Collections created ─────────────────────────────────────────────────────
 *
 *   sch_schools          — one doc per school
 *   sch_school_users     — staff membership (admin / counselor)
 *   sch_school_students  — student ↔ school links
 *
 * ─── Required Firestore Indexes ──────────────────────────────────────────────
 *
 * Add all of the following to firestore.indexes.json:
 *
 * {
 *   "indexes": [
 *     {
 *       "collectionGroup": "sch_school_users",
 *       "queryScope": "COLLECTION",
 *       "fields": [
 *         { "fieldPath": "user_id",  "order": "ASCENDING" }
 *       ]
 *     },
 *     {
 *       "collectionGroup": "sch_school_users",
 *       "queryScope": "COLLECTION",
 *       "fields": [
 *         { "fieldPath": "school_id", "order": "ASCENDING" },
 *         { "fieldPath": "user_id",   "order": "ASCENDING" }
 *       ]
 *     },
 *     {
 *       "collectionGroup": "sch_school_students",
 *       "queryScope": "COLLECTION",
 *       "fields": [
 *         { "fieldPath": "school_id",  "order": "ASCENDING" }
 *       ]
 *     },
 *     {
 *       "collectionGroup": "sch_school_students",
 *       "queryScope": "COLLECTION",
 *       "fields": [
 *         { "fieldPath": "school_id",  "order": "ASCENDING" },
 *         { "fieldPath": "student_id", "order": "ASCENDING" }
 *       ]
 *     },
 *     {
 *       "collectionGroup": "sch_school_students",
 *       "queryScope": "COLLECTION",
 *       "fields": [
 *         { "fieldPath": "student_id", "order": "ASCENDING" }
 *       ]
 *     }
 *   ]
 * }
 *
 * Deploy indexes:
 *   firebase deploy --only firestore:indexes
 */
require('dotenv').config();
require('../config/supabase');
const {
  db
} = require('../config/supabase');
const {
  FieldValue
} = require('../config/supabase');
const logger = require('../utils/logger');
const COLLECTIONS = {
  SCHOOLS: 'sch_schools',
  SCHOOL_USERS: 'sch_school_users',
  SCHOOL_STUDENTS: 'sch_school_students'
};
async function initCollection(name) {
  // TODO: MANUAL MIGRATION REQUIRED — unrecognised chain: collection.doc
  const initRef = db.collection(name).doc('_migration_init');
  const snap = await initRef.get();
  if (snap.exists) {
    logger.info(`[Migration] ${name} — already initialised, skipping`);
    return;
  }
  await initRef.set({
    _init: true,
    _note: 'Migration initialisation record — safe to delete.',
    created_at: FieldValue.serverTimestamp()
  });
  logger.info(`[Migration] ${name} — initialised`);
}
async function run() {
  logger.info('[Migration] add-school-platform — starting');
  await initCollection(COLLECTIONS.SCHOOLS);
  await initCollection(COLLECTIONS.SCHOOL_USERS);
  await initCollection(COLLECTIONS.SCHOOL_STUDENTS);
  logger.info('[Migration] add-school-platform — complete');
  logger.info('');
  logger.info('ACTION REQUIRED: Add the composite indexes from the comment above');
  logger.info('to firestore.indexes.json and run: firebase deploy --only firestore:indexes');
  process.exit(0);
}
run().catch(err => {
  logger.error({
    err: err.message
  }, '[Migration] Failed');
  process.exit(1);
});