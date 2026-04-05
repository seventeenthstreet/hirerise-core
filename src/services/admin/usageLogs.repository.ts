import supabaseModule from '../../config/supabase';

const { supabase } = supabaseModule;

const TABLE = 'usage_logs';
const DOC_LIMIT = 10_000;
const BATCH_SIZE = 500;

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

type UsageLogInsertRow = {
  user_id: string;
  feature: string;
  tier: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  revenue_usd: number;
  margin_usd: number;
  created_at: string;
};

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
  async logUsage(
    params: LogWriteParams
  ): Promise<string | null> {
    try {
      const row = this.buildInsertRow(params);

      const { data, error } = await supabase
        .from(TABLE)
        .insert([row])
        .select('id')
        .maybeSingle();

      if (error) {
        throw new Error(error.message);
      }

      return data?.id ?? null;
    } catch (error) {
      console.error('[UsageLogsRepository.logUsage]', error);
      return null;
    }
  }

  async batchWriteLogs(
    entries: LogWriteParams[]
  ): Promise<void> {
    if (!entries.length) return;

    const chunks = this.chunk(entries, BATCH_SIZE);

    for (const chunk of chunks) {
      const rows = chunk.map((entry) =>
        this.buildInsertRow(entry)
      );

      const { error } = await supabase
        .from(TABLE)
        .insert(rows);

      if (error) {
        throw new Error(
          `[UsageLogsRepository.batchWriteLogs] ${error.message}`
        );
      }
    }
  }

  async getByDateRange(
    startDate: Date,
    endDate: Date
  ): Promise<FetchResult> {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString())
      .order('created_at', { ascending: true })
      .limit(DOC_LIMIT);

    if (error) {
      throw new Error(
        `[UsageLogsRepository.getByDateRange] ${error.message}`
      );
    }

    const rows: CostRow[] = (data ?? []).map((row: any) =>
      this.mapRow(row)
    );

    return {
      rows,
      docCount: rows.length,
      capped: rows.length >= DOC_LIMIT,
    };
  }

  async getTotalUserCount(): Promise<number> {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) {
      throw new Error(
        `[UsageLogsRepository.getTotalUserCount] ${error.message}`
      );
    }

    return count ?? 0;
  }

  private buildInsertRow(
    params: LogWriteParams
  ): UsageLogInsertRow {
    const totalTokens =
      params.inputTokens + params.outputTokens;

    return {
      user_id: params.userId,
      feature: params.feature,
      tier: params.tier,
      model: params.model,
      input_tokens: params.inputTokens ?? 0,
      output_tokens: params.outputTokens ?? 0,
      total_tokens: totalTokens,
      cost_usd: params.costUSD ?? 0,
      revenue_usd: params.revenueUSD ?? 0,
      margin_usd: Number(
        ((params.revenueUSD ?? 0) - (params.costUSD ?? 0)).toFixed(8)
      ),
      created_at: new Date().toISOString(),
    };
  }

  private mapRow(row: any): CostRow {
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
        ? String(row.created_at).split('T')[0]
        : '',
    };
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }

    return chunks;
  }
}

export const usageLogsRepository =
  new UsageLogsRepository();