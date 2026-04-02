import { supabase } from '../../../config/supabaseClient.js';
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

const VALID_WINDOWS = new Set(['minute', 'day']);

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Middleware Factory
// ─────────────────────────────────────────────────────────────────────────────

export function rateLimit({ counterKey, limit, window = 'minute' }) {
  if (!VALID_WINDOWS.has(window)) {
    throw new Error(`Invalid rate limit window: ${window}`);
  }

  return async function rateLimitMiddleware(req, res, next) {
    const userId = req.user?.uid;
    if (!userId) return next();

    try {
      const windowKey = getWindowKey(window);
      const docId     = `${userId}_${counterKey}_${windowKey}`;

      const allowed = await withTimeout(
        checkAndIncrement(docId, limit, window),
        1000
      );

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
          retryAfter: getRetryAfter(window),
          requestId:  req.requestId,
          timestamp:  new Date().toISOString(),
        });
      }

      next();
    } catch (err) {
      logger.error('Rate limit check failed — fail-safe applied', {
        error: err.message,
        userId,
        counterKey,
        requestId: req.requestId,
      });

      // ⚠️ Safer fallback: allow but mark degraded
      next();
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
    logger.error('checkPendingJobLimit query failed', {
      userId,
      error: error.message,
    });
    return { allowed: true, count: 0 };
  }

  const jobCount = count ?? 0;

  if (jobCount >= LIMITS.maxPendingJobs) {
    return {
      allowed: false,
      count: jobCount,
      limit: LIMITS.maxPendingJobs,
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
        error:       'PENDING_JOB_LIMIT_EXCEEDED',
        message,
        pendingJobs: count,
        limit,
        requestId:   req.requestId,
        timestamp:   new Date().toISOString(),
      });
    }

    next();
  } catch (err) {
    logger.error('Pending job check failed — allowing request', {
      error: err.message,
      userId,
      requestId: req.requestId,
    });

    next();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic Counter (RPC-based)
// ─────────────────────────────────────────────────────────────────────────────

async function checkAndIncrement(docId, limit, window) {
  const expiresAt = getWindowExpiry(window).toISOString();

  const { data, error } = await supabase.rpc('increment_rate_limit', {
    p_id: docId,
    p_limit: limit,
    p_expires_at: expiresAt,
  });

  if (error) {
    logger.error('[rateLimit] RPC failed', {
      docId,
      error: error.message,
    });
    return true;
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getWindowKey(window) {
  const now = new Date();

  if (window === 'minute') {
    return now.toISOString().slice(0, 16);
  }

  return now.toISOString().slice(0, 10);
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

function getRetryAfter(window) {
  return window === 'minute' ? 60 : 86400;
}

// Timeout wrapper
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Rate limit timeout')), ms)
    ),
  ]);
}