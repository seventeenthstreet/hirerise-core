'use strict';

import { supabase } from '../config/supabase';

type CostRow = {
  userId: string;
  feature: string;
  tier: string;
  model: string;
  totalTokens: number;
  costUSD: number;
  revenueUSD: number;
};

type UsageLogRow = {
  user_id?: string;
  feature?: string;
  tier?: string;
  model?: string;
  total_tokens?: number;
  cost_usd?: number;
  revenue_usd?: number;
};

type DailyMetricsAggregate = {
  date: string;
  total_users: number;
  active_users: number;
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  total_revenue_usd: number;
  gross_margin_usd: number;
  gross_margin_percent: number;
  free_tier_cost_usd: number;
  paid_tier_cost_usd: number;
  paid_user_count: number;
  feature_counts: Record<string, number>;
  updated_at: string;
};

class AdminMetricsAggregator {
  async runJob(
    dateStr?: string
  ): Promise<{ date: string; docCount: number; durationMs: number }> {
    const targetDate = dateStr ?? this._yesterdayUTC();
    const jobStart = Date.now();

    console.log(`[AdminMetricsAggregator] Starting for ${targetDate}`);

    const startDate = `${targetDate}T00:00:00.000Z`;
    const endDate = `${targetDate}T23:59:59.999Z`;

    const { data: rowsData, error: fetchError } = await supabase
      .from('usage_logs')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (fetchError) {
      console.error('Fetch usage_logs failed', fetchError);
      throw fetchError;
    }

    const rows: CostRow[] = ((rowsData as UsageLogRow[]) || []).map(
      (data: UsageLogRow): CostRow => ({
        userId: data.user_id ?? '',
        feature: data.feature ?? 'unknown',
        tier: data.tier ?? 'free',
        model: data.model ?? 'unknown',
        totalTokens: data.total_tokens ?? 0,
        costUSD: data.cost_usd ?? 0,
        revenueUSD: data.revenue_usd ?? 0,
      })
    );

    if (rows.length === 0) {
      console.log(`[AdminMetricsAggregator] No data for ${targetDate}`);
      return {
        date: targetDate,
        docCount: 0,
        durationMs: Date.now() - jobStart,
      };
    }

    let totalRequests = rows.length;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const featureCounts: Record<string, number> = {};
    const paidUserIds = new Set<string>();
    const allUserIds = new Set<string>();

    for (const row of rows) {
      totalTokens += row.totalTokens;
      totalCostUSD += row.costUSD;
      totalRevenueUSD += row.revenueUSD;

      allUserIds.add(row.userId);

      featureCounts[row.feature] =
        (featureCounts[row.feature] ?? 0) + 1;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD;
      } else {
        paidTierCostUSD += row.costUSD;
        paidUserIds.add(row.userId);
      }
    }

    const grossMarginUSD = totalRevenueUSD - totalCostUSD;
    const grossMarginPercent =
      totalRevenueUSD > 0
        ? parseFloat(
            ((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2)
          )
        : 0;

    const { count: totalUsers, error: countError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.error('User count failed', countError);
      throw countError;
    }

    const aggregate: DailyMetricsAggregate = {
      date: targetDate,
      total_users: totalUsers ?? 0,
      active_users: allUserIds.size,
      total_requests: totalRequests,
      total_tokens: totalTokens,
      total_cost_usd: parseFloat(totalCostUSD.toFixed(6)),
      total_revenue_usd: parseFloat(totalRevenueUSD.toFixed(4)),
      gross_margin_usd: parseFloat(grossMarginUSD.toFixed(6)),
      gross_margin_percent: grossMarginPercent,
      free_tier_cost_usd: parseFloat(freeTierCostUSD.toFixed(6)),
      paid_tier_cost_usd: parseFloat(paidTierCostUSD.toFixed(6)),
      paid_user_count: paidUserIds.size,
      feature_counts: featureCounts,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabase
      .from('metrics_daily_snapshots')
      .upsert(aggregate, { onConflict: 'date' });

    if (upsertError) {
      console.error('Metrics upsert failed', upsertError);
      throw upsertError;
    }

    const durationMs = Date.now() - jobStart;

    console.log(
      `[AdminMetricsAggregator] Done for ${targetDate} — ${rows.length} docs in ${durationMs}ms`
    );

    return {
      date: targetDate,
      docCount: rows.length,
      durationMs,
    };
  }

  private _yesterdayUTC(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

export const adminMetricsAggregator = new AdminMetricsAggregator();
export default adminMetricsAggregator;