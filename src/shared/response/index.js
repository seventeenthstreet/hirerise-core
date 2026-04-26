'use strict';

/**
 * src/shared/response/index.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Standard API response helpers — backward-compatible, additive only.
 *
 * DESIGN CONTRACT
 * ───────────────
 * Every response envelope:
 *
 *   {
 *     success:  boolean,        // always present
 *     data:     object | null,  // always present on success
 *     error?:   string,         // top-level string on failure
 *     meta?:    object,         // timestamp, requestId, processing, etc.
 *     // + any legacy fields spread via `extra` for backward compat
 *   }
 *
 * BACKWARD COMPATIBILITY
 * ──────────────────────
 * `sendSuccess` and `sendError` accept an `extra` param whose keys are spread
 * to the TOP LEVEL of the response so existing clients reading flat fields
 * (e.g. body.resumeId, body.message) continue to work without any changes.
 *
 *   sendSuccess(res, { resumeId }, { resumeId })
 *   → { success:true, data:{ resumeId }, resumeId, meta:{...} }
 *
 * USAGE
 * ─────
 *   const { sendSuccess, sendError } = require('../shared/response');
 *   sendSuccess(res, data, extra, meta, status)
 *   sendError(res, statusCode, message, code, extra)
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
// Task 5 — Primary res-sending helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sendSuccess — standard 2xx JSON response.
 *
 * @param {import('express').Response} res
 * @param {object|null}  data        — nested inside `data` envelope
 * @param {object}       [extra={}]  — spread to TOP LEVEL for backward compat
 * @param {object}       [meta={}]   — merged into `meta` envelope
 * @param {number}       [status=200]
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
 * @param {string}  message       — human-readable; also at `message` for compat
 * @param {string}  [code=null]   — machine-readable error code
 * @param {object}  [extra={}]    — spread to TOP LEVEL for backward compat
 */
function sendError(res, statusCode, message, code = null, extra = {}) {
  const body = {
    success: false,
    // Task 3: top-level `error` string for new clients
    error: message,
    // Backward compat: old clients reading `message`
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
// Legacy object-builders — kept intact; now add `error` alias for compat
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
    error: message,   // Task 3: additive — new top-level field
    message,          // backward compat
  };
  if (code) response.code = code;
  if (details && isPlainObject(details)) response.details = details;
  return response;
}

module.exports = Object.freeze({
  sendSuccess,
  sendError,
  successResponse,
  errorResponse,
});