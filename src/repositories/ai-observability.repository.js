'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const OBSERVABILITY_CONFIG = require('../config/observability.config');

const DEFAULT_LIMITS = Object.freeze({
  logs: 500,
  metrics: 90,
  summary: 30,
  drift: 50,
  cost: 1000,
  alerts: 50,
});

const INSERT_CHUNK_SIZE = 500;
const COST_RPC = 'upsert_ai_cost_tracking_atomic';

class AIObservabilityRepository {
  constructor(db = supabase) {
    this.db = db;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // AI LOGS
  // ───────────────────────────────────────────────────────────────────────────

  async writeLog(logEntry = {}) {
    const record = this.#withAuditFields(
      logEntry,
      OBSERVABILITY_CONFIG.retention.aiLogsRetentionDays
    );

    const { data, error } = await this.db
      .from('ai_logs')
      .insert(record)
      .select('id')
      .single();

    this.#throwIfError(error, 'writeLog');
    return data?.id ?? null;
  }

  async batchWriteLogs(logEntries = []) {
    if (!Array.isArray(logEntries) || logEntries.length === 0) return 0;

    const retentionDays =
      OBSERVABILITY_CONFIG.retention.aiLogsRetentionDays;

    let inserted = 0;

    for (let i = 0; i < logEntries.length; i += INSERT_CHUNK_SIZE) {
      const chunk = logEntries.slice(i, i + INSERT_CHUNK_SIZE);
      const records = chunk.map((entry) =>
        this.#withAuditFields(entry, retentionDays)
      );

      const { error } = await this.db.from('ai_logs').insert(records);
      this.#throwIfError(error, 'batchWriteLogs');
      inserted += records.length;
    }

    return inserted;
  }

  async getLogsByFeature(feature, { limit = DEFAULT_LIMITS.logs } = {}) {
    const { data, error } = await this.db
      .from('ai_logs')
      .select('*')
      .eq('feature', feature)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(this.#safeLimit(limit, DEFAULT_LIMITS.logs));

    this.#throwIfError(error, 'getLogsByFeature');
    return data ?? [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DAILY METRICS
  // ───────────────────────────────────────────────────────────────────────────

  async upsertDailyMetrics(feature, dateStr, payload = {}) {
    const id = `${feature}_${dateStr}`;

    const record = {
      id,
      feature,
      date: dateStr,
      ...payload,
      updated_at: this.#now(),
      expires_at: this.#ttlDate(
        OBSERVABILITY_CONFIG.retention.metricsRetentionDays
      ),
      is_deleted: false,
    };

    const { error } = await this.db
      .from('ai_metrics_daily')
      .upsert(record, { onConflict: 'id' });

    this.#throwIfError(error, 'upsertDailyMetrics');
    return id;
  }

  async getDailyMetrics(feature, { limit = DEFAULT_LIMITS.metrics } = {}) {
    const { data, error } = await this.db
      .from('ai_metrics_daily')
      .select('*')
      .eq('feature', feature)
      .eq('is_deleted', false)
      .order('date', { ascending: false })
      .limit(this.#safeLimit(limit, DEFAULT_LIMITS.metrics));

    this.#throwIfError(error, 'getDailyMetrics');
    return data ?? [];
  }

  async getAggregatedMetricsSummary({
    limit = DEFAULT_LIMITS.summary,
  } = {}) {
    const { data, error } = await this.db
      .from('ai_metrics_daily')
      .select('*')
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .limit(this.#safeLimit(limit, DEFAULT_LIMITS.summary));

    this.#throwIfError(error, 'getAggregatedMetricsSummary');
    return data ?? [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DRIFT
  // ───────────────────────────────────────────────────────────────────────────

  async writeDriftSnapshot(entry = {}) {
    const record = this.#withAuditFields(
      entry,
      OBSERVABILITY_CONFIG.retention.driftRetentionDays
    );

    const { data, error } = await this.db
      .from('ai_drift_tracking')
      .insert(record)
      .select('id')
      .single();

    this.#throwIfError(error, 'writeDriftSnapshot');
    return data?.id ?? null;
  }

  async getDriftSummary({ limit = DEFAULT_LIMITS.drift } = {}) {
    const { data, error } = await this.db
      .from('ai_drift_tracking')
      .select('*')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(this.#safeLimit(limit, DEFAULT_LIMITS.drift));

    this.#throwIfError(error, 'getDriftSummary');
    return data ?? [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // COST TRACKING (RPC-FIRST WITH TABLE FALLBACK)
  // ───────────────────────────────────────────────────────────────────────────

  async upsertCostEntry(userId, feature, dateStr, delta = {}) {
    const rpcPayload = {
      p_user_id: userId,
      p_feature: feature,
      p_date: dateStr,
      p_total_cost_usd: this.#toNumber(delta.totalCostUSD),
      p_input_tokens: this.#toNumber(delta.inputTokens),
      p_output_tokens: this.#toNumber(delta.outputTokens),
      p_retention_days:
        OBSERVABILITY_CONFIG.retention.costRetentionDays,
    };

    const { data, error } = await this.db.rpc(COST_RPC, rpcPayload);

    // Wave 1 drift hardening:
    // fallback safely if RPC signature/table deployment lags behind code rollout.
    if (error && this.#isRpcDrift(error)) {
      logger.warn('AIObservabilityRepository.upsertCostEntry rpc drift fallback', {
        rpc: COST_RPC,
        code: error.code,
        message: error.message,
      });

      return this.#fallbackCostUpsert(userId, feature, dateStr, delta);
    }

    this.#throwIfError(error, 'upsertCostEntry');
    return data;
  }

  async getCostByDateRange(from, to, { limit = DEFAULT_LIMITS.cost } = {}) {
    const { data, error } = await this.db
      .from('ai_cost_tracking')
      .select('*')
      .gte('date', from)
      .lte('date', to)
      .eq('is_deleted', false)
      .order('date', { ascending: false })
      .limit(this.#safeLimit(limit, DEFAULT_LIMITS.cost));

    this.#throwIfError(error, 'getCostByDateRange');
    return data ?? [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ALERTS
  // ───────────────────────────────────────────────────────────────────────────

  async writeAlert(entry = {}) {
    const record = {
      ...this.#withAuditFields(
        entry,
        OBSERVABILITY_CONFIG.retention.alertsRetentionDays
      ),
      resolved: false,
    };

    const { data, error } = await this.db
      .from('ai_alerts')
      .insert(record)
      .select('id')
      .single();

    this.#throwIfError(error, 'writeAlert');
    return data?.id ?? null;
  }

  async getActiveAlerts({ limit = DEFAULT_LIMITS.alerts } = {}) {
    const { data, error } = await this.db
      .from('ai_alerts')
      .select('*')
      .eq('resolved', false)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(this.#safeLimit(limit, DEFAULT_LIMITS.alerts));

    this.#throwIfError(error, 'getActiveAlerts');
    return data ?? [];
  }

  async resolveAlert(alertId, resolvedBy) {
    const { error } = await this.db
      .from('ai_alerts')
      .update({
        resolved: true,
        resolved_at: this.#now(),
        resolved_by: resolvedBy,
      })
      .eq('id', alertId)
      .eq('resolved', false);

    this.#throwIfError(error, 'resolveAlert');
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  async #fallbackCostUpsert(userId, feature, dateStr, delta = {}) {
    const id = `${userId}_${feature}_${dateStr}`;

    const record = {
      id,
      user_id: userId,
      feature,
      date: dateStr,
      total_cost_usd: this.#toNumber(delta.totalCostUSD),
      input_tokens: this.#toNumber(delta.inputTokens),
      output_tokens: this.#toNumber(delta.outputTokens),
      updated_at: this.#now(),
      expires_at: this.#ttlDate(
        OBSERVABILITY_CONFIG.retention.costRetentionDays
      ),
      is_deleted: false,
    };

    const { error } = await this.db
      .from('ai_cost_tracking')
      .upsert(record, { onConflict: 'id' });

    this.#throwIfError(error, 'fallbackCostUpsert');
    return id;
  }

  #withAuditFields(record = {}, retentionDays) {
    return {
      ...record,
      created_at: record.created_at ?? this.#now(),
      expires_at:
        record.expires_at ?? this.#ttlDate(retentionDays),
      is_deleted: Boolean(record.is_deleted ?? false),
    };
  }

  #safeLimit(limit, fallback) {
    const value = Number(limit);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
  }

  #toNumber(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  #isRpcDrift(error) {
    const msg = String(error?.message || '').toLowerCase();
    return (
      error?.code === '42883' ||
      msg.includes('function') ||
      msg.includes('rpc') ||
      msg.includes('does not exist') ||
      msg.includes('schema cache')
    );
  }

  #now() {
    return new Date().toISOString();
  }

  #ttlDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + Number(days || 0));
    return date.toISOString();
  }

  #throwIfError(error, operation) {
    if (!error) return;

    logger.error(`AIObservabilityRepository.${operation} failed`, {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });

    throw error;
  }
}

module.exports = new AIObservabilityRepository();