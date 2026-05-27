'use strict';

/**
 * src/shared/response/index.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Standard API response helpers — backward-compatible, additive only.
 *
 * DESIGN CONTRACT (V2)
 * ────────────────────
 * Every application JSON response envelope:
 *
 *   {
 *     success:  boolean,        // ALWAYS present
 *     data:     object | null,  // ALWAYS present on success (may be null)
 *     error?:   { code, message },  // present on failure
 *     meta?:    { timestamp, requestId, ... }
 *     // + any legacy fields spread via `extra` for backward compat
 *   }
 *
 * EXEMPTIONS — do NOT use these helpers for:
 *   - Health / liveness / readiness probes  (/health, /health/live, /health/ready)
 *   - SSE / event-stream endpoints
 *   - File download / binary stream endpoints
 *   - Webhook ACK responses (see WEBHOOK_EXEMPTION below)
 *
 * These exemptions are intentional. See docs/api-contract-exemptions.md
 * for rationale and the full exemption registry.
 *
 * BACKWARD COMPATIBILITY
 * ──────────────────────
 * `sendSuccess` and `sendError` accept an `extra` param whose keys are spread
 * to the TOP LEVEL of the response so existing clients reading flat fields
 * (e.g. body.resumeId, body.message) continue to work without any changes.
 *
 * USAGE
 * ─────
 *   const { sendSuccess, sendError } = require('../shared/response');
 *   sendSuccess(res, data, extra, meta, status)
 *   sendError(res, statusCode, message, code, extra)
 *
 * CONTRACT ENFORCEMENT
 * ─────────────────────
 * All new application endpoints MUST use sendSuccess / sendError.
 * Inline res.json() is prohibited for application routes.
 * Violations will be caught by the ESLint rule: no-inline-res-json
 * (see .eslintrc — rule: local/no-inline-res-json)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function buildMeta(req, extra = {}) {
  return {
    timestamp: new Date().toISOString(),
    requestId:
      req?.correlationId ||
      req?.headers?.['x-correlation-id'] ||
      req?.headers?.['x-request-id'] ||
      null,
    ...(isPlainObject(extra) ? extra : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary res-sending helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sendSuccess — standard 2xx JSON response.
 *
 * @param {import('express').Response} res
 * @param {object|null}  data        — nested inside `data` envelope
 * @param {object}       [extra={}]  — spread to TOP LEVEL for backward compat
 * @param {object}       [meta={}]   — merged into `meta` envelope
 * @param {number}       [status=200]
 *
 * CONTRACT NOTE: data MAY be null for operations with no meaningful payload.
 * An empty object {} is not acceptable as data — use null explicitly.
 */
function sendSuccess(res, data = null, extra = {}, meta = {}, status = 200) {
  const body = {
    success: true,
    data,
    meta: buildMeta(res.req, isPlainObject(meta) ? meta : {}),
  };

  // Backward-compat: spread legacy flat fields so old clients keep working
  if (isPlainObject(extra) && Object.keys(extra).length) {
    Object.assign(body, extra);
  }

  return res.status(status).json(body);
}

/**
 * sendError — standard 4xx/5xx JSON response.
 *
 * @param {import('express').Response} res
 * @param {number}  statusCode
 * @param {string}  message       — human-readable; also at top-level `message` for compat
 * @param {string}  [code=null]   — machine-readable error code
 * @param {object}  [extra={}]    — spread to TOP LEVEL for backward compat
 *
 * CONTRACT NOTE (V2):
 *   error is the canonical V2 object: { code, message }
 *   Backward compat: top-level `message` field preserved for legacy consumers.
 */
function sendError(res, statusCode, message, code = null, extra = {}) {
  const body = {
    success: false,
    error: {
      code: code || 'INTERNAL_ERROR',
      message,
    },
    // Backward compat: legacy clients reading top-level `message` and `code`
    message,
    meta: buildMeta(res.req),
  };

  if (code) body.code = code;

  if (isPlainObject(extra) && Object.keys(extra).length) {
    Object.assign(body, extra);
  }

  return res.status(statusCode).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy object-builders — kept for consumers that build response bodies
// manually (e.g. error middleware). Prefer sendSuccess/sendError directly.
// ─────────────────────────────────────────────────────────────────────────────

function successResponse(data = null, message = 'Success', meta = null) {
  const response = { success: true, message, data };
  if (meta && isPlainObject(meta)) {
    response.meta = { timestamp: new Date().toISOString(), ...meta };
  }
  return response;
}

function errorResponse(message = 'Something went wrong', code = null, details = null) {
  const response = {
    success: false,
    error: {
      code: code || 'INTERNAL_ERROR',
      message,
    },
    message, // backward compat: legacy consumers reading top-level `message`
  };
  if (code) response.code = code; // backward compat: legacy consumers reading top-level `code`
  if (details && isPlainObject(details)) response.details = details;
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME ASSERTION (dev/test only)
// Validates that a response object conforms to V2 shape before it is sent.
// Called by assertV2Shape() below — never called in production hot paths.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * assertV2Shape — lightweight dev-time shape validator.
 *
 * Throws AssertionError in development/test; no-ops in production.
 * Use in unit tests or ad-hoc endpoint audits.
 *
 * @param {object} body  — the JSON body that would be sent
 * @param {string} [endpoint]  — endpoint label for error messages
 */
function assertV2Shape(body, endpoint = 'unknown') {
  if (process.env.NODE_ENV === 'production') return;

  const assert = require('assert');

  assert(
    typeof body === 'object' && body !== null && !Array.isArray(body),
    `[V2 Contract] ${endpoint}: body must be a plain object`,
  );

  assert(
    typeof body.success === 'boolean',
    `[V2 Contract] ${endpoint}: body.success must be boolean, got ${typeof body.success}`,
  );

  if (body.success === true) {
    assert(
      'data' in body,
      `[V2 Contract] ${endpoint}: success responses must include a 'data' key (may be null)`,
    );
  }

  if (body.success === false) {
    assert(
      typeof body.error === 'object' && body.error !== null,
      `[V2 Contract] ${endpoint}: error responses must include error: { code, message }`,
    );
  }
}

module.exports = Object.freeze({
  sendSuccess,
  sendError,
  successResponse,
  errorResponse,
  assertV2Shape,
});