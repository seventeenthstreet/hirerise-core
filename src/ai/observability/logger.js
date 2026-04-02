'use strict';

/**
 * ai/observability/ai-logger.js — PRODUCTION HARDENED
 *
 * High-resolution timing + structured observability logging
 */

let baseLogger;

try {
  baseLogger = require('../../utils/logger');
} catch (err) {
  // fallback (never crash app)
  baseLogger = {
    info: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

// ─────────────────────────────────────────────
// AILogger
// ─────────────────────────────────────────────

const AILogger = {

  // ─────────────────────────────
  // TIMER
  // ─────────────────────────────

  startTimer() {
    return process.hrtime();
  },

  elapsedMs(timer) {
    if (!Array.isArray(timer) || timer.length !== 2) return 0;

    const diff = process.hrtime(timer);
    return (diff[0] * 1000) + (diff[1] / 1_000_000);
  },

  // ─────────────────────────────
  // MEASURE
  // ─────────────────────────────

  async measure(fn, context = {}) {
    const start = process.hrtime(); // ❗ no `this`

    try {
      const result = await fn();

      const duration = this.elapsedMs(start);

      baseLogger.info('[AI Latency]', {
        durationMs: +duration.toFixed(2),
        success: true,
        ...context,
      });

      return result;

    } catch (err) {
      const duration = this.elapsedMs(start);

      baseLogger.error('[AI Latency Error]', {
        durationMs: +duration.toFixed(2),
        success: false,
        error: err?.message,
        stack: err?.stack,
        ...context,
      });

      throw err;
    }
  },

  // ─────────────────────────────
  // MANUAL LOG
  // ─────────────────────────────

  logLatency(durationMs, context = {}) {
    baseLogger.info('[AI Latency]', {
      durationMs: +Number(durationMs || 0).toFixed(2),
      ...context,
    });
  }
};

module.exports = AILogger;