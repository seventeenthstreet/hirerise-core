'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * correlation.middleware.js
 *
 * Injects a correlationId (UUIDv4) into every request at the Express layer.
 * The ID is propagated through:
 *   req.correlationId          → available to all downstream middleware
 *   res.setHeader(X-Correlation-ID) → returned to client for debugging
 *   withObservability() config → stored in ai_logs
 *   AlertService payloads       → links alerts to originating request
 *
 * WHY THIS MATTERS:
 *   - Debugging: a single correlationId connects the Express log, AI log,
 *     cost entry, drift snapshot, and any alert fired — across any number of hops.
 *   - Distributed tracing: if HireRise adopts OpenTelemetry, correlationId maps
 *     directly to traceId, enabling end-to-end trace reconstruction.
 *   - Audit queries: "show me every AI call made by request abc-123" becomes
 *     a single Firestore query: where('correlationId', '==', 'abc-123').
 *
 * USAGE:
 *   // app.js — mount BEFORE all other middleware
 *   app.use(correlationMiddleware);
 *
 *   // Then in any handler:
 *   const id = req.correlationId;
 *
 * UPSTREAM PROPAGATION:
 *   If an upstream gateway or client sends X-Correlation-ID or X-Request-ID,
 *   we honour it rather than generating a new one. This enables end-to-end
 *   tracing across microservices or API gateway boundaries.
 */
const correlationMiddleware = (req, res, next) => {
  const incoming =
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    req.headers['traceparent']; // W3C TraceContext header

  req.correlationId = (incoming && isValidCorrelationId(incoming))
    ? incoming
    : uuidv4();

  // Surface to caller — useful for client-side error reporting
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
};

/**
 * Validate incoming correlation IDs to prevent injection attacks.
 * Accept UUIDv4, W3C traceparent, or alphanumeric+dash up to 128 chars.
 */
function isValidCorrelationId(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.length > 128) return false;
  return /^[a-zA-Z0-9\-_\.]+$/.test(value);
}

module.exports = { correlationMiddleware };