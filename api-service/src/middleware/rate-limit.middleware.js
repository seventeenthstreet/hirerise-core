'use strict';

import { supabaseAdmin } from '../../../config/supabaseClient.js';
import { logger } from '../../../shared/logger/index.js';

const LIMITS = Object.freeze({
  requestsPerMinute: 20,
  maxPendingJobs: 5,
  dailyResumeSubmits: 10,
  dailySalaryRequests: 20,
  dailyCareerRequests: 20,
});

const VALID_WINDOWS = new Set(['minute', 'day']);
const RATE_LIMIT_TIMEOUT_MS = 1000;

function getTimestamp() {
  return new Date().toISOString();
}

function sendRateLimitResponse(res, payload, requestId) {
  return res.status(429).json({
    ...payload,
    requestId,
    timestamp: getTimestamp(),
  });
}

export function rateLimit({ counterKey, limit, window = 'minute' }) {
  if (!counterKey || typeof counterKey !== 'string') {
    throw new Error('counterKey must be a non-empty string');
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  if (!VALID_WINDOWS.has(window)) {
    throw new Error(`Invalid rate limit window: ${window}`);
  }

  return async function rateLimitMiddleware(req, res, next) {
    const userId = req.user?.uid;
    if (!userId) return next();

    try {
      const windowKey = getWindowKey(window);
      const counterId = `${userId}:${counterKey}:${windowKey}`;

      const allowed = await withTimeout(
        checkAndIncrement(counterId, limit, window),
        RATE_LIMIT_TIMEOUT_MS
      );

      if (!allowed) {
        logger.warn('Rate limit exceeded', {
          userId,
          counterKey,
          limit,
          window,
          requestId: req.requestId,
        });

        return sendRateLimitResponse(
          res,
          {
            error: 'RATE_LIMIT_EXCEEDED',
            message: `Too many requests. Limit: ${limit} per ${window}.`,
            retryAfter: getRetryAfter(window),
          },
          req.requestId
        );
      }

      return next();
    } catch (error) {
      logger.error('Rate limit check failed — fail-open applied', {
        error: error.message,
        userId,
        counterKey,
        requestId: req.requestId,
      });

      return next();
    }
  };
}

export async function checkPendingJobLimit(userId) {
  if (!userId) {
    return { allowed: true, count: 0 };
  }

  const { count, error } = await supabaseAdmin
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
    .is('deleted_at', null);

  if (error) {
    logger.error('checkPendingJobLimit query failed', {
      userId,
      error: error.message,
      code: error.code,
    });

    return { allowed: true, count: 0, degraded: true };
  }

  const jobCount = Number(count ?? 0);

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

export async function pendingJobLimitMiddleware(req, res, next) {
  const userId = req.user?.uid;
  if (!userId) return next();

  try {
    const result = await checkPendingJobLimit(userId);

    if (!result.allowed) {
      logger.warn('Pending job limit exceeded', {
        userId,
        count: result.count,
        limit: result.limit,
        requestId: req.requestId,
      });

      return sendRateLimitResponse(
        res,
        {
          error: 'PENDING_JOB_LIMIT_EXCEEDED',
          message: result.message,
          pendingJobs: result.count,
          limit: result.limit,
        },
        req.requestId
      );
    }

    return next();
  } catch (error) {
    logger.error('Pending job check failed — allowing request', {
      error: error.message,
      userId,
      requestId: req.requestId,
    });

    return next();
  }
}

async function checkAndIncrement(counterId, limit, window) {
  const expiresAt = getWindowExpiry(window).toISOString();

  const { data, error } = await supabaseAdmin.rpc('increment_rate_limit', {
    p_id: counterId,
    p_limit: limit,
    p_expires_at: expiresAt,
  });

  if (error) {
    logger.error('[rateLimit] RPC failed', {
      counterId,
      limit,
      window,
      error: error.message,
      code: error.code,
    });

    return true;
  }

  return Boolean(data);
}

function getWindowKey(window) {
  const now = new Date();
  return window === 'minute'
    ? now.toISOString().slice(0, 16)
    : now.toISOString().slice(0, 10);
}

function getWindowExpiry(window) {
  const now = new Date();

  if (window === 'minute') {
    now.setUTCSeconds(0, 0);
    now.setUTCMinutes(now.getUTCMinutes() + 2);
    return now;
  }

  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() + 2);
  return now;
}

function getRetryAfter(window) {
  return window === 'minute' ? 60 : 86400;
}

function withTimeout(promise, ms) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Rate limit timeout'));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}
