'use strict';

/**
 * usageLogs.repository.js
 * Converted from usageLogs.repository.ts
 */
const supabase = require('../../config/supabase');
const TABLE = 'usageLogs';
const DOC_LIMIT = 10_000;

class UsageLogsRepository {
  async logUsage({
    userId,
    feature,
    tier,
    model,
    inputTokens,
    outputTokens,
    costUSD,
    revenueUSD
  }) {
    try {
      const totalTokens = inputTokens + outputTokens;
      const marginUSD = parseFloat((revenueUSD - costUSD).toFixed(8));
      const createdAt = new Date().toISOString();

      const { data, error } = await supabase
        .from(TABLE)
        .insert([{
          userId,
          feature,
          tier,
          model,
          inputTokens,
          outputTokens,
          totalTokens,
          costUSD,
          revenueUSD,
          marginUSD,
          createdAt
        }])
        .select('id')
        .single();

      if (error) throw error;
      return data?.id ?? null;
    } catch (err) {
      console.error('[UsageLogsRepository] Failed to write log:', err?.message);
      return null;
    }
  }

  async batchWriteLogs(entries) {
    const chunks = this._chunk(entries, 500);
    for (const chunk of chunks) {
      const createdAt = new Date().toISOString();
      const rows = chunk.map(params => {
        const totalTokens = params.inputTokens + params.outputTokens;
        return {
          ...params,
          totalTokens,
          marginUSD: parseFloat((params.revenueUSD - params.costUSD).toFixed(8)),
          createdAt
        };
      });

      const { error } = await supabase
        .from(TABLE)
        .insert(rows);

      if (error) throw error;
    }
  }

  async getByDateRange(startDate, endDate) {
    const startISO = startDate instanceof Date ? startDate.toISOString() : startDate;
    const endISO = endDate instanceof Date ? endDate.toISOString() : endDate;

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .gte('createdAt', startISO)
      .lte('createdAt', endISO)
      .order('createdAt', { ascending: true })
      .limit(DOC_LIMIT);

    if (error) throw error;

    const rows = (data ?? []).map(row => ({
      userId: row.userId,
      feature: row.feature,
      tier: row.tier,
      model: row.model,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
      costUSD: row.costUSD ?? 0,
      revenueUSD: row.revenueUSD ?? 0,
      date: row.createdAt ? row.createdAt.split('T')[0] : ''
    }));

    return {
      rows,
      docCount: rows.length,
      capped: rows.length >= DOC_LIMIT
    };
  }

  async getTotalUserCount() {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;
    return count ?? 0;
  }

  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}

const usageLogsRepository = new UsageLogsRepository();
module.exports = {
  usageLogsRepository
};