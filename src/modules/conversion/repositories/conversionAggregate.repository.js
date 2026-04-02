'use strict';

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/conversion.logger');
const { HARD_COUNTER_LIMIT, SCORE_VERSION } = require('../utils/eventWeights.config');

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
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      return data ?? null;

    } catch (err) {
      logger.error('getAggregate failed', { userId, error: err.message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Increment + Update
  // ---------------------------------------------------------------------------

  async incrementAndUpdate(userId, eventType, computeScoresFn) {
    try {
      if (!eventType) {
        throw new Error('Invalid eventType');
      }

      // 1. Read
      const { data: existing, error: readError } = await supabase
        .from(this._table)
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (readError) throw readError;

      const existingData = existing ?? null;

      // ✅ FIXED: only snake_case
      const eventCounts = {
        ...(existingData?.event_counts || {})
      };

      const currentCount = eventCounts[eventType] || 0;
      eventCounts[eventType] = Math.min(currentCount + 1, HARD_COUNTER_LIMIT);

      // 2. Compute scores
      const {
        engagementScore,
        monetizationScore,
        totalIntentScore,
        isEngagementEvent,
        isMonetizationEvent,
      } = computeScoresFn(existingData, eventCounts);

      const now = new Date().toISOString();

      // 3. Payload
      const payload = {
        user_id: userId,
        event_counts: eventCounts,
        engagement_score: engagementScore,
        monetization_score: monetizationScore,
        total_intent_score: totalIntentScore,
        score_version: SCORE_VERSION,
        last_updated_at: now,
        last_event_at: now,
      };

      if (isEngagementEvent) {
        payload.last_engagement_event_at = now;
      }

      if (isMonetizationEvent) {
        payload.last_monetization_event_at = now;
      }

      // 4. Upsert + return updated row
      const { data, error } = await supabase
        .from(this._table)
        .upsert([payload], { onConflict: 'user_id' })
        .select()
        .single();

      if (error) throw error;

      logger.debug('incrementAndUpdate success', { userId, eventType });

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
        user_id: userId,
        score_version: SCORE_VERSION,
        last_updated_at: new Date().toISOString(),
      };

      const { data: result, error } = await supabase
        .from(this._table)
        .upsert([payload], { onConflict: 'user_id' })
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
