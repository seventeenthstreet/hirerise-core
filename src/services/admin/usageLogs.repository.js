'use strict';

/**
 * usageLogs.repository.js — FULLY FIXED (Production Safe)
 */

const { supabase } = require('../../config/supabase'); // ✅ FIXED

const TABLE = 'usage_logs'; // ✅ FIXED
const DOC_LIMIT = 10_000;

class UsageLogsRepository {

  // ─────────────────────────────────────────
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
          user_id: userId,                // ✅ FIXED
          feature,
          tier,
          model,
          input_tokens: inputTokens,      // ✅ FIXED
          output_tokens: outputTokens,    // ✅ FIXED
          total_tokens: totalTokens,      // ✅ FIXED
          cost_usd: costUSD,              // ✅ FIXED
          revenue_usd: revenueUSD,        // ✅ FIXED
          margin_usd: marginUSD,          // ✅ FIXED
          created_at: createdAt           // ✅ FIXED
        }])
        .select('id')
        .maybeSingle(); // ✅ FIXED

      if (error) throw error;

      return data?.id ?? null;

    } catch (err) {
      console.error('[UsageLogsRepository] Failed to write log:', err?.message);
      return null;
    }
  }

  // ─────────────────────────────────────────
  async batchWriteLogs(entries) {

    const chunks = this._chunk(entries, 500);

    for (const chunk of chunks) {
      const createdAt = new Date().toISOString();

      const rows = chunk.map(params => {
        const totalTokens = params.inputTokens + params.outputTokens;

        return {
          user_id: params.userId,
          feature: params.feature,
          tier: params.tier,
          model: params.model,
          input_tokens: params.inputTokens,
          output_tokens: params.outputTokens,
          total_tokens: totalTokens,
          cost_usd: params.costUSD,
          revenue_usd: params.revenueUSD,
          margin_usd: parseFloat((params.revenueUSD - params.costUSD).toFixed(8)),
          created_at: createdAt
        };
      });

      const { error } = await supabase
        .from(TABLE)
        .insert(rows);

      if (error) throw error;
    }
  }

  // ─────────────────────────────────────────
  async getByDateRange(startDate, endDate) {

    const startISO = startDate instanceof Date ? startDate.toISOString() : startDate;
    const endISO = endDate instanceof Date ? endDate.toISOString() : endDate;

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .gte('created_at', startISO) // ✅ FIXED
      .lte('created_at', endISO)   // ✅ FIXED
      .order('created_at', { ascending: true }) // ✅ FIXED
      .limit(DOC_LIMIT);

    if (error) throw error;

    const rows = (data ?? []).map(row => ({
      userId: row.user_id,
      feature: row.feature,
      tier: row.tier,
      model: row.model,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
      costUSD: row.cost_usd ?? 0,
      revenueUSD: row.revenue_usd ?? 0,
      date: row.created_at ? row.created_at.split('T')[0] : ''
    }));

    return {
      rows,
      docCount: rows.length,
      capped: rows.length >= DOC_LIMIT
    };
  }

  // ─────────────────────────────────────────
  async getTotalUserCount() {

    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;

    return count ?? 0;
  }

  // ─────────────────────────────────────────
  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

const usageLogsRepository = new UsageLogsRepository();

module.exports = {
  usageLogsRepository
};