/**
 * api-service/src/middleware/rate-limit.middleware.js
 *
 * Per-User API Rate Limiting & Abuse Prevention
 *
 * Supports sharded job structure:
 *   automationJobs/{shard}/jobs/{jobId}
 *
 * Uses collectionGroup('jobs') for cross-shard queries.
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from '../../../shared/logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const LIMITS = Object.freeze({
  requestsPerMinute:   20,
  maxPendingJobs:      5,
  dailyResumeSubmits:  10,
  dailySalaryRequests: 20,
  dailyCareerRequests: 20,
});

const COLLECTION = 'rateLimitCounters';

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Middleware Factory
// ─────────────────────────────────────────────────────────────────────────────

export function rateLimit({ counterKey, limit, window = 'minute' }) {
  return async function rateLimitMiddleware(req, res, next) {
    const userId = req.user?.uid;
    if (!userId) return next();

    try {
      const windowKey = getWindowKey(window);
      const docId = `${userId}_${counterKey}_${windowKey}`;
      const allowed = await checkAndIncrement(docId, limit, window);

      if (!allowed) {
        logger.warn('Rate limit exceeded', {
          userId,
          counterKey,
          limit,
          window,
          requestId: req.requestId,
        });

        return res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Limit: ${limit} per ${window}.`,
          retryAfter: window === 'minute' ? 60 : 86400,
        });
      }

      next();
    } catch (err) {
      logger.error('Rate limit check failed — allowing request', {
        err,
        userId,
        counterKey,
      });

      next(); // Fail open
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending Job Limit (SHARDED STRUCTURE COMPATIBLE)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkPendingJobLimit(userId) {
  const db = getFirestore();

  const snap = await db
    .collectionGroup('jobs') // 🔥 Updated for sharded structure
    .where('userId', '==', userId)
    .where('status', 'in', ['pending', 'processing'])
    .where('deletedAt', '==', null)
    .count()
    .get();

  const count = snap?.data()?.count ?? 0;

  if (count >= LIMITS.maxPendingJobs) {
    return {
      allowed: false,
      count,
      limit: LIMITS.maxPendingJobs,
      message: `You have ${count} pending jobs. Maximum is ${LIMITS.maxPendingJobs}.`,
    };
  }

  return { allowed: true, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Presets
// ─────────────────────────────────────────────────────────────────────────────

export const resumeSubmitRateLimit = rateLimit({
  counterKey: 'resume_submit',
  limit: LIMITS.dailyResumeSubmits,
  window: 'day',
});

export const salaryRequestRateLimit = rateLimit({
  counterKey: 'salary_request',
  limit: LIMITS.dailySalaryRequests,
  window: 'day',
});

export const careerRequestRateLimit = rateLimit({
  counterKey: 'career_request',
  limit: LIMITS.dailyCareerRequests,
  window: 'day',
});

export const globalRequestRateLimit = rateLimit({
  counterKey: 'global',
  limit: LIMITS.requestsPerMinute,
  window: 'minute',
});

// ─────────────────────────────────────────────────────────────────────────────
// Pending Job Middleware
// ─────────────────────────────────────────────────────────────────────────────

export async function pendingJobLimitMiddleware(req, res, next) {
  const userId = req.user?.uid;
  if (!userId) return next();

  try {
    const { allowed, count, limit, message } =
      await checkPendingJobLimit(userId);

    if (!allowed) {
      logger.warn('Pending job limit exceeded', {
        userId,
        count,
        limit,
        requestId: req.requestId,
      });

      return res.status(429).json({
        error: 'PENDING_JOB_LIMIT_EXCEEDED',
        message,
        pendingJobs: count,
        limit,
      });
    }

    next();
  } catch (err) {
    logger.error('Pending job check failed — allowing request', {
      err,
      userId,
    });

    next(); // Fail open
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function checkAndIncrement(docId, limit, window) {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(docId);
  const expiresAt = getWindowExpiry(window);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (!snap.exists) {
      tx.set(ref, {
        count: 1,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
      });
      return 1;
    }

    const current = snap.data().count ?? 0;
    if (current >= limit) return null;

    tx.update(ref, {
      count: FieldValue.increment(1),
    });

    return current + 1;
  });

  return result !== null;
}

function getWindowKey(window) {
  const now = new Date();

  if (window === 'minute') {
    return now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  }

  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getWindowExpiry(window) {
  const now = new Date();

  if (window === 'minute') {
    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + 2);
  } else {
    now.setHours(0, 0, 0, 0);
    now.setDate(now.getDate() + 2);
  }

  return Timestamp.fromDate(now);
}