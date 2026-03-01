/**
 * metrics.types.ts — HireRise Admin Metrics Type Definitions
 *
 * All types used by the /admin/metrics endpoint and its service layer.
 * No runtime impact — TypeScript compile-time only.
 */

import { firestore } from 'firebase-admin'; // ← FIX #1: FirebaseFirestore namespace import

// ─── Firestore Collection: usageLogs ──────────────────────────────────────────

export type UserTier = 'free' | 'pro' | 'enterprise';

export interface UsageLog {
  userId:       string;
  feature:      string;
  tier:         UserTier;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
  costUSD:      number;
  revenueUSD:   number;
  marginUSD:    number;
  createdAt:    firestore.Timestamp; // ← FIX #1: was FirebaseFirestore.Timestamp
}

// ─── Firestore Collection: metrics/daily/{YYYY-MM-DD} ─────────────────────────

export interface DailyMetricsAggregate {
  date:                string;          // YYYY-MM-DD
  totalUsers:          number;
  activeUsers:         number;
  totalRequests:       number;
  totalTokens:         number;
  totalCostUSD:        number;
  totalRevenueUSD:     number;
  grossMarginUSD:      number;
  grossMarginPercent:  number;
  freeTierCostUSD:     number;
  paidTierCostUSD:     number;
  paidUserCount:       number;
  featureCounts:       Record<string, number>;
  updatedAt:           firestore.Timestamp; // ← FIX #1: was FirebaseFirestore.Timestamp
}

// ─── API Request / Response ───────────────────────────────────────────────────

export type PeriodPreset = '7d' | '30d' | '90d' | '1y';

export interface MetricsQueryParams {
  period?:    PeriodPreset;
  startDate?: string;  // YYYY-MM-DD — custom range start
  endDate?:   string;  // YYYY-MM-DD — custom range end
}

export interface TopFeature {
  feature: string;
  count:   number;
}

export interface ModelCostBreakdown {
  model:          string;
  totalCostUSD:   number;
  totalTokens:    number;
  callCount:      number;
  avgCostPerCall: number;
}

export interface HealthAlerts {
  marginHealthStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  marginWarning?:     string;
  freeBurnAlert?:     string;
  freeBurnPercent:    number;
}

export interface AdminMetricsResponse {
  period:    string;
  startDate: string;
  endDate:   string;

  // User metrics
  totalUsers:  number;
  activeUsers: number;

  // Volume
  totalRequests: number;
  totalTokens:   number;

  // Financial
  totalCostUSD:       number;
  totalRevenueUSD:    number;
  grossMarginUSD:     number;
  grossMarginPercent: number;

  // Tier breakdown
  freeTierCostUSD: number;
  paidTierCostUSD: number;

  // Per-unit economics
  avgCostPerRequest:     number;
  avgRevenuePerPaidUser: number;

  // Feature analytics
  topFeatures: TopFeature[];

  // Bonus
  modelBreakdown: ModelCostBreakdown[];
  healthAlerts:   HealthAlerts;

  // Meta
  dataSource:  'live' | 'aggregated' | 'hybrid';
  generatedAt: string;
  periodDays:  number;
}

// ─── Internal computation types ───────────────────────────────────────────────

export interface PeriodWindow {
  startDate: Date;
  endDate:   Date;
  label:     string;
  days:      number;
}

export interface CostRow {
  userId:       string;
  feature:      string;
  tier:         UserTier;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
  costUSD:      number;
  revenueUSD:   number;
  date:         string;
}

// ─── Model Pricing ────────────────────────────────────────────────────────────

export interface ModelRate {
  input:  number; // USD per 1M tokens
  output: number; // USD per 1M tokens
}

export type ModelPricingMap = Record<string, ModelRate>;