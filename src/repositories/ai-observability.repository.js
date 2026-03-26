'use strict';

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

const OBSERVABILITY_CONFIG = require('../config/observability.config');

class AIObservabilityRepository {

  // ─── AI LOGS ─────────────────────────────────────────────────────────────

  async writeLog(logEntry) {
    const record = {
      ...logEntry,
      created_at: new Date().toISOString(),
      expires_at: this._ttlDate(OBSERVABILITY_CONFIG.retention.aiLogsRetentionDays),
      is_deleted: false,
    };

    const { data, error } = await supabase
      .from('ai_logs')
      .insert(record)
      .select()
      .single();

    if (error) throw error;
    return data.id;
  }

  async batchWriteLogs(logEntries) {
    const records = logEntries.map(entry => ({
      ...entry,
      created_at: new Date().toISOString(),
      expires_at: this._ttlDate(OBSERVABILITY_CONFIG.retention.aiLogsRetentionDays),
      is_deleted: false,
    }));

    const { error } = await supabase.from('ai_logs').insert(records);
    if (error) throw error;
  }

  async getLogsByFeature(feature, { limit = 500 } = {}) {
    const { data, error } = await supabase
      .from('ai_logs')
      .select('*')
      .eq('feature', feature)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // ─── DAILY METRICS ───────────────────────────────────────────────────────

  async upsertDailyMetrics(feature, dateStr, payload) {
    const record = {
      id: `${feature}_${dateStr}`,
      feature,
      date: dateStr,
      ...payload,
      updated_at: new Date().toISOString(),
      expires_at: this._ttlDate(OBSERVABILITY_CONFIG.retention.metricsRetentionDays),
      is_deleted: false,
    };

    const { error } = await supabase.from('ai_metrics_daily').upsert(record);
    if (error) throw error;

    return record.id;
  }

  async getDailyMetrics(feature, { limit = 90 } = {}) {
    const { data, error } = await supabase
      .from('ai_metrics_daily')
      .select('*')
      .eq('feature', feature)
      .eq('is_deleted', false)
      .order('date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  async getAggregatedMetricsSummary({ limit = 30 } = {}) {
    const { data, error } = await supabase
      .from('ai_metrics_daily')
      .select('*')
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // ─── DRIFT ───────────────────────────────────────────────────────────────

  async writeDriftSnapshot(entry) {
    const record = {
      ...entry,
      created_at: new Date().toISOString(),
      expires_at: this._ttlDate(OBSERVABILITY_CONFIG.retention.driftRetentionDays),
      is_deleted: false,
    };

    const { data, error } = await supabase
      .from('ai_drift_tracking')
      .insert(record)
      .select()
      .single();

    if (error) throw error;
    return data.id;
  }

  async getDriftSummary({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from('ai_drift_tracking')
      .select('*')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // ─── COST ────────────────────────────────────────────────────────────────

  async upsertCostEntry(userId, feature, dateStr, delta) {
    const id = `${userId}_${feature}_${dateStr}`;

    const record = {
      id,
      user_id: userId,
      feature,
      date: dateStr,
      total_cost_usd: delta.totalCostUSD || 0,
      input_tokens: delta.inputTokens || 0,
      output_tokens: delta.outputTokens || 0,
      call_count: 1,
      updated_at: new Date().toISOString(),
      expires_at: this._ttlDate(OBSERVABILITY_CONFIG.retention.costRetentionDays),
      is_deleted: false,
    };

    const { error } = await supabase.from('ai_cost_tracking').upsert(record);
    if (error) throw error;

    return id;
  }

  async getCostByDateRange(from, to) {
    const { data, error } = await supabase
      .from('ai_cost_tracking')
      .select('*')
      .gte('date', from)
      .lte('date', to)
      .eq('is_deleted', false);

    if (error) throw error;
    return data || [];
  }

  // ─── ALERTS ──────────────────────────────────────────────────────────────

  async writeAlert(entry) {
    const record = {
      ...entry,
      created_at: new Date().toISOString(),
      expires_at: this._ttlDate(OBSERVABILITY_CONFIG.retention.alertsRetentionDays),
      resolved: false,
      is_deleted: false,
    };

    const { data, error } = await supabase
      .from('ai_alerts')
      .insert(record)
      .select()
      .single();

    if (error) throw error;
    return data.id;
  }

  async getActiveAlerts({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from('ai_alerts')
      .select('*')
      .eq('resolved', false)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  async resolveAlert(alertId, resolvedBy) {
    const { error } = await supabase
      .from('ai_alerts')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
      })
      .eq('id', alertId);

    if (error) throw error;
  }

  // ─── UTIL ────────────────────────────────────────────────────────────────

  _ttlDate(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }
}

module.exports = new AIObservabilityRepository();





