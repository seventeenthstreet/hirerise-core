'use strict';

/**
 * ai/observability/logger.js
 *
 * AILogger — high-resolution timer utility for AI observability.
 * Used by shadow-model.service.js to measure latency of shadow calls.
 */

const AILogger = {
  /**
   * startTimer() — returns a high-resolution start timestamp.
   * @returns {[number, number]} hrtime tuple
   */
  startTimer() {
    return process.hrtime();
  },

  /**
   * elapsedMs(timer) — returns elapsed milliseconds since startTimer().
   * @param {[number, number]} timer — value returned by startTimer()
   * @returns {number} elapsed ms
   */
  elapsedMs(timer) {
    const [sec, ns] = process.hrtime(timer);
    return (sec * 1000) + (ns / 1_000_000);
  },
};

module.exports = AILogger;