'use strict';

require('dotenv').config();

const {
  backfillAllSkillEmbeddings,
} = require('../src/services/embedding.service');

async function main() {
  const startedAt = Date.now();

  try {
    console.info('🚀 Starting embedding backfill...', {
      script: 'backfillEmbeddings',
      nodeEnv: process.env.NODE_ENV || 'development',
    });

    await backfillAllSkillEmbeddings();

    const durationMs = Date.now() - startedAt;

    console.info('✅ Embedding backfill completed', {
      durationMs,
    });

    process.exitCode = 0;
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    console.error('❌ Embedding backfill failed', {
      durationMs,
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });

    process.exitCode = 1;
  }
}

void main();