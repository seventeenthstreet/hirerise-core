'use strict';

/**
 * resumeScore.service.js
 * Enterprise-grade Resume Strength Scoring Service
 *
 * CHANGES (remediation sprint):
 *   FIX-10: Added isMockData: true flag to performAIScoring() return value.
 *            The service currently returns hardcoded stub data in production with
 *            no indication it is synthetic. This flag lets frontend engineers and
 *            QA detect that the score is not real and avoid displaying it as such.
 *            Remove this flag (and replace the stub) when real AI scoring is wired in.
 *
 * Features:
 *  - Distributed locking (prevents duplicate scoring)
 *  - Cache-first strategy
 *  - Double-check locking pattern
 *  - AI timeout protection
 *  - Crash-safe lock TTL
 */

const lockService   = require('../core/infrastructure/locking/lock.service');
const cacheManager  = require('../core/cache/cache.manager');

const CACHE_TTL_SECONDS = 300;   // 5 minutes
const LOCK_TTL_MS       = 30000; // 30 seconds
const AI_TIMEOUT_MS     = 25000; // 25 seconds

const cache = cacheManager.getClient();

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI_TIMEOUT')), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * TODO: Replace with real AI scoring logic.
 * FIX-10: isMockData: true flags this as synthetic data to all consumers.
 */
async function performAIScoring(userId) {
  await new Promise(resolve => setTimeout(resolve, 500)); // simulate async delay

  return {
    isMockData: true, // FIX-10: signals to consumers that this is stub data
    userId,
    roleFit: 'software_engineer',
    overallScore: 72,
    breakdown: {
      skills:     70,
      experience: 75,
      education:  65,
    },
  };
}

async function calculate(userId) {
  if (!userId) throw new Error('userId is required');

  const cacheKey = `resumeScore:${userId}`;
  const lockKey  = `lock:resumeScore:${userId}`;

  // 1️⃣ Fast path: cache
  const cached = await cache.get(cacheKey);
  if (cached) return { ...cached, source: 'cache' };

  // 2️⃣ Acquire distributed lock
  return lockService.executeWithLock(lockKey, async () => {

    // 3️⃣ Double-check after lock
    const cachedAfterLock = await cache.get(cacheKey);
    if (cachedAfterLock) return { ...cachedAfterLock, source: 'cache' };

    try {
      // 4️⃣ AI scoring with timeout guard
      const aiResult = await withTimeout(performAIScoring(userId), AI_TIMEOUT_MS);

      const result = {
        ...aiResult,
        calculatedAt: new Date().toISOString(),
      };

      // 5️⃣ Cache result
      await cache.set(cacheKey, result, CACHE_TTL_SECONDS);

      return { ...result, source: 'computed' };

    } catch (error) {
      if (error.message === 'AI_TIMEOUT') {
        console.error(`AI scoring timed out for user: ${userId}`);
      } else {
        console.error(`Resume scoring failed for user ${userId}:`, error.message);
      }
      throw error;
    }

  }, LOCK_TTL_MS);
}

async function invalidate(userId) {
  if (!userId) return;
  await cache.delete(`resumeScore:${userId}`);
}

module.exports = { calculate, invalidate };
