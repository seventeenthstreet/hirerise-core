'use strict';

const { supabase } = require('../../config/supabase');

const TABLE = 'usage_logs';
const DOC_LIMIT = 10_000;

// ───────────────── TYPES ─────────────────

type CostRow = {
  userId: string;
  feature: string;
  tier: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  revenueUSD: number;
  date: string;
};

export interface LogWriteParams {
  userId: string;
  feature: string;
  tier: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  revenueUSD: number;
}

export interface FetchResult {
  rows: CostRow[];
  docCount: number;
  capped: boolean;
}

// ───────────────── REPOSITORY ─────────────────

class UsageLogsRepository {

  // ───────── WRITE ─────────

  async logUsage(params: LogWriteParams): Promise<string | null> {
    try {
      const totalTokens = params.inputTokens + params.outputTokens;

      const { data, error } = await supabase
        .from(TABLE)
        .insert({
          user_id: params.userId,
          feature: params.feature,
          tier: params.tier,
          model: params.model,
          input_tokens: params.inputTokens,
          output_tokens: params.outputTokens,
          total_tokens: totalTokens,
          cost_usd: params.costUSD,
          revenue_usd: params.revenueUSD,
          margin_usd: +(params.revenueUSD - params.costUSD).toFixed(8),
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      return data?.id ?? null;

    } catch (err: any) {
      console.error('[UsageLogsRepository] Failed to write log:', err?.message);
      return null;
    }
  }

  async batchWriteLogs(entries: LogWriteParams[]): Promise<void> {
    try {
      const rows = entries.map((params) => {
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
          margin_usd: +(params.revenueUSD - params.costUSD).toFixed(8),
          created_at: new Date().toISOString(),
        };
      });

      const { error } = await supabase.from(TABLE).insert(rows);

      if (error) throw error;

    } catch (err: any) {
      console.error('[UsageLogsRepository] Batch insert failed:', err?.message);
    }
  }

  // ───────── QUERY ─────────

  async getByDateRange(startDate: Date, endDate: Date): Promise<FetchResult> {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString())
      .order('created_at', { ascending: true })
      .limit(DOC_LIMIT);

    if (error) throw error;

    const rows: CostRow[] = (data || []).map((row: any) => ({
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
        ? new Date(row.created_at).toISOString().split('T')[0]
        : '',
    }));

    return {
      rows,
      docCount: data?.length ?? 0,
      capped: (data?.length ?? 0) >= DOC_LIMIT,
    };
  }

  async getTotalUserCount(): Promise<number> {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;

    return count ?? 0;
  }
}

export const usageLogsRepository = new UsageLogsRepository();