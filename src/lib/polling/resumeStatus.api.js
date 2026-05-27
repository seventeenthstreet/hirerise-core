/**
 * src/lib/polling/resumeStatus.api.js
 *
 * Thin fetch wrapper for the canonical polling endpoint.
 *
 * Canonical endpoint: GET /api/v1/resumes/:resumeId/status
 *
 * Returns the raw JSON body — the poller engine interprets success/status.
 * Throws on network failure (non-2xx is treated as a network error by default;
 * 404 is surfaced as an error object rather than a throw since the poller
 * handles it via json.success === false).
 *
 * Import pattern:
 *   import { makeResumeFetcher } from '@/lib/polling/resumeStatus.api';
 *   const fetchStatus = makeResumeFetcher(resumeId, authToken);
 *   const poller = createResumePoller(resumeId, fetchStatus, callbacks);
 */

'use strict';

const BASE_URL = '/api/v1';

/**
 * makeResumeFetcher
 *
 * Returns a zero-argument async function that fetches the status of a specific
 * resume. Designed to be passed directly into createResumePoller() or
 * useResumePoller().
 *
 * @param {string} resumeId   - The stable resume UUID.
 * @param {string} authToken  - Bearer token for Authorization header.
 * @returns {() => Promise<object>}
 */
export function makeResumeFetcher(resumeId, authToken) {
  if (!resumeId) {
    throw new Error('[makeResumeFetcher] resumeId is required');
  }

  return async function fetchResumeStatus() {
    const url = `${BASE_URL}/resumes/${encodeURIComponent(resumeId)}/status`;

    let response;

    // Network errors propagate to the poller engine for retry handling
    response = await fetch(url, {
      method:  'GET',
      headers: {
        'Content-Type':  'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    });

    // Parse body regardless of HTTP status so the poller can read json.success
    let body;
    try {
      body = await response.json();
    } catch {
      // Unparseable body — treat as a network-level failure
      const err = new Error(`Unparseable response (HTTP ${response.status})`);
      err.httpStatus = response.status;
      throw err;
    }

    // 401/403 — auth failure, no point retrying
    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error:   'Authentication required.',
        code:    'UNAUTHORIZED',
      };
    }

    // 5xx — treat as a retryable network error so the poller applies backoff
    if (response.status >= 500) {
      const err = new Error(`Server error (HTTP ${response.status})`);
      err.httpStatus = response.status;
      throw err;
    }

    // 2xx and 4xx — return as-is; poller reads json.success
    return body;
  };
}