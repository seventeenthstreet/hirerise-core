/**
 * api-service/src/middleware/rate-limit.middleware.js
 *
 * FIXED: Converted from Firestore shim to native Supabase.
 *
 * Removed:
 *   - db.collection() / collection.doc() references
 *   - db.runTransaction() / tx.get() / tx.set() / tx.update()
 *   - snap.exists / snap.data()
 *   - FieldValue.serverTimestamp() / FieldValue.increment()
 *   - Timestamp.fromDate()
 *   - db.collectionGroup()
 *
 * Replaced with:
 *   - supabase.from() queries with { data, error } destructuring
 *   - Optimistic upsert-based counter increment (replaces transaction)
 *   - ISO strings for all timestamps
 *   - COUNT aggregate query for pending jobs
 *
 * NOTE: module uses `export` (ESM) syntax — preserved as-is.
 */

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../../shared/logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client (ESM-compatible singleton)
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

const RATE_LIMIT_TABLE = 'rate_limit_counters';

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Middleware Factory
// ─────────────────────────────────────────────────────────────────────────────

export function rateLimit({ counterKey, limit, window = 'minute' }) {
  return async function rateLimitMiddleware(req, res, next) {
    const userId = req.user?.uid;
    if (!userId) return next();

    try {
      const windowKey = getWindowKey(window);
      const docId     = `${userId}_${counterKey}_${windowKey}`;
      const allowed   = await checkAndIncrement(docId, limit, window);

      if (!allowed) {
        logger.warn('Rate limit exceeded', {
          userId,
          counterKey,
          limit,
          window,
          requestId: req.requestId,
        });

        return res.status(429).json({
          error:      'RATE_LIMIT_EXCEEDED',
          message:    `Too many requests. Limit: ${limit} per ${window}.`,
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
// Pending Job Limit
// ─────────────────────────────────────────────────────────────────────────────

export async function checkPendingJobLimit(userId) {
  const { count, error } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
    .is('deleted_at', null);

  if (error) {
    logger.error('checkPendingJobLimit query failed', { userId, error: error.message });
    // Fail open — don't block user on DB error
    return { allowed: true, count: 0 };
  }

  const jobCount = count ?? 0;

  if (jobCount >= LIMITS.maxPendingJobs) {
    return {
      allowed: false,
      count:   jobCount,
      limit:   LIMITS.maxPendingJobs,
      message: `You have ${jobCount} pending jobs. Maximum is ${LIMITS.maxPendingJobs}.`,
    };
  }

  return { allowed: true, count: jobCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Presets
// ─────────────────────────────────────────────────────────────────────────────

export const resumeSubmitRateLimit = rateLimit({
  counterKey: 'resume_submit',
  limit:      LIMITS.dailyResumeSubmits,
  window:     'day',
});

export const salaryRequestRateLimit = rateLimit({
  counterKey: 'salary_request',
  limit:      LIMITS.dailySalaryRequests,
  window:     'day',
});

export const careerRequestRateLimit = rateLimit({
  counterKey: 'career_request',
  limit:      LIMITS.dailyCareerRequests,
  window:     'day',
});

export const globalRequestRateLimit = rateLimit({
  counterKey: 'global',
  limit:      LIMITS.requestsPerMinute,
  window:     'minute',
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
        error:       'PENDING_JOB_LIMIT_EXCEEDED',
        message,
        pendingJobs: count,
        limit,
      });
    }

    next();
  } catch (err) {
    logger.error('Pending job check failed — allowing request', { err, userId });
    next(); // Fail open
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically check and increment a rate-limit counter.
 *
 * Strategy: read-then-upsert with an ISO expiry.
 * Supabase lacks server-side increment without an RPC, so we:
 *   1. Read the current row.
 *   2. If count >= limit → reject (return false).
 *   3. Upsert with count + 1.
 *
 * This is slightly optimistic (two round-trips) but safe at normal traffic
 * levels. For high-throughput services, replace with a Postgres RPC:
 *   SELECT rate_limit_increment($1, $2, $3)
 *
 * @returns {Promise<boolean>} true if the request is allowed
 */
async function checkAndIncrement(docId, limit, window) {
  const expiresAt = getWindowExpiry(window).toISOString();
  const now       = new Date().toISOString();

  // 1. Fetch existing counter
  const { data: existing, error: readError } = await supabase
    .from(RATE_LIMIT_TABLE)
    .select('count')
    .eq('id', docId)
    .maybeSingle();

  if (readError) {
    logger.error('[rateLimit] Counter read failed', { docId, error: readError.message });
    return true; // Fail open
  }

  const current = existing?.count ?? 0;

  if (current >= limit) return false;

  // 2. Upsert with incremented count
  const { error: writeError } = await supabase
    .from(RATE_LIMIT_TABLE)
    .upsert(
      {
        id:         docId,
        count:      current + 1,
        created_at: existing ? undefined : now,
        expires_at: expiresAt,
      },
      { onConflict: 'id' }
    );

  if (writeError) {
    logger.error('[rateLimit] Counter write failed', { docId, error: writeError.message });
    return true; // Fail open
  }

  return true;
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

  return now;
}