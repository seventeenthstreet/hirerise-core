'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const logger = require('../../utils/logger');

const COOLDOWN_SECONDS = 3600; // 1 hour
const ALERT_KEY_PREFIX = 'hirerise:alert_cooldown:';

class AlertService {
  constructor() {
    this._localCache = new Map();
    this._redisClient = null;
    this._useRedis = false;

    this._initRedis();
  }

  // ─────────────────────────────────────────────
  // REDIS INIT
  // ─────────────────────────────────────────────

  _initRedis() {
    if (!process.env.REDIS_URL) return;

    try {
      const Redis = require('ioredis');

      this._redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        connectTimeout: 3000,
        commandTimeout: 1000,
        enableOfflineQueue: false,
      });

      this._redisClient.on('ready', () => {
        this._useRedis = true;
        logger.info('[AlertService] Redis deduplication active');
      });

      this._redisClient.on('error', (err) => {
        this._useRedis = false;
        logger.warn('[AlertService] Redis unavailable, using local dedup', {
          error: err.message,
        });
      });

      this._redisClient.on('reconnecting', () => {
        logger.warn('[AlertService] Redis reconnecting...');
      });

      // ✅ CRITICAL: actually connect
      this._redisClient.connect().catch(() => {
        this._useRedis = false;
      });

    } catch (err) {
      logger.warn('[AlertService] Redis init failed', {
        error: err.message,
      });
    }
  }

  // ─────────────────────────────────────────────
  // MAIN ALERT METHOD
  // ─────────────────────────────────────────────

  async fire(params) {
    const {
      type,
      feature,
      severity,
      title,
      detail,
      model = null,
      correlationId = null,
    } = params;

    if (!this._validateAlert(params)) return null;

    // ✅ Improved dedupe key
    const dedupeKey = `${type}:${feature}:${severity}:${model || 'na'}:${process.env.NODE_ENV || 'dev'}`;

    // ✅ Atomic dedup check
    const allowed = await this._trySetCooldown(dedupeKey);
    if (!allowed) return null;

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

    // ✅ Timeout protection
    const alertId = await Promise.race([
      observabilityRepo.writeAlert(alertEntry),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]).catch((err) => {
      logger.error('[AlertService] Persist failed', {
        error: err.message,
      });
      return null;
    });

    this._notifyAdmin({ ...alertEntry, alertId }).catch(() => {});

    logger.warn('[ALERT]', {
      type,
      feature,
      severity,
      title,
    });

    return alertId;
  }

  // ─────────────────────────────────────────────
  // ALERT CHECKS
  // ─────────────────────────────────────────────

  async checkLatency(feature, latencyMs, model, correlationId) {
    const { latency } = require('../../config/observability.config');

    if (latencyMs >= latency.p95CriticalMs) {
      return this.fire({
        type: 'LATENCY',
        feature,
        severity: 'CRITICAL',
        title: `Critical latency breach: ${latencyMs}ms`,
        detail: { latencyMs, threshold: latency.p95CriticalMs },
        model,
        correlationId,
      });
    }

    if (latencyMs >= latency.p95WarningMs) {
      return this.fire({
        type: 'LATENCY',
        feature,
        severity: 'WARNING',
        title: `Latency warning: ${latencyMs}ms`,
        detail: { latencyMs, threshold: latency.p95WarningMs },
        model,
        correlationId,
      });
    }
  }

  async checkTokenSpike(feature, totalTokens, model, correlationId) {
    const { tokens } = require('../../config/observability.config');

    if (totalTokens >= tokens.absoluteSpikeThreshold) {
      return this.fire({
        type: 'TOKEN_SPIKE',
        feature,
        severity: 'WARNING',
        title: `Token spike: ${totalTokens}`,
        detail: { totalTokens, threshold: tokens.absoluteSpikeThreshold },
        model,
        correlationId,
      });
    }
  }

  // ─────────────────────────────────────────────
  // DEDUP (ATOMIC)
  // ─────────────────────────────────────────────

  async _trySetCooldown(key) {
    if (this._useRedis && this._redisClient) {
      try {
        const result = await this._redisClient.set(
          `${ALERT_KEY_PREFIX}${key}`,
          '1',
          'NX',
          'EX',
          COOLDOWN_SECONDS
        );

        return result === 'OK'; // true = allowed
      } catch {
        return this._localTrySetCooldown(key);
      }
    }

    return this._localTrySetCooldown(key);
  }

  _localTrySetCooldown(key) {
    const now = Date.now();
    const last = this._localCache.get(key);

    if (last && now - last < COOLDOWN_SECONDS * 1000) {
      return false;
    }

    this._localCache.set(key, now);

    // prune
    if (this._localCache.size > 1000) {
      const cutoff = now - COOLDOWN_SECONDS * 1000;
      for (const [k, v] of this._localCache.entries()) {
        if (v < cutoff) this._localCache.delete(k);
      }
    }

    return true;
  }

  // ─────────────────────────────────────────────
  // VALIDATION
  // ─────────────────────────────────────────────

  _validateAlert({ type, feature, severity, title }) {
    const validTypes = [
      'LATENCY',
      'ERROR_RATE',
      'DRIFT',
      'TOKEN_SPIKE',
      'BUDGET',
      'SLA_BREACH',
      'CIRCUIT_BREAKER',
      'CALIBRATION',
    ];

    const validSeverities = ['WARNING', 'CRITICAL'];

    return (
      validTypes.includes(type) &&
      validSeverities.includes(severity) &&
      !!feature &&
      !!title
    );
  }

  // ─────────────────────────────────────────────
  // NOTIFICATION
  // ─────────────────────────────────────────────

  async _notifyAdmin(alert) {
    if (process.env.NODE_ENV === 'test') return;

    if (process.env.NODE_ENV !== 'production') {
      logger.info('[AlertService] Notification', {
        subject: alert.title,
      });
    }

    // plug: email / slack later
  }

  // ─────────────────────────────────────────────
  // SHUTDOWN
  // ─────────────────────────────────────────────

  async close() {
    if (this._redisClient) {
      await this._redisClient.quit().catch(() => {});
    }
  }
}

module.exports = new AlertService();