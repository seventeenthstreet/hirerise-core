'use strict';

/**
 * usageLogs.repository.js
 * Converted from usageLogs.repository.ts
 */

const { db, FieldValue, Timestamp } = require('../../config/supabase');

const COLLECTION = 'usageLogs';
const DOC_LIMIT  = 10_000;

class UsageLogsRepository {
  get db() { return require('../../config/supabase').db; }

  async logUsage({ userId, feature, tier, model, inputTokens, outputTokens, costUSD, revenueUSD }) {
    try {
      const totalTokens = inputTokens + outputTokens;
      const marginUSD   = parseFloat((revenueUSD - costUSD).toFixed(8));
      const docRef = this.db.collection(COLLECTION).doc();
      await docRef.set({ userId, feature, tier, model, inputTokens, outputTokens, totalTokens, costUSD, revenueUSD, marginUSD, createdAt: FieldValue.serverTimestamp() });
      return docRef.id;
    } catch (err) {
      console.error('[UsageLogsRepository] Failed to write log:', err?.message);
      return null;
    }
  }

  async batchWriteLogs(entries) {
    const chunks = this._chunk(entries, 500);
    for (const chunk of chunks) {
      const batch = this.db.batch();
      chunk.forEach(params => {
        const ref = this.db.collection(COLLECTION).doc();
        const totalTokens = params.inputTokens + params.outputTokens;
        batch.set(ref, { ...params, totalTokens, marginUSD: parseFloat((params.revenueUSD - params.costUSD).toFixed(8)), createdAt: FieldValue.serverTimestamp() });
      });
      await batch.commit();
    }
  }

  async getByDateRange(startDate, endDate) {
    const snap = await this.db.collection(COLLECTION)
      .where('createdAt', '>=', Timestamp.fromDate(startDate))
      .where('createdAt', '<=', Timestamp.fromDate(endDate))
      .orderBy('createdAt', 'asc')
      .limit(DOC_LIMIT)
      .get();

    const rows = snap.docs.map(doc => {
      const data = doc.data();
      return {
        user_id:       data.userId,
        feature:      data.feature,
        tier:         data.tier,
        model:        data.model,
        inputTokens:  data.inputTokens  ?? 0,
        outputTokens: data.outputTokens ?? 0,
        totalTokens:  data.totalTokens  ?? 0,
        costUSD:      data.costUSD      ?? 0,
        revenueUSD:   data.revenueUSD   ?? 0,
        date:         data.createdAt?.toDate?.()?.toISOString?.()?.split('T')[0] ?? '',
      };
    });

    return { rows, docCount: snap.size, capped: snap.size >= DOC_LIMIT };
  }

  async getTotalUserCount() {
    const snap = await this.db.collection('users').count().get();
    return snap.data().count ?? 0;
  }

  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}

const usageLogsRepository = new UsageLogsRepository();
module.exports = { usageLogsRepository };









