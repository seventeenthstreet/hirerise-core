'use strict';

/**
 * src/modules/conversion/repositiories/conversionHook.middleware.js
 *
 * Wave 1 hardened conversion event ingestion repository
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/conversion.logger');
const {
  HARD_COUNTER_LIMIT,
  SCORE_VERSION,
} = require('../utils/eventWeights.config');

function normalizeRpcRow(data) {
  if (!data) return null;

  const row = Array.isArray(data) ? data[0] : data;

  if (row?.row) return row.row;
  if (typeof row !== 'object') return null;

  return row;
}

function safeScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

class ConversionAggregateRepository {
  constructor() {
    this.table = 'conversion_aggregates';
    this.incrementRpc = 'increment_conversion_aggregate';
  }

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

      const { data: rpcData, error: rpcError } = await supabase.rpc(
        this.incrementRpc,
        {
          p_user_id: userId,
          p_event_type: eventType,
          p_hard_limit: HARD_COUNTER_LIMIT,
          p_score_version: SCORE_VERSION,
        }
      );

      if (rpcError) {
        logger.error('increment_conversion_aggregate RPC failed', {
          rpc: this.incrementRpc,
          userId,
          eventType,
          code: rpcError.code,
          details: rpcError.details,
          error: rpcError.message,
        });
        throw rpcError;
      }

      const updatedRow = normalizeRpcRow(rpcData);

      if (!updatedRow) {
        throw new Error('RPC increment returned invalid row');
      }

      const eventCounts = updatedRow.event_counts || {};

      const scores = computeScoresFn(updatedRow, eventCounts);

      const now = new Date().toISOString();

      const payload = {
        engagement_score: safeScore(scores.engagementScore),
        monetization_score: safeScore(scores.monetizationScore),
        total_intent_score: safeScore(scores.totalIntentScore),
        score_version: SCORE_VERSION,
        last_updated_at: now,
      };

      if (scores.isEngagementEvent) {
        payload.last_engagement_event_at = now;
      }

      if (scores.isMonetizationEvent) {
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
        eventCounts,
      });

      return data;
    } catch (error) {
      logger.error(
        'ConversionAggregateRepository.incrementAndUpdate failed',
        {
          userId,
          eventType,
          error: error.message,
        }
      );
      throw error;
    }
  }

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
      logger.error(
        'ConversionAggregateRepository.upsertAggregate failed',
        {
          userId,
          error: error.message,
        }
      );
      throw error;
    }
  }
}

module.exports = new ConversionAggregateRepository();