/**
 * @file src/shared/types/metrics.types.ts
 * @description
 * Central type definitions for:
 * - AI pricing
 * - token usage
 * - observability metrics
 * - cost tracking
 */

export type ISODateString = string;

export type AIProvider =
  | 'openai'
  | 'openrouter'
  | 'grok'
  | 'anthropic'
  | 'internal'
  | 'unknown';

/* ========================= MODEL PRICING ========================= */

export type ModelPricing = Readonly<{
  input: number;
  output: number;
}>;

export type ModelPricingMap = Readonly<
  Record<string, ModelPricing>
>;

/* ========================= TOKEN USAGE ========================= */

export type TokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}>;

/* ========================= AI CALL METRICS ========================= */

export type AICallMetrics = Readonly<{
  model: string;
  provider?: AIProvider;

  latencyMs: number;

  tokens: TokenUsage;

  costUSD?: number;

  success: boolean;
  error?: string;

  timestamp?: ISODateString;
}>;

/* ========================= AGGREGATED METRICS ========================= */

export type AggregatedMetrics = Readonly<{
  totalCalls: number;
  successRate: number;
  errorRate: number;

  avgLatencyMs: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;

  totalTokens: number;
  totalCostUSD: number;
}>;

/* ========================= DRIFT METRICS ========================= */

export type DriftMetric = Readonly<{
  feature: string;

  baselineValue: number;
  currentValue: number;

  deviation: number; // 0–1 normalized %
  triggered: boolean;
}>;

/* ========================= BUDGET TRACKING ========================= */

export type BudgetUsage = Readonly<{
  totalCostUSD: number;
  perUserCostUSD?: number;
  perFeatureCostUSD?: number;

  thresholdExceeded?: boolean;
}>;

/* ========================= PLAN / REVENUE ========================= */

export type PlanRevenueMap = Readonly<Record<number, number>>;