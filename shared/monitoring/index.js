'use strict';

/**
 * shared/monitoring/index.js
 * Production-grade monitoring barrel export
 */

/* ---------------- SAFE REQUIRE ---------------- */

function safeRequire(path) {
  try {
    return require(path);
  } catch (err) {
    console.error(`[Monitoring] Failed to load ${path}:`, err.message);
    return {};
  }
}

/* ---------------- MODULE LOAD ---------------- */

const alertsModule = safeRequire('./alerts.js');
const metricsModule = safeRequire('./metrics.js');
const sanitizeModule = safeRequire('./sanitize.js');

/* ---------------- VERSION ---------------- */

const MONITORING_VERSION = '1.0.0';

/* ---------------- EXPORT ---------------- */

module.exports = {
  // versioning
  MONITORING_VERSION,

  // alerts
  sendAlert: alertsModule.sendAlert,
  alert: alertsModule.alert,
  SEVERITY: alertsModule.SEVERITY,

  // metrics
  recordRequest: metricsModule.recordRequest,
  getMetricsSnapshot: metricsModule.getMetricsSnapshot,
  trackQuery: metricsModule.trackQuery,
  attachMetrics: metricsModule.attachMetrics,
  SLOW_REQUEST_THRESHOLD_MS:
    metricsModule.SLOW_REQUEST_THRESHOLD_MS,

  // sanitization
  sanitizeBody: sanitizeModule.sanitizeBody,
  sanitizeHeaders: sanitizeModule.sanitizeHeaders,

  /* -------- grouped (future-proof API) -------- */

  alerts: alertsModule,
  metrics: metricsModule,
  sanitize: sanitizeModule,
};