'use strict';

/**
 * conversionHook.middleware.js
 *
 * Safely records conversion events AFTER response is sent.
 * Never blocks request lifecycle.
 * Resilient to duplicate mounting and high traffic.
 */

const conversionEventService = require('../services/conversionEvent.service');
const logger = require('../utils/conversion.logger');

const MAX_METADATA_BYTES = 8 * 1024; // 8KB safety cap

/**
 * Optional: exclude system routes
 */
function _shouldSkip(req) {
  const path = req.path || '';
  return (
    path.startsWith('/health') ||
    path.startsWith('/metrics') ||
    path.startsWith('/static')
  );
}

/**
 * Prevent oversized metadata writes.
 */
function _sanitizeMetadata(metadata) {
  try {
    const str = JSON.stringify(metadata);
    if (Buffer.byteLength(str, 'utf8') > MAX_METADATA_BYTES) {
      return { truncated: true };
    }
    return metadata;
  } catch {
    return {};
  }
}

function conversionHookMiddleware(req, res, next) {

  // Prevent double execution
  if (req._conversionHookAttached) {
    return next();
  }

  req._conversionHookAttached = true;

  // Attach AFTER response finishes
  res.once('finish', () => {

    try {
      if (_shouldSkip(req)) return;

      const conversionEvent = req.conversionEvent;
      if (!conversionEvent) return;

      const userId = req.user?.uid ?? req.user?.id;
      if (!userId) {
        logger.warn('conversionHookMiddleware: missing userId', {
          path: req.path,
        });
        return;
      }

      const metadata = _sanitizeMetadata({
        path: req.path,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('user-agent') ?? null,
        ...(req.conversionMetadata ?? {}),
      });

      const idempotencyKey = req.conversionIdempotencyKey ?? null;

      setImmediate(() => {
        conversionEventService
          .recordEvent(userId, conversionEvent, metadata, idempotencyKey)
          .catch((err) =>
            logger.error('conversionHookMiddleware: recordEvent failed', {
              userId,
              conversionEvent,
              error: err.message,
            })
          );
      });

    } catch (err) {
      logger.error('conversionHookMiddleware: unexpected failure', {
        error: err.message,
      });
    }

  });

  next();
}

module.exports = conversionHookMiddleware;