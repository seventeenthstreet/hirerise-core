'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/conversion.logger');
const {
  HARD_COUNTER_LIMIT,
  SCORE_VERSION,
} = require('../utils/eventWeights.config');

class ConversionAggregateRepository {
  constructor() {
    this._table = 'conversion_aggregates';
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Atomic Increment + Deterministic Score Update
  // ---------------------------------------------------------------------------

  async incrementAndUpdate(userId, eventType, computeScoresFn) {
    try {
      if (!eventType) {
        throw new Error('Invalid eventType');
      }

      // 1) Atomic increment in Postgres — row creation, locking, and hard-limit
      //    enforcement all happen inside the RPC. No read-modify-write here.
      const { data: updatedCounts, error: rpcError } = await supabase.rpc(
        'increment_conversion_event_count',
        {
          p_id:          userId,
          p_event_type:  eventType,
          p_hard_limit:  HARD_COUNTER_LIMIT,
        }
      );

      if (rpcError) {
        throw new Error(
          `RPC increment_conversion_event_count failed: ${rpcError.message}`
        );
      }

      // 2) Read latest aggregate after atomic increment (for score computation)
      const { data: existingData, error: readError } = await supabase
        .from(this._table)
        .select('*')
        .eq('id', userId)
        .single();

      if (readError) throw readError;

      // 3) Compute derived scores using the latest counts returned by the RPC
      const {
        engagementScore,
        monetizationScore,
        totalIntentScore,
        isEngagementEvent,
        isMonetizationEvent,
      } = computeScoresFn(existingData, updatedCounts);

      const now = new Date().toISOString();

      const payload = {
        engagement_score:    engagementScore,
        monetization_score:  monetizationScore,
        total_intent_score:  totalIntentScore,
        score_version:       SCORE_VERSION,
        last_updated_at:     now,
        last_event_at:       now,
      };

      if (isEngagementEvent) {
        payload.last_engagement_event_at = now;
      }

      if (isMonetizationEvent) {
        payload.last_monetization_event_at = now;
      }

      // 4) Deterministic score-only update (scores are derived, not counters —
      //    a re-play with the same updatedCounts produces the same scores)
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

  // ---------------------------------------------------------------------------
  // Manual Upsert
  // ---------------------------------------------------------------------------

  async upsertAggregate(userId, data) {
    try {
      const payload = {
        ...data,
        id:              userId,
        score_version:   SCORE_VERSION,
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