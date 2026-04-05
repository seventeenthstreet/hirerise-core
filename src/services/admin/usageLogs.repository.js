'use strict';

/**
 * src/services/admin/usageLogs.repository.js
 * Production-ready Supabase-native repository
 */

const { supabase } = require('../../config/supabase');

const TABLE = 'usage_logs';
const DOC_LIMIT = 10_000;
const BATCH_INSERT_SIZE = 500;

const SELECT_COLUMNS = `
  user_id,
  feature,
  tier,
  model,
  input_tokens,
  output_tokens,
  total_tokens,
  cost_usd,
  revenue_usd,
  created_at
`;

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
    revenueUSD,
  }) {
    try {
      const row = this._buildInsertRow({
        userId,
        feature,
        tier,
        model,
        inputTokens,
        outputTokens,
        costUSD,
        revenueUSD,
      });

      const { data, error } = await supabase
        .from(TABLE)
        .insert([row])
        .select('id')
        .maybeSingle();

      if (error) {
        throw new Error(`Insert failed: ${error.message}`);
      }

      return data?.id ?? null;
    } catch (error) {
      console.error('[UsageLogsRepository.logUsage]', error);
      return null;
    }
  }

  // ─────────────────────────────────────────
  async batchWriteLogs(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const chunks = this._chunk(entries, BATCH_INSERT_SIZE);

    for (const chunk of chunks) {
      const rows = chunk.map((entry) => this._buildInsertRow(entry));

      const { error } = await supabase
        .from(TABLE)
        .insert(rows);

      if (error) {
        throw new Error(
          `[UsageLogsRepository.batchWriteLogs] Insert failed: ${error.message}`
        );
      }
    }
  }

  // ─────────────────────────────────────────
  async getByDateRange(startDate, endDate) {
    const startISO =
      startDate instanceof Date ? startDate.toISOString() : startDate;

    const endISO =
      endDate instanceof Date ? endDate.toISOString() : endDate;

    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('created_at', { ascending: true })
      .limit(DOC_LIMIT);

    if (error) {
      throw new Error(
        `[UsageLogsRepository.getByDateRange] Query failed: ${error.message}`
      );
    }

    const rows = (data ?? []).map((row) => this._mapRow(row));

    return {
      rows,
      docCount: rows.length,
      capped: rows.length >= DOC_LIMIT,
    };
  }

  // ─────────────────────────────────────────
  async getTotalUserCount() {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) {
      throw new Error(
        `[UsageLogsRepository.getTotalUserCount] Count failed: ${error.message}`
      );
    }

    return count ?? 0;
  }

  // ─────────────────────────────────────────
  _buildInsertRow({
    userId,
    feature,
    tier,
    model,
    inputTokens = 0,
    outputTokens = 0,
    costUSD = 0,
    revenueUSD = 0,
  }) {
    const totalTokens = inputTokens + outputTokens;

    return {
      user_id: userId,
      feature,
      tier,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost_usd: costUSD,
      revenue_usd: revenueUSD,
      margin_usd: Number((revenueUSD - costUSD).toFixed(8)),
      created_at: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────
  _mapRow(row) {
    return {
      userId: row.user_id,
      feature: row.feature,
      tier: row.tier,
      model: row.model,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
      costUSD: row.cost_usd ?? 0,
      revenueUSD: row.revenue_usd ?? 0,
      date: row.created_at
        ? row.created_at.split('T')[0]
        : '',
    };
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

module.exports = {
  usageLogsRepository: new UsageLogsRepository(),
};