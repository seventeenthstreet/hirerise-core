'use strict';

/**
 * systemHealth.service.js — WP-7 Phase 1 stub.
 *
 * Returns a static health snapshot derived from process environment.
 * No database queries. No external probes. Minimal runtime overhead.
 *
 * WP-13 EXTENSION POINT:
 *   Replace stub body with real health aggregation:
 *     const [dbOk, apiOk, errorRate] = await Promise.allSettled([
 *       probeFirestore(),
 *       probeClaudeApi(),
 *       adminMetricsService.getErrorRate24h(),
 *     ]);
 *     const status = deriveStatus(dbOk, apiOk);
 *     return { status, environment, build_version, error_rate_24h: errorRate, checked_at };
 *
 * RETURN SHAPE (matches frontend SystemHealthResponse):
 *   status:         'healthy' | 'degraded' | 'down'
 *   environment:    'production' | 'staging' | 'development'
 *   build_version:  string
 *   error_rate_24h: number
 *   checked_at:     string  (ISO-8601 UTC)
 */

/**
 * Returns a system health snapshot.
 * Phase 1: always returns 'healthy' with environment-derived values.
 * Safe to call on every dashboard refresh — no I/O in Phase 1.
 *
 * @returns {Promise<Object>}
 */
async function getSystemHealthStatus() {
  const rawEnv = process.env.NODE_ENV || 'development';

  const environment =
    rawEnv === 'production' ? 'production' :
    rawEnv === 'staging'    ? 'staging'    :
    'development';

  return {
    status:         'healthy',
    environment,
    build_version:  process.env.BUILD_VERSION || 'dev',
    error_rate_24h: 0,
    checked_at:     new Date().toISOString(),
  };
}

module.exports = { getSystemHealthStatus };