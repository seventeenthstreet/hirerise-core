'use strict';

/**
 * observability-adapter.js
 *
 * ObservabilityAdapter — Abstraction layer over observability backends.
 *
 * WHY THIS EXISTS:
 *   HireRise currently writes all observability data to Firestore.
 *   As the platform matures, engineering teams adopt Datadog, Grafana, or
 *   self-hosted Prometheus. This adapter decouples the observability
 *   instrumentation points (MetricsService, DriftService, etc.) from
 *   the specific backends they emit to.
 *
 *   Adding a new backend = implement adapter + set OBSERVABILITY_BACKEND env var.
 *   Zero changes to services, middleware, or repositories.
 *
 * BACKENDS SUPPORTED:
 *   noop        → dev/test mode; all emissions are no-ops (default if not configured)
 *   otel        → OpenTelemetry SDK; exports to any OTLP-compatible backend
 *                 (Datadog, Grafana Tempo, Jaeger, Honeycomb, etc.)
 *   prometheus  → Exposes /metrics endpoint for Prometheus scraping
 *
 * CONFIGURATION:
 *   OBSERVABILITY_BACKEND=otel
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.datadoghq.com/api/intake/otlp
 *   OTEL_SERVICE_NAME=hirerise-core
 *
 * DATADOG INTEGRATION:
 *   Set OBSERVABILITY_BACKEND=otel
 *   Set OTEL_EXPORTER_OTLP_ENDPOINT to Datadog OTLP endpoint
 *   Metrics appear in Datadog as custom metrics under hirerise.ai.*
 *   Traces appear in Datadog APM with correlationId as trace ID
 *
 * GRAFANA INTEGRATION:
 *   Deploy OpenTelemetry Collector sidecar
 *   Route OTLP to Grafana Tempo (traces) and Mimir (metrics)
 *   Build dashboards on hirerise_ai_* metric namespace
 */

class ObservabilityAdapter {
  constructor() {
    this._backend = process.env.OBSERVABILITY_BACKEND || 'noop';
    this._tracer = null;
    this._meter = null;
    this._prometheusCounters = {};
    this._prometheusHistograms = {};

    this._init();
  }

  _init() {
    if (this._backend === 'otel') {
      this._initOTel();
    } else if (this._backend === 'prometheus') {
      this._initPrometheus();
    }
    // noop: nothing to initialize
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Emit a metric (counter or histogram).
   * Always succeeds — backends fail silently.
   *
   * @param {string} name      - metric name, e.g. 'ai.inference.latency_ms'
   * @param {number} value
   * @param {Object} labels    - e.g. { feature: 'resume_scoring', model: 'gpt-4o' }
   * @param {string} type      - 'counter' | 'histogram' | 'gauge'
   */
  emitMetric(name, value, labels = {}, type = 'histogram') {
    try {
      if (this._backend === 'otel' && this._meter) {
        this._otelEmitMetric(name, value, labels, type);
      } else if (this._backend === 'prometheus') {
        this._prometheusEmitMetric(name, value, labels, type);
      }
      // noop: silent
    } catch {
      // Never propagate adapter errors to callers
    }
  }

  /**
   * Emit a trace span.
   * In noop mode: returns a dummy span with no-op methods.
   *
   * @param {string} spanName
   * @param {Object} attributes    - span attributes
   * @param {string} correlationId - maps to traceId for correlation
   * @returns {{ end: Function, setStatus: Function, recordException: Function }}
   */
  emitTrace(spanName, attributes = {}, correlationId = null) {
    if (this._backend === 'otel' && this._tracer) {
      return this._otelEmitTrace(spanName, attributes, correlationId);
    }
    return this._noopSpan();
  }

  /**
   * Emit a standard AI inference event with all key metrics.
   * Convenience wrapper — calls emitMetric + emitTrace.
   */
  emitInferenceEvent({ feature, model, latencyMs, success, tokensTotal, confidenceScore, correlationId }) {
    const labels = { feature, model, success: String(success) };

    this.emitMetric('hirerise.ai.inference.latency_ms', latencyMs, labels, 'histogram');
    this.emitMetric('hirerise.ai.inference.total', 1, labels, 'counter');
    if (!success) {
      this.emitMetric('hirerise.ai.inference.errors', 1, labels, 'counter');
    }
    if (tokensTotal != null) {
      this.emitMetric('hirerise.ai.tokens.total', tokensTotal, labels, 'histogram');
    }
    if (confidenceScore != null) {
      this.emitMetric('hirerise.ai.confidence', confidenceScore, labels, 'gauge');
    }
  }

  // ─── OTel Backend ──────────────────────────────────────────────────────────

  _initOTel() {
    try {
      // Lazy-require OTel SDK — not a hard dependency
      // Install: npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
      //          @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-metrics
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
      const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
      const { trace, metrics } = require('@opentelemetry/api');

      const sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME || 'hirerise-core',
        traceExporter: new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        }),
      });

      sdk.start();

      // Metrics
      const meterProvider = new MeterProvider({
        readers: [new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
          exportIntervalMillis: 60000, // Export every 60s
        })],
      });
      metrics.setGlobalMeterProvider(meterProvider);

      this._tracer = trace.getTracer('hirerise-ai-observability', '2.0.0');
      this._meter = metrics.getMeter('hirerise-ai-observability', '2.0.0');

      console.log('[ObservabilityAdapter] OpenTelemetry initialized');
    } catch (err) {
      console.warn('[ObservabilityAdapter] OTel init failed (install @opentelemetry packages):', err.message);
      this._backend = 'noop';
    }
  }

  _otelEmitMetric(name, value, labels, type) {
    const safeName = name.replace(/\./g, '_');
    if (type === 'counter') {
      if (!this._prometheusCounters[safeName]) {
        this._prometheusCounters[safeName] = this._meter.createCounter(name);
      }
      this._prometheusCounters[safeName].add(value, labels);
    } else if (type === 'histogram') {
      if (!this._prometheusHistograms[safeName]) {
        this._prometheusHistograms[safeName] = this._meter.createHistogram(name);
      }
      this._prometheusHistograms[safeName].record(value, labels);
    } else if (type === 'gauge') {
      if (!this._prometheusCounters[safeName]) {
        this._prometheusCounters[safeName] = this._meter.createObservableGauge(name);
      }
    }
  }

  _otelEmitTrace(spanName, attributes, correlationId) {
    const ctx = correlationId
      ? this._contextWithCorrelationId(correlationId)
      : undefined;

    const span = ctx
      ? this._tracer.startSpan(spanName, { attributes }, ctx)
      : this._tracer.startSpan(spanName, { attributes });

    return {
      end: () => span.end(),
      setStatus: (code, message) => span.setStatus({ code, message }),
      recordException: (err) => span.recordException(err),
      setAttribute: (k, v) => span.setAttribute(k, v),
    };
  }

  _contextWithCorrelationId(correlationId) {
    try {
      const { context, trace } = require('@opentelemetry/api');
      // Inject correlationId as traceId for end-to-end linking
      const traceId = correlationId.replace(/-/g, '').padEnd(32, '0').slice(0, 32);
      const spanContext = { traceId, spanId: '0'.repeat(16), traceFlags: 1, isRemote: true };
      return trace.setSpanContext(context.active(), spanContext);
    } catch {
      return undefined;
    }
  }

  // ─── Prometheus Backend ────────────────────────────────────────────────────

  _initPrometheus() {
    try {
      const promClient = require('prom-client'); // npm install prom-client
      promClient.collectDefaultMetrics({ prefix: 'hirerise_' });
      this._promClient = promClient;
      console.log('[ObservabilityAdapter] Prometheus client initialized — expose /metrics endpoint');
    } catch (err) {
      console.warn('[ObservabilityAdapter] Prometheus init failed (install prom-client):', err.message);
      this._backend = 'noop';
    }
  }

  _prometheusEmitMetric(name, value, labels, type) {
    const safeName = name.replace(/\./g, '_');
    const labelNames = Object.keys(labels);

    if (type === 'counter') {
      if (!this._prometheusCounters[safeName]) {
        this._prometheusCounters[safeName] = new this._promClient.Counter({
          name: safeName, help: safeName, labelNames,
        });
      }
      this._prometheusCounters[safeName].inc(labels, value);
    } else if (type === 'histogram') {
      if (!this._prometheusHistograms[safeName]) {
        this._prometheusHistograms[safeName] = new this._promClient.Histogram({
          name: safeName, help: safeName, labelNames,
        });
      }
      this._prometheusHistograms[safeName].observe(labels, value);
    }
  }

  // ─── No-op Span ───────────────────────────────────────────────────────────

  _noopSpan() {
    return {
      end: () => {},
      setStatus: () => {},
      recordException: () => {},
      setAttribute: () => {},
    };
  }

  /**
   * Express route handler for Prometheus /metrics endpoint.
   * Mount: app.get('/metrics', adapter.prometheusMetricsHandler());
   */
  prometheusMetricsHandler() {
    return async (req, res) => {
      if (this._backend !== 'prometheus' || !this._promClient) {
        return res.status(404).send('Prometheus backend not configured');
      }
      res.set('Content-Type', this._promClient.register.contentType);
      res.send(await this._promClient.register.metrics());
    };
  }
}

// Export singleton
const adapter = new ObservabilityAdapter();
module.exports = adapter;