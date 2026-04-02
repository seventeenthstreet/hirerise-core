/**
 * metrics.types.ts
 *
 * Central type definitions for:
 * - AI pricing
 * - token usage
 * - observability metrics
 * - cost tracking
 */

// ─────────────────────────────────────────────
// MODEL PRICING
// ─────────────────────────────────────────────

export type ModelPricing = {
  input: number;   // USD per unit (per million or per 1k — depends on config)
  output: number;
};

export type ModelPricingMap = Record<string, ModelPricing>;

// ─────────────────────────────────────────────
// TOKEN USAGE
// ─────────────────────────────────────────────

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
};

// ─────────────────────────────────────────────
// AI CALL METRICS
// ─────────────────────────────────────────────

export type AICallMetrics = {
  model: string;
  provider?: string;

  latencyMs: number;

  tokens: TokenUsage;

  costUSD?: number;

  success: boolean;
  error?: string;

  timestamp?: string;
};

// ─────────────────────────────────────────────
// AGGREGATED METRICS
// ─────────────────────────────────────────────

export type AggregatedMetrics = {
  totalCalls: number;
  successRate: number;
  errorRate: number;

  avgLatencyMs: number;
  p95LatencyMs?: number;

  totalTokens: number;
  totalCostUSD: number;
};

// ─────────────────────────────────────────────
// DRIFT METRICS
// ─────────────────────────────────────────────

export type DriftMetric = {
  feature: string;

  baselineValue: number;
  currentValue: number;

  deviation: number; // percentage (0–1)

  triggered: boolean;
};

// ─────────────────────────────────────────────
// BUDGET TRACKING
// ─────────────────────────────────────────────

export type BudgetUsage = {
  totalCostUSD: number;
  perUserCostUSD?: number;
  perFeatureCostUSD?: number;

  thresholdExceeded?: boolean;
};

// ─────────────────────────────────────────────
// PLAN / REVENUE
// ─────────────────────────────────────────────

export type PlanRevenueMap = Record<number, number>; // INR → USD mapping