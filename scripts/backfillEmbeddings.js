'use strict';

require('dotenv').config();

const { backfillAllSkillEmbeddings } = require('../src/services/embedding.service');

(async () => {
  try {
    console.log('🚀 Starting embedding backfill...');

    await backfillAllSkillEmbeddings();

    console.log('✅ Embedding backfill completed');
    process.exit(0);

  } catch (err) {
    console.error('❌ Backfill failed:', err);
    process.exit(1);
  }
})();