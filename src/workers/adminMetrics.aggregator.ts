'use strict';

import { supabase } from '../config/supabaseClient';
type CostRow = any;
type DailyMetricsAggregate = any;
class AdminMetricsAggregator {

  async runJob(dateStr?: string): Promise<{ date: string; docCount: number; durationMs: number }> {
    const targetDate = dateStr ?? this._yesterdayUTC();
    const jobStart = Date.now();

    console.log(`[AdminMetricsAggregator] Starting for ${targetDate}`);

    const startDate = `${targetDate}T00:00:00.000Z`;
    const endDate   = `${targetDate}T23:59:59.999Z`;

    // ✅ Fetch usage logs
    const { data: rowsData, error: fetchError } = await supabase
      .from('usage_logs')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (fetchError) {
      console.error('Fetch usage_logs failed', fetchError);
      throw fetchError;
    }

    const rows: CostRow[] = (rowsData || []).map((data: any) => ({
      userId:       data.user_id ?? '',
      feature:      data.feature ?? 'unknown',
      tier:         data.tier ?? 'free',
      model:        data.model ?? 'unknown',
      inputTokens:  data.input_tokens ?? 0,
      outputTokens: data.output_tokens ?? 0,
      totalTokens:  data.total_tokens ?? 0,
      costUSD:      data.cost_usd ?? 0,
      revenueUSD:   data.revenue_usd ?? 0,
      date:         targetDate,
    }));

    if (rows.length === 0) {
      console.log(`[AdminMetricsAggregator] No data for ${targetDate}`);
      return { date: targetDate, docCount: 0, durationMs: Date.now() - jobStart };
    }

    // ✅ Aggregation
    let totalRequests   = rows.length;
    let totalTokens     = 0;
    let totalCostUSD    = 0;
    let totalRevenueUSD = 0;
    let freeTierCostUSD = 0;
    let paidTierCostUSD = 0;

    const featureCounts: Record<string, number> = {};
    const paidUserIds = new Set<string>();
    const allUserIds  = new Set<string>();

    for (const row of rows) {
      totalTokens     += row.totalTokens;
      totalCostUSD    += row.costUSD;
      totalRevenueUSD += row.revenueUSD;

      allUserIds.add(row.userId);
      featureCounts[row.feature] = (featureCounts[row.feature] ?? 0) + 1;

      if (row.tier === 'free') {
        freeTierCostUSD += row.costUSD;
      } else {
        paidTierCostUSD += row.costUSD;
        paidUserIds.add(row.userId);
      }
    }

    const grossMarginUSD = totalRevenueUSD - totalCostUSD;
    const grossMarginPercent = totalRevenueUSD > 0
      ? parseFloat(((grossMarginUSD / totalRevenueUSD) * 100).toFixed(2))
      : 0;

    // ✅ Get total users
    const { count: totalUsers, error: countError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.error('User count failed', countError);
      throw countError;
    }

    const aggregate: DailyMetricsAggregate = {
      date: targetDate,
      totalUsers: totalUsers ?? 0,
      activeUsers: allUserIds.size,
      totalRequests,
      totalTokens,
      totalCostUSD: parseFloat(totalCostUSD.toFixed(6)),
      totalRevenueUSD: parseFloat(totalRevenueUSD.toFixed(4)),
      grossMarginUSD: parseFloat(grossMarginUSD.toFixed(6)),
      grossMarginPercent,
      freeTierCostUSD: parseFloat(freeTierCostUSD.toFixed(6)),
      paidTierCostUSD: parseFloat(paidTierCostUSD.toFixed(6)),
      paidUserCount: paidUserIds.size,
      featureCounts,
      updatedAt: new Date().toISOString(),
    };

    // ✅ UPSERT snapshot (replaces Firestore nested path)
    const { error: upsertError } = await supabase
      .from('metrics_daily_snapshots')
      .upsert(aggregate, { onConflict: 'date' });

    if (upsertError) {
      console.error('Metrics upsert failed', upsertError);
      throw upsertError;
    }

    const durationMs = Date.now() - jobStart;

    console.log(`[AdminMetricsAggregator] Done for ${targetDate} — ${rows.length} docs in ${durationMs}ms`);

    return { date: targetDate, docCount: rows.length, durationMs };
  }

  private _yesterdayUTC(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

export const adminMetricsAggregator = new AdminMetricsAggregator();

// ✅ CLEAN CLI ENTRY (NO FIREBASE)
if (require.main === module) {
  const dateArg = process.argv[2] ?? undefined;

  adminMetricsAggregator
    .runJob(dateArg)
    .then(r => {
      console.log('Done:', r);
      process.exit(0);
    })
    .catch(e => {
      console.error('Failed:', e);
      process.exit(1);
    });
}