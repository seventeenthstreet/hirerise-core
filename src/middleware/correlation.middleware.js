'use strict';

/**
 * src/middleware/correlation.middleware.js
 *
 * PHASES 1 + 2 — Request Correlation IDs + Structured Auth/Backend Logging
 *
 * PURPOSE
 * ───────
 * Every request gets a unique requestId so frontend and backend logs for the
 * same auth/bootstrap call can be joined by ID in a log aggregator.
 *
 * WHAT THIS DOES
 * ──────────────
 * 1. correlationMiddleware
 *    - Reads X-Request-ID and X-Hydration-ID from inbound request headers
 *      (injected by the frontend via buildCorrelationHeaders() in authLogger.ts).
 *    - If X-Request-ID is absent (non-frontend callers, direct API hits),
 *      generates a server-side UUID so every request always has an ID.
 *    - Attaches requestId + hydrationId to req object.
 *    - Echoes both headers back in the response so curl / Postman callers
 *      can correlate their request to backend log lines.
 *
 * 2. requestLifecycleLogger
 *    - Logs structured JSON at request start and end.
 *    - Includes: method, path, statusCode, durationMs, requestId, hydrationId.
 *    - Masks Authorization header values — never logs token content.
 *    - Uses logger.child() so all log lines for a request share the same
 *      requestId field, enabling trivial grep/filter in log aggregators.
 *
 * 3. authEventLogger
 *    - Logs JWT validation results (success / failure) from auth.middleware.js.
 *    - Called inside the existing authenticate() middleware at the point where
 *      req.user is populated (or the error is thrown).
 *    - Emits structured JSON including: userId, requestId, plan, event name.
 *
 * USAGE IN server.js
 * ──────────────────
 *   const { correlationMiddleware, requestLifecycleLogger } = require('./middleware/correlation.middleware');
 *
 *   // Add BEFORE all other middleware (after helmet):
 *   app.use(correlationMiddleware);
 *   app.use(requestLifecycleLogger);
 *
 * USAGE IN auth.middleware.js
 * ───────────────────────────
 *   const { logAuthBackendEvent } = require('./correlation.middleware');
 *
 *   // Inside authenticate(), after req.user is set:
 *   logAuthBackendEvent(req, 'JWT_VERIFIED', { userId: req.user.id, plan: req.user.plan });
 *
 *   // On auth failure:
 *   logAuthBackendEvent(req, 'JWT_INVALID', { reason: err.message }, 'warn');
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// HEADER CONSTANTS (match frontend buildCorrelationHeaders)
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_ID_HEADER   = 'x-request-id';
const HYDRATION_ID_HEADER = 'x-hydration-id';
const RESPONSE_REQUEST_ID = 'X-Request-ID';

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — CORRELATION MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach requestId + hydrationId to every request.
 * Must be first in the middleware chain (after helmet/trust-proxy).
 *
 * @type {import('express').RequestHandler}
 */
function correlationMiddleware(req, res, next) {
  // Read frontend-generated IDs or generate server-side fallback
  const requestId   = validateId(req.headers[REQUEST_ID_HEADER])
    ?? `srv_${crypto.randomUUID()}`;

  const hydrationId = validateId(req.headers[HYDRATION_ID_HEADER]) ?? null;

  // Attach to req for downstream middleware + route handlers
  req.requestId   = requestId;
  req.hydrationId = hydrationId;

  // Echo back so clients can correlate their ID with backend log lines
  res.setHeader(RESPONSE_REQUEST_ID, requestId);
  if (hydrationId) res.setHeader('X-Hydration-ID', hydrationId);

  next();
}

/**
 * Validate that an ID is a non-empty string ≤ 128 chars to prevent
 * header injection. Returns null for invalid values.
 */
function validateId(val) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  // Allow only alphanumeric, underscore, hyphen
  if (!/^[\w\-]+$/.test(trimmed)) return null;
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — REQUEST LIFECYCLE LOGGER
// ─────────────────────────────────────────────────────────────────────────────

/** Headers that must never appear in logs. */
const MASKED_REQUEST_HEADERS = new Set([
  'authorization', 'cookie', 'x-api-key', 'x-auth-token',
]);

function maskHeaders(headers) {
  const masked = {};
  for (const [k, v] of Object.entries(headers)) {
    masked[k] = MASKED_REQUEST_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return masked;
}

/**
 * Log structured request start + end events.
 * Attach to app.use() AFTER correlationMiddleware.
 *
 * @type {import('express').RequestHandler}
 */
function requestLifecycleLogger(req, res, next) {
  const startMs    = Date.now();
  const { requestId, hydrationId } = req;

  // Create a child logger so every line for this request carries the ID
  const reqLogger = logger.childLogger({
    requestId,
    hydrationId,
    method: req.method,
    path:   req.path,
  });

  // Log request start (debug level — verbose for auth endpoints)
  const isAuthPath = req.path.includes('/users/me') || req.path.includes('/app-entry');
  reqLogger[isAuthPath ? 'info' : 'debug']('[Request] Start', {
    event:     'REQUEST_START',
    userAgent: req.headers['user-agent'] ?? null,
  });

  // Intercept response finish for structured end event
  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    const level =
      res.statusCode >= 500 ? 'error' :
      res.statusCode >= 400 ? 'warn'  :
      (isAuthPath ? 'info' : 'debug');

    reqLogger[level]('[Request] End', {
      event:      'REQUEST_END',
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — AUTH EVENT LOGGER (called from auth.middleware.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emit a structured auth event from the backend.
 * Call this from auth.middleware.js after JWT verification succeeds or fails.
 *
 * @param {import('express').Request} req
 * @param {string} eventName  - e.g. 'JWT_VERIFIED', 'JWT_INVALID', 'JWT_EXPIRED'
 * @param {object} context    - Additional context (userId, plan, reason).
 * @param {'info'|'warn'|'error'} level
 */
function logAuthBackendEvent(req, eventName, context = {}, level = 'info') {
  try {
    logger[level](`[Auth] ${eventName}`, {
      event:       eventName,
      requestId:   req.requestId   ?? null,
      hydrationId: req.hydrationId ?? null,
      path:        req.path,
      method:      req.method,
      timestamp:   new Date().toISOString(),
      ...context,
    });
  } catch {
    // Auth logging must never break the auth middleware
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — /users/me + /app-entry EXECUTION LOGGER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper that adds structured lifecycle logs around an async route handler.
 * Used in users.routes.js and appEntry.route.js.
 *
 * @param {string} routeName  - e.g. 'GET /users/me'
 * @param {Function} fn       - Async route handler (req, res, next) => Promise<void>
 * @returns {Function}        - Express route handler with observability
 *
 * @example
 *   router.get('/me', authenticate, withRouteObservability('GET /users/me', async (req, res) => {
 *     // existing handler body unchanged
 *   }));
 */
function withRouteObservability(routeName, fn) {
  return async function observedHandler(req, res, next) {
    const startMs  = Date.now();
    const reqLogger = logger.childLogger({
      requestId:   req.requestId   ?? null,
      hydrationId: req.hydrationId ?? null,
      route:       routeName,
      userId:      req.user?.id    ?? null,
    });

    reqLogger.info(`[Route] Start`, { event: `${routeName.replace(/\s+/g, '_').toUpperCase()}_START` });

    try {
      await fn(req, res, next);
      const durationMs = Date.now() - startMs;
      reqLogger.info(`[Route] End`, {
        event:      `${routeName.replace(/\s+/g, '_').toUpperCase()}_END`,
        statusCode: res.statusCode,
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - startMs;
      reqLogger.error(`[Route] Error`, {
        event:      `${routeName.replace(/\s+/g, '_').toUpperCase()}_ERROR`,
        error:      err?.message ?? String(err),
        durationMs,
      });
      next(err);
    }
  };
}

module.exports = {
  correlationMiddleware,
  requestLifecycleLogger,
  logAuthBackendEvent,
  withRouteObservability,
  REQUEST_ID_HEADER,
  HYDRATION_ID_HEADER,
};