'use strict';

/**
 * src/modules/conversion/repositiories/conversionHook.middleware.js
 *
 * NOTE:
 * Path retained exactly as existing project structure for safe production drop-in.
 * This file is logically a repository despite the legacy filename.
 *
 * Fully aligned with live Supabase schema:
 * - table PK: id TEXT
 * - RPC: increment_conversion_aggregate(text, text, int, int)
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/conversion.logger');
const {
  HARD_COUNTER_LIMIT,
  SCORE_VERSION,
} = require('../utils/eventWeights.config');

class ConversionAggregateRepository {
  constructor() {
    this.table = 'conversion_aggregates';
    this.incrementRpc = 'increment_conversion_aggregate';
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getAggregate(userId) {
    try {
      if (!userId || typeof userId !== 'string') {
        throw new Error('Valid userId string is required');
      }

      const { data, error } = await supabase
        .from(this.table)
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;

      return data ?? null;
    } catch (error) {
      logger.error('ConversionAggregateRepository.getAggregate failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Atomic Increment + Score Recompute
  // ---------------------------------------------------------------------------

  async incrementAndUpdate(userId, eventType, computeScoresFn) {
    try {
      if (!userId || typeof userId !== 'string') {
        throw new Error('Valid userId string is required');
      }

      if (!eventType || typeof eventType !== 'string') {
        throw new Error('Invalid eventType');
      }

      if (typeof computeScoresFn !== 'function') {
        throw new Error('computeScoresFn must be a function');
      }

      // 1) Atomic SQL-side increment via RPC
      const { data: updatedRow, error: rpcError } = await supabase.rpc(
        this.incrementRpc,
        {
          p_user_id: userId,
          p_event_type: eventType,
          p_hard_limit: HARD_COUNTER_LIMIT,
          p_score_version: SCORE_VERSION,
        }
      );

      if (rpcError) throw rpcError;
      if (!updatedRow) {
        throw new Error('RPC increment returned no row');
      }

      // 2) Preserve existing business scoring logic
      const eventCounts = updatedRow.event_counts || {};

      const {
        engagementScore,
        monetizationScore,
        totalIntentScore,
        isEngagementEvent,
        isMonetizationEvent,
      } = computeScoresFn(updatedRow, eventCounts);

      const now = new Date().toISOString();

      const payload = {
        engagement_score: engagementScore,
        monetization_score: monetizationScore,
        total_intent_score: totalIntentScore,
        score_version: SCORE_VERSION,
        last_updated_at: now,
      };

      if (isEngagementEvent) {
        payload.last_engagement_event_at = now;
      }

      if (isMonetizationEvent) {
        payload.last_monetization_event_at = now;
      }

      const { data, error } = await supabase
        .from(this.table)
        .update(payload)
        .eq('id', userId)
        .select()
        .single();

      if (error) throw error;

      logger.debug('Conversion aggregate incremented successfully', {
        userId,
        eventType,
      });

      return data;
    } catch (error) {
      logger.error('ConversionAggregateRepository.incrementAndUpdate failed', {
        userId,
        eventType,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Manual Upsert
  // ---------------------------------------------------------------------------

  async upsertAggregate(userId, aggregateData) {
    try {
      if (!userId || typeof userId !== 'string') {
        throw new Error('Valid userId string is required');
      }

      const payload = {
        ...aggregateData,
        id: userId,
        score_version: SCORE_VERSION,
        last_updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from(this.table)
        .upsert(payload, { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;

      return data;
    } catch (error) {
      logger.error('ConversionAggregateRepository.upsertAggregate failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = new ConversionAggregateRepository();