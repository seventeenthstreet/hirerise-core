'use strict';

/**
 * middleware/requestTimeout.middleware.js
 *
 * PR 2: Backend Infra Safety
 * Global request timeout middleware.
 *
 * - Returns 504 if request exceeds REQUEST_TIMEOUT_MS
 * - Skips health and readiness probes
 * - Prevents double responses after timeout
 * - Clears timers safely on finish/close
 */

const logger = require('../utils/logger');

const TIMEOUT_MS = parseInt(
  process.env.REQUEST_TIMEOUT_MS || '30000',
  10
);

const EXCLUDED_PREFIXES = ['/api/v1/health', '/api/v1/ready'];

function requestTimeout(req, res, next) {
  // Skip health + readiness probes
  if (EXCLUDED_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
    return next();
  }

  req.timedout = false;

  const timer = setTimeout(() => {
    req.timedout = true;

    logger.warn('[RequestTimeout] Request exceeded timeout', {
      path: req.path,
      method: req.method,
      timeoutMs: TIMEOUT_MS,
      correlationId: req.correlationId,
    });

    if (!res.headersSent) {
      return res.status(504).json({
        success: false,
        error: {
          code: 'REQUEST_TIMEOUT',
          message: 'Request took too long to process. Please retry.',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }, TIMEOUT_MS);

  const clear = () => clearTimeout(timer);

  res.on('finish', clear);
  res.on('close', clear);

  return next();
}

module.exports = { requestTimeout };