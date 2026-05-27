'use strict';

/**
 * src/utils/apiResponse.js
 *
 * Lightweight response shape builders used by individual route handlers.
 *
 * V2 CANONICAL CONTRACT (Phase 1 — Contract Stabilization):
 *
 *   SUCCESS:  { success: true,  data: <payload>, meta: <object|null> }
 *   FAILURE:  { success: false, error: { code, message, details? } }
 *
 * MIGRATION NOTES:
 *   - success() previously included `error: null`  → removed (V2: success=true → no error field)
 *   - failure() previously included `data: null`   → removed (V2: success=false → no data field)
 *   - failure() previously always included `details` in error object → now only when non-null
 *
 * Callers that relied on `result.data` being null on failure should guard with
 * `if (result.success)` before accessing `data`.
 */

/**
 * Builds a V2 canonical success envelope.
 *
 * @param {*}            data  — response payload (null accepted, {} / [] preferred for clarity)
 * @param {object|null}  meta  — optional metadata (requestId, timestamp, etc.)
 */
function success(data = null, meta = null) {
  return {
    success: true,
    data,
    // `error` intentionally absent on success (V2 contract R1: success=true → error MUST be absent)
    meta,
  };
}

/**
 * Builds a V2 canonical failure envelope.
 *
 * @param {string}       code     — machine-readable error code (BackendErrorCode)
 * @param {string}       message  — human-readable description
 * @param {object|null}  details  — optional structured details (validation errors, upgradeUrl, etc.)
 */
function failure(code = 'INTERNAL_ERROR', message = 'Something went wrong', details = null) {
  const envelope = {
    success: false,
    // `data` intentionally absent on failure (V2 contract R2: success=false → data MUST be absent)
    error: {
      code,
      message,
    },
  };

  // Only attach `details` when present — keeps simple errors minimal
  if (details !== null && details !== undefined) {
    envelope.error.details = details;
  }

  return envelope;
}

module.exports = {
  success,
  failure,
};