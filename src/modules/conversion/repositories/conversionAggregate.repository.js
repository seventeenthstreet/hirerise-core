'use strict';

/**
 * src/modules/conversion/repositories/conversionAggregate.repository.js
 *
 * Wave 1 hardened analytics aggregate repository
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/conversion.logger');
const {
  HARD_COUNTER_LIMIT,
  SCORE_VERSION,
} = require('../utils/eventWeights.config');

function normalizeCountSnapshot(data) {
  if (!data) return {};

  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row !== 'object') {
    return {};
  }

  return row?.counts || row;
}

function safeScore(value) {
  const num = Number(value);

  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }

  return num;
}

class ConversionAggregateRepository {
  constructor() {
    this._table = 'conversion_aggregates';
  }

  async getAggregate(userId) {
    try {
      const { data, error } = await supabase
        .from(this._table)
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;
      return data ?? null;
    } catch (err) {
      logger.error('getAggregate failed', {
        userId,
        error: err.message,
      });
      throw err;
    }
  }

  async incrementAndUpdate(userId, eventType, computeScoresFn) {
    try {
      if (!eventType) {
        throw new Error('Invalid eventType');
      }

      if (typeof computeScoresFn !== 'function') {
        throw new Error('computeScoresFn must be a function');
      }

      const { data: rpcData, error: rpcError } =
        await supabase.rpc(
          'increment_conversion_event_count',
          {
            p_id: userId,
            p_event_type: eventType,
            p_hard_limit: HARD_COUNTER_LIMIT,
          }
        );

      if (rpcError) {
        logger.error('increment RPC failed', {
          rpc: 'increment_conversion_event_count',
          userId,
          eventType,
          code: rpcError.code,
          details: rpcError.details,
          error: rpcError.message,
        });

        throw new Error(
          `RPC increment_conversion_event_count failed: ${rpcError.message}`
        );
      }

      const updatedCounts = normalizeCountSnapshot(rpcData);

      const { data: existingData, error: readError } =
        await supabase
          .from(this._table)
          .select('*')
          .eq('id', userId)
          .single();

      if (readError) throw readError;

      const scores = computeScoresFn(existingData, updatedCounts);

      const now = new Date().toISOString();

      const payload = {
        engagement_score: safeScore(scores.engagementScore),
        monetization_score: safeScore(scores.monetizationScore),
        total_intent_score: safeScore(scores.totalIntentScore),
        score_version: SCORE_VERSION,
        last_updated_at: now,
        last_event_at: now,
      };

      if (scores.isEngagementEvent) {
        payload.last_engagement_event_at = now;
      }

      if (scores.isMonetizationEvent) {
        payload.last_monetization_event_at = now;
      }

      const { data, error } = await supabase
        .from(this._table)
        .update(payload)
        .eq('id', userId)
        .select()
        .single();

      if (error) throw error;

      logger.debug('incrementAndUpdate success', {
        userId,
        eventType,
        updatedCounts,
      });

      return data;
    } catch (err) {
      logger.error('incrementAndUpdate failed', {
        userId,
        eventType,
        error: err.message,
      });
      throw err;
    }
  }

  async upsertAggregate(userId, data) {
    try {
      const payload = {
        ...data,
        id: userId,
        score_version: SCORE_VERSION,
        last_updated_at: new Date().toISOString(),
      };

      const { data: result, error } = await supabase
        .from(this._table)
        .upsert([payload], { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;

      return result;
    } catch (err) {
      logger.error('upsertAggregate failed', {
        userId,
        error: err.message,
      });
      throw err;
    }
  }
}

module.exports = new ConversionAggregateRepository();