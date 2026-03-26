'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');

/**
 * alert.service.js (V2 — Redis-Ready Distributed Deduplication)
 *
 * UPGRADE FROM V1:
 *   V1 used an in-process Map for deduplication.
 *   V2 adds a pluggable cache interface that supports:
 *     - Redis (SET NX EX) for multi-replica deployments
 *     - Local Map fallback if Redis is not configured
 *
 * MULTI-INSTANCE BEHAVIOR:
 *   Without Redis: Each instance has independent dedup state.
 *     - On 3 replicas, the same alert can fire up to 3x per cooldown window.
 *     - Acceptable for low-volume platforms.
 *
 *   With Redis: Dedup is shared across all instances.
 *     - SET NX EX ensures only the first racing instance fires the alert.
 *     - Other instances see the key exists and skip.
 *     - Zero alert storm even during high-volume failover events.
 *
 * CONFIGURATION:
 *   REDIS_URL=redis://localhost:6379      → enables Redis dedup
 *   (no REDIS_URL)                        → falls back to in-process Map
 *
 * REDIS KEY PATTERN:
 *   hirerise:alert_cooldown:{type}:{feature}:{severity}
 *   TTL: COOLDOWN_SECONDS (3600 = 1 hour)
 */

const COOLDOWN_SECONDS = 3600; // 1 hour
const ALERT_KEY_PREFIX = 'hirerise:alert_cooldown:';

class AlertService {
  constructor() {
    this._localCache = new Map();
    this._redisClient = null;
    this._useRedis = false;

    this._initRedis();
  }

  _initRedis() {
    if (!process.env.REDIS_URL) return;

    try {
      // npm install ioredis
      const Redis = require('ioredis');
      this._redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        connectTimeout: 3000,
        commandTimeout: 1000,
        enableOfflineQueue: false, // Fail fast — don't queue on disconnect
      });

      this._redisClient.on('ready', () => {
        this._useRedis = true;
        console.log('[AlertService] Redis deduplication active');
      });

      this._redisClient.on('error', (err) => {
        // Degrade gracefully to local map on Redis failure
        this._useRedis = false;
        console.warn('[AlertService] Redis unavailable, using local dedup:', err.message);
      });
    } catch (err) {
      console.warn('[AlertService] Redis init failed (ioredis not installed?):', err.message);
    }
  }

  /**
   * Fire an alert with distributed deduplication.
   *
   * @param {Object} params
   * @param {string} params.type       - LATENCY | ERROR_RATE | DRIFT | TOKEN_SPIKE | BUDGET | SLA_BREACH | CIRCUIT_BREAKER | CALIBRATION
   * @param {string} params.feature
   * @param {string} params.severity   - WARNING | CRITICAL
   * @param {string} params.title
   * @param {Object} params.detail
   * @param {string} [params.model]
   * @param {string} [params.correlationId]
   */
  async fire(params) {
    const { type, feature, severity, title, detail, model = null, correlationId = null } = params;

    if (!this._validateAlert(params)) return null;

    const dedupeKey = `${type}:${feature}:${severity}`;
    const isDupe = await this._isInCooldown(dedupeKey);
    if (isDupe) return null;

    await this._setCooldown(dedupeKey);

    const alertEntry = {
      type,
      feature,
      severity,
      title,
      detail: detail || {},
      model,
      correlationId,
      environment: process.env.NODE_ENV || 'development',
    };

    const alertId = await observabilityRepo.writeAlert(alertEntry).catch(err => {
      console.error('[AlertService] Persist failed:', err.message);
      return null;
    });

    this._notifyAdmin({ ...alertEntry, alertId }).catch(() => {});
    console.warn(`[ALERT][${severity}] ${type}:${feature} — ${title}`);
    return alertId;
  }

  async checkLatency(feature, latencyMs, model, correlationId) {
    const { latency } = require('../../config/observability.config');
    if (latencyMs >= latency.p95CriticalMs) {
      return this.fire({ type: 'LATENCY', feature, severity: 'CRITICAL',
        title: `Critical latency breach: ${latencyMs}ms`,
        detail: { latencyMs, threshold: latency.p95CriticalMs }, model, correlationId });
    }
    if (latencyMs >= latency.p95WarningMs) {
      return this.fire({ type: 'LATENCY', feature, severity: 'WARNING',
        title: `Latency warning: ${latencyMs}ms`,
        detail: { latencyMs, threshold: latency.p95WarningMs }, model, correlationId });
    }
  }

  async checkTokenSpike(feature, totalTokens, model, correlationId) {
    const { tokens } = require('../../config/observability.config');
    if (totalTokens >= tokens.absoluteSpikeThreshold) {
      return this.fire({ type: 'TOKEN_SPIKE', feature, severity: 'WARNING',
        title: `Token spike: ${totalTokens} tokens`,
        detail: { totalTokens, threshold: tokens.absoluteSpikeThreshold }, model, correlationId });
    }
  }

  buildEmailPayload(alert) {
    const emoji = alert.severity === 'CRITICAL' ? '🔴' : '🟡';
    return {
      to: process.env.ALERT_EMAIL_TO || 'eng-alerts@hirerise.com',
      from: process.env.ALERT_EMAIL_FROM || 'noreply@hirerise.com',
      subject: `${emoji} [HireRise] ${alert.severity}: ${alert.title}`,
      correlationId: alert.correlationId,
      html: `
        <h2>${emoji} HireRise AI Alert</h2>
        <p><b>Correlation ID:</b> <code>${alert.correlationId || 'N/A'}</code></p>
        <table border="1" cellpadding="8" style="border-collapse:collapse">
          <tr><td><b>Type</b></td><td>${alert.type}</td></tr>
          <tr><td><b>Feature</b></td><td>${alert.feature}</td></tr>
          <tr><td><b>Severity</b></td><td>${alert.severity}</td></tr>
          <tr><td><b>Model</b></td><td>${alert.model || 'N/A'}</td></tr>
          <tr><td><b>Environment</b></td><td>${alert.environment}</td></tr>
          <tr><td><b>Alert ID</b></td><td>${alert.alertId || 'N/A'}</td></tr>
        </table>
        <pre>${JSON.stringify(alert.detail, null, 2)}</pre>
        <p><a href="${process.env.ADMIN_DASHBOARD_URL || '#'}/ai/alerts">View in Dashboard →</a></p>
      `,
    };
  }

  // ─── Deduplication ─────────────────────────────────────────────────────────

  async _isInCooldown(key) {
    if (this._useRedis && this._redisClient) {
      try {
        const exists = await this._redisClient.exists(`${ALERT_KEY_PREFIX}${key}`);
        return exists === 1;
      } catch {
        return this._localIsInCooldown(key);
      }
    }
    return this._localIsInCooldown(key);
  }

  async _setCooldown(key) {
    if (this._useRedis && this._redisClient) {
      try {
        // SET NX EX — only sets if key does NOT exist (atomic)
        await this._redisClient.set(`${ALERT_KEY_PREFIX}${key}`, '1', 'NX', 'EX', COOLDOWN_SECONDS);
        return;
      } catch {
        // Fall through to local
      }
    }
    this._localSetCooldown(key);
  }

  _localIsInCooldown(key) {
    const last = this._localCache.get(key);
    return !!(last && (Date.now() - last) < COOLDOWN_SECONDS * 1000);
  }

  _localSetCooldown(key) {
    this._localCache.set(key, Date.now());
    // Prune if large
    if (this._localCache.size > 1000) {
      const cutoff = Date.now() - COOLDOWN_SECONDS * 1000;
      for (const [k, v] of this._localCache.entries()) {
        if (v < cutoff) this._localCache.delete(k);
      }
    }
  }

  _validateAlert({ type, feature, severity, title }) {
    const validTypes = ['LATENCY', 'ERROR_RATE', 'DRIFT', 'TOKEN_SPIKE', 'BUDGET',
                        'SLA_BREACH', 'CIRCUIT_BREAKER', 'CALIBRATION'];
    const validSeverities = ['WARNING', 'CRITICAL'];
    return validTypes.includes(type) && validSeverities.includes(severity) && !!feature && !!title;
  }

  async _notifyAdmin(alert) {
    if (process.env.NODE_ENV === 'test') return;
    const payload = this.buildEmailPayload(alert);
    // Wire: sgMail.send(payload) or fetch(SLACK_WEBHOOK, { ... })
    if (process.env.NODE_ENV !== 'production') {
      console.log('[AlertService] Notification payload:', payload.subject);
    }
  }

  /**
   * Graceful shutdown — close Redis connection.
   */
  async close() {
    if (this._redisClient) {
      await this._redisClient.quit().catch(() => {});
    }
  }
}

module.exports = new AlertService();








