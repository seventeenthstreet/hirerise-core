'use strict';

/**
 * observability-adapter.js — src/ai/observability/
 *
 * ✅ No ESM issues
 * ✅ Fixes Winston binding bug
 * ✅ Works with existing project (CommonJS)
 * ✅ Production safe
 * ✅ Lazy singleton — safe against require-time crashes
 * ✅ prometheusMetricsHandler — safe noop unless OBSERVABILITY_BACKEND=prometheus
 */

let logger;

try {
  logger = require('../../utils/logger'); // ✅ correct path from src/ai/observability/
} catch (e) {
  logger = {
    info: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

class ObservabilityAdapter {
  constructor() {
    this.backend = process.env.OBSERVABILITY_BACKEND || 'noop';

    // ✅ bind logger methods (CRITICAL for Winston)
    this._log = {
      info: typeof logger.info === 'function'
        ? logger.info.bind(logger)
        : console.log,

      warn: typeof logger.warn === 'function'
        ? logger.warn.bind(logger)
        : console.warn,

      error: typeof logger.error === 'function'
        ? logger.error.bind(logger)
        : console.error,
    };

    // ✅ Safe constructor log — won't crash require chain
    try {
      this._log.info('[Observability] Initialized', {
        backend: this.backend,
      });
    } catch (e) {
      console.log('[Observability] Initialized (fallback)', {
        backend: this.backend,
      });
    }
  }

  // ─────────────────────────────
  // METRICS
  // ─────────────────────────────

  emitMetric(name, value, labels = {}, type = 'histogram') {
    try {
      if (this.backend === 'console') {
        this._log.info('[Metric]', {
          name,
          value,
          type,
          labels,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this._log.warn('[Observability] emitMetric failed', {
        error: err?.message,
      });
    }
  }

  // ─────────────────────────────
  // TRACE
  // ─────────────────────────────

  emitTrace(spanName, attributes = {}, correlationId = null) {
    const start = Date.now();

    try {
      if (this.backend === 'console') {
        this._log.info('[Trace:start]', {
          spanName,
          correlationId,
          attributes,
        });
      }

      return {
        end: () => {
          if (this.backend === 'console') {
            this._log.info('[Trace:end]', {
              spanName,
              durationMs: Date.now() - start,
            });
          }
        },

        setStatus: (code, message) => {
          if (this.backend === 'console') {
            this._log.info('[Trace:status]', {
              spanName,
              code,
              message,
            });
          }
        },

        recordException: (err) => {
          this._log.error('[Trace:error]', {
            spanName,
            error: err?.message || err,
          });
        },

        setAttribute: (key, value) => {
          if (this.backend === 'console') {
            this._log.info('[Trace:attr]', {
              spanName,
              key,
              value,
            });
          }
        },
      };

    } catch (err) {
      this._log.warn('[Observability] emitTrace failed', {
        error: err?.message,
      });

      return this._noopSpan();
    }
  }

  // ─────────────────────────────
  // AI EVENT
  // ─────────────────────────────

  emitInferenceEvent({
    feature,
    model,
    latencyMs,
    success,
    tokensTotal,
    confidenceScore,
  }) {
    const labels = {
      feature,
      model,
      success: String(success),
    };

    this.emitMetric('ai.inference.latency_ms', latencyMs, labels);
    this.emitMetric('ai.inference.total', 1, labels, 'counter');

    if (!success) {
      this.emitMetric('ai.inference.errors', 1, labels, 'counter');
    }

    if (tokensTotal != null) {
      this.emitMetric('ai.tokens.total', tokensTotal, labels);
    }

    if (confidenceScore != null) {
      this.emitMetric('ai.confidence', confidenceScore, labels, 'gauge');
    }
  }

  // ─────────────────────────────
  // PROMETHEUS METRICS HANDLER
  // ─────────────────────────────

  /**
   * prometheusMetricsHandler()
   *
   * Returns an Express middleware for the /metrics endpoint.
   * - OBSERVABILITY_BACKEND=prometheus + prom-client installed → real Prometheus metrics
   * - Everything else → safe 204 noop, server never crashes
   */
  prometheusMetricsHandler() {
    if (this.backend === 'prometheus') {
      try {
        const promClient = require('prom-client');
        promClient.collectDefaultMetrics();

        return async (req, res) => {
          try {
            res.set('Content-Type', promClient.register.contentType);
            res.end(await promClient.register.metrics());
          } catch (err) {
            this._log.error('[Observability] Prometheus metrics error', {
              error: err?.message,
            });
            res.status(500).end();
          }
        };
      } catch (e) {
        this._log.warn('[Observability] OBSERVABILITY_BACKEND=prometheus but prom-client is not installed. Falling back to noop.');
      }
    }

    // ✅ Safe noop for noop/otel/missing prom-client
    return (_req, res) => res.status(204).end();
  }

  // ─────────────────────────────
  // INTERNAL
  // ─────────────────────────────

  _noopSpan() {
    return {
      end: () => {},
      setStatus: () => {},
      recordException: () => {},
      setAttribute: () => {},
    };
  }
}

// ✅ Lazy singleton — instance created on first use only
let _instance = null;

function getInstance() {
  if (!_instance) {
    _instance = new ObservabilityAdapter();
  }
  return _instance;
}

// ✅ Proxy lets existing code use adapter.emitMetric(...) etc. directly
module.exports = new Proxy({}, {
  get(_, prop) {
    return getInstance()[prop];
  }
});