'use strict';

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const OBSERVABILITY_CONFIG = require('../config/observability.config');

/**
 * Repository: AI Observability Logs
 * 
 * Firestore Collections:
 *   ai_logs              - per-call structured logs (TTL: 90 days)
 *   ai_metrics_daily     - daily aggregated metrics per feature (TTL: 365 days)
 *   ai_drift_tracking    - drift snapshots per feature (TTL: 180 days)
 *   ai_cost_tracking     - cost ledger per user/feature/day (TTL: 730 days)
 *   ai_alerts            - fired alerts (TTL: 180 days)
 */
class AIObservabilityRepository {
  constructor() {
    this.db = getFirestore();
    this.collections = {
      logs: 'ai_logs',
      metricsDaily: 'ai_metrics_daily',
      drift: 'ai_drift_tracking',
      cost: 'ai_cost_tracking',
      alerts: 'ai_alerts',
    };
  }

  // ─── AI LOGS ────────────────────────────────────────────────────────────────

  /**
   * Write a single AI call log.
   * @param {Object} logEntry - validated log object
   * @returns {string} docId
   */
  async writeLog(logEntry) {
    const docRef = this.db.collection(this.collections.logs).doc();
    await docRef.set({
      ...logEntry,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: this._ttlTimestamp(OBSERVABILITY_CONFIG.retention.aiLogsRetentionDays),
    });
    return docRef.id;
  }

  /**
   * Batch write logs (used by async queue flusher).
   */
  async batchWriteLogs(logEntries) {
    const chunks = this._chunk(logEntries, 500);
    for (const chunk of chunks) {
      const batch = this.db.batch();
      chunk.forEach(entry => {
        const ref = this.db.collection(this.collections.logs).doc();
        batch.set(ref, {
          ...entry,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: this._ttlTimestamp(OBSERVABILITY_CONFIG.retention.aiLogsRetentionDays),
        });
      });
      await batch.commit();
    }
  }

  /**
   * Fetch recent logs for a feature within a time window.
   */
  async getLogsByFeature(feature, { fromDate, toDate, limit = 500 } = {}) {
    let query = this.db.collection(this.collections.logs)
      .where('feature', '==', feature)
      .where('isDeleted', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (fromDate) query = query.where('createdAt', '>=', Timestamp.fromDate(fromDate));
    if (toDate) query = query.where('createdAt', '<=', Timestamp.fromDate(toDate));

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ─── DAILY METRICS ──────────────────────────────────────────────────────────

  /**
   * Upsert daily metrics document (idempotent via merge).
   * DocId pattern: `{feature}_{YYYY-MM-DD}`
   */
  async upsertDailyMetrics(feature, dateStr, metricsPayload) {
    const docId = `${feature}_${dateStr}`;
    const ref = this.db.collection(this.collections.metricsDaily).doc(docId);
    await ref.set({
      feature,
      date: dateStr,
      ...metricsPayload,
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: this._ttlTimestamp(OBSERVABILITY_CONFIG.retention.metricsRetentionDays),
      isDeleted: false,
    }, { merge: true });
    return docId;
  }

  async getDailyMetrics(feature, { fromDate, toDate, limit = 90 } = {}) {
    let query = this.db.collection(this.collections.metricsDaily)
      .where('feature', '==', feature)
      .where('isDeleted', '==', false)
      .orderBy('date', 'desc')
      .limit(limit);

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async getAggregatedMetricsSummary({ limit = 30 } = {}) {
    const snap = await this.db.collection(this.collections.metricsDaily)
      .where('isDeleted', '==', false)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ─── DRIFT TRACKING ─────────────────────────────────────────────────────────

  async writeDriftSnapshot(driftEntry) {
    const docRef = this.db.collection(this.collections.drift).doc();
    await docRef.set({
      ...driftEntry,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: this._ttlTimestamp(OBSERVABILITY_CONFIG.retention.driftRetentionDays),
      isDeleted: false,
    });
    return docRef.id;
  }

  /**
   * Get last N drift snapshots for a feature (for baseline calculation).
   */
  async getDriftHistory(feature, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const snap = await this.db.collection(this.collections.drift)
      .where('feature', '==', feature)
      .where('isDeleted', '==', false)
      .where('createdAt', '>=', Timestamp.fromDate(since))
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();

    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async getDriftSummary({ limit = 50 } = {}) {
    const snap = await this.db.collection(this.collections.drift)
      .where('isDeleted', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ─── COST TRACKING ──────────────────────────────────────────────────────────

  /**
   * Upsert daily cost entry per user+feature.
   * DocId: `{userId}_{feature}_{YYYY-MM-DD}`
   */
  async upsertCostEntry(userId, feature, dateStr, costDelta) {
    const docId = `${userId}_${feature}_${dateStr}`;
    const ref = this.db.collection(this.collections.cost).doc(docId);
    await ref.set({
      userId,
      feature,
      date: dateStr,
      totalCostUSD: FieldValue.increment(costDelta.totalCostUSD || 0),
      inputTokens: FieldValue.increment(costDelta.inputTokens || 0),
      outputTokens: FieldValue.increment(costDelta.outputTokens || 0),
      callCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: this._ttlTimestamp(OBSERVABILITY_CONFIG.retention.costRetentionDays),
      isDeleted: false,
    }, { merge: true });
    return docId;
  }

  async getCostByDateRange(fromDate, toDate, { feature, userId } = {}) {
    let query = this.db.collection(this.collections.cost)
      .where('isDeleted', '==', false)
      .where('date', '>=', fromDate)
      .where('date', '<=', toDate);

    if (feature) query = query.where('feature', '==', feature);
    if (userId) query = query.where('userId', '==', userId);

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async getMonthlyCostSummary(monthStr) { // 'YYYY-MM'
    const from = `${monthStr}-01`;
    const to = `${monthStr}-31`;
    return this.getCostByDateRange(from, to);
  }

  // ─── ALERTS ─────────────────────────────────────────────────────────────────

  async writeAlert(alertEntry) {
    const docRef = this.db.collection(this.collections.alerts).doc();
    await docRef.set({
      ...alertEntry,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: this._ttlTimestamp(OBSERVABILITY_CONFIG.retention.alertsRetentionDays),
      resolved: false,
      isDeleted: false,
    });
    return docRef.id;
  }

  async getActiveAlerts({ feature, severity, limit = 50 } = {}) {
    let query = this.db.collection(this.collections.alerts)
      .where('resolved', '==', false)
      .where('isDeleted', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (feature) query = query.where('feature', '==', feature);
    if (severity) query = query.where('severity', '==', severity);

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async resolveAlert(alertId, resolvedBy) {
    await this.db.collection(this.collections.alerts).doc(alertId).update({
      resolved: true,
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy,
    });
  }

  // ─── UTILITIES ──────────────────────────────────────────────────────────────

  _ttlTimestamp(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return Timestamp.fromDate(d);
  }

  _chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

module.exports = new AIObservabilityRepository();