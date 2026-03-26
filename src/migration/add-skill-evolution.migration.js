'use strict';

/**
 * migration/add-skill-evolution.migration.js
 *
 * Creates Firestore indexes required by the Skill Evolution Engine.
 *
 * Collections:
 *   edu_student_skills          — per-skill rows, queried by student_id + ordered by impact_score
 *   edu_skill_recommendations   — one doc per student (keyed by studentId), no composite index needed
 *
 * Run via:
 *   node src/migration/add-skill-evolution.migration.js
 */

require('dotenv').config();
require('../config/supabase');

const { db } = require('../config/supabase');
const logger = require('../utils/logger');

const SEED_STUDENT_ID = process.env.MIGRATION_SEED_STUDENT_ID || null;

async function up() {
  logger.info('[Migration:SEE] Starting skill evolution migration');

  // Verify collections are accessible by writing + deleting a canary doc
  const canary = db.collection('edu_student_skills').doc('__migration_canary__');
  await canary.set({
    student_id:        '__canary__',
    skill_name:        '__canary__',
    proficiency_level: 'beginner',
    impact_score:      0,
    career_relevance:  0,
    demand_score:      0,
    created_at:        new Date(),
  });
  await canary.delete();
  logger.info('[Migration:SEE] edu_student_skills collection verified');

  const canary2 = db.collection('edu_skill_recommendations').doc('__migration_canary__');
  await canary2.set({
    student_id:         '__canary__',
    top_career:         '__canary__',
    recommended_stream: '__canary__',
    skills:             [],
    roadmap:            [],
    engine_version:     '1.0.0',
    calculated_at:      new Date(),
  });
  await canary2.delete();
  logger.info('[Migration:SEE] edu_skill_recommendations collection verified');

  logger.info('[Migration:SEE] Migration complete. Add these composite indexes to firestore.indexes.json:');
  logger.info(JSON.stringify({
    indexes: [
      {
        collectionGroup: 'edu_student_skills',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'student_id',   order: 'ASCENDING' },
          { fieldPath: 'impact_score', order: 'DESCENDING' },
        ],
      },
    ],
  }, null, 2));
}

up().then(() => process.exit(0)).catch(err => {
  logger.error({ err: err.message }, '[Migration:SEE] Failed');
  process.exit(1);
});









