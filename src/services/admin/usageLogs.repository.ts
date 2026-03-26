'use strict';

/**
 * usageLogs.repository.ts
 *
 * Firestore repository for the `usageLogs` collection.
 */

const { db, FieldValue, Timestamp } = require('../../core/supabaseDbShim');
import type { CostRow, UserTier } from '../../types/metrics.types';

const COLLECTION = 'usageLogs';
const DOC_LIMIT = 10_000;

export interface LogWriteParams {
  userId: string;
  feature: string;
  tier: UserTier;
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

class UsageLogsRepository {
  private get db() {
    return require('../../core/supabaseDbShim').db;
  }

  // ───────────────── WRITE ─────────────────

  async logUsage(params: LogWriteParams): Promise<string | null> {
    try {
      const {
        userId,
        feature,
        tier,
        model,
        inputTokens,
        outputTokens,
        costUSD,
        revenueUSD,
      } = params;

      const totalTokens = inputTokens + outputTokens;
      const marginUSD = parseFloat((revenueUSD - costUSD).toFixed(8));

      const docRef = this.db.collection(COLLECTION).doc();

      await docRef.set({
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
        createdAt: FieldValue.serverTimestamp(),
      });

      return docRef.id;
    } catch (err: any) {
      console.error('[UsageLogsRepository] Failed to write log:', err?.message);
      return null;
    }
  }

  async batchWriteLogs(entries: LogWriteParams[]): Promise<void> {
    const chunks = this.chunk(entries, 500);

    for (const chunk of chunks) {
      const batch = this.db.batch();

      chunk.forEach(params => {
        const ref = this.db.collection(COLLECTION).doc();
        const totalTokens = params.inputTokens + params.outputTokens;

        batch.set(ref, {
          ...params,
          totalTokens,
          marginUSD: parseFloat(
            (params.revenueUSD - params.costUSD).toFixed(8)
          ),
          createdAt: FieldValue.serverTimestamp(),
        });
      });

      await batch.commit();
    }
  }

  // ───────────────── QUERY ─────────────────

  async getByDateRange(
    startDate: Date,
    endDate: Date
  ): Promise<FetchResult> {
    const snap = await this.db
      .collection(COLLECTION)
      .where('createdAt', '>=', Timestamp.fromDate(startDate))
      .where('createdAt', '<=', Timestamp.fromDate(endDate))
      .orderBy('createdAt', 'asc')
      .limit(DOC_LIMIT)
      .get();

    const rows: CostRow[] = snap.docs.map(doc => {
      const data = doc.data();

      return {
        userId: data.userId,
        feature: data.feature,
        tier: data.tier,
        model: data.model,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        totalTokens: data.totalTokens ?? 0,
        costUSD: data.costUSD ?? 0,
        revenueUSD: data.revenueUSD ?? 0,
        date:
          data.createdAt?.toDate?.()?.toISOString?.()?.split('T')[0] ?? '',
      };
    });

    return {
      rows,
      docCount: snap.size,
      capped: snap.size >= DOC_LIMIT,
    };
  }

  async getTotalUserCount(): Promise<number> {
    const snap = await this.db.collection('users').count().get();
    return snap.data().count ?? 0;
  }

  // ───────────────── HELPERS ─────────────────

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

export const usageLogsRepository = new UsageLogsRepository();