'use strict';

/**
 * conversionAggregate.repository.js
 *
 * FIXED: Converted from Firestore to native Supabase.
 *
 * Removed:
 *   - db.collection() / this._ref() Firestore doc refs
 *   - this._db.runTransaction() / tx.get() / tx.set() / tx.update()
 *   - snap.exists / snap.data()
 *   - FieldValue.serverTimestamp()
 *   - admin?.firestore?.FieldValue fallback
 *
 * Replaced with:
 *   - supabase.from('conversion_aggregates') queries
 *   - { data, error } destructuring on every query
 *   - supabase.from().upsert() for incrementAndUpdate (replaces transaction)
 *   - ISO strings for all timestamps
 *
 * NOTE on atomicity:
 *   The original runTransaction() was used to safely increment eventCounts.
 *   Supabase does not expose client-side transactions. The safe replacement is
 *   a Postgres RPC for true atomic counter increments, but since computeScoresFn
 *   is a caller-supplied JS function it cannot run inside a DB transaction.
 *   The pattern here (read → compute → upsert) is the same best-effort
 *   approach that was already in use via the Firestore shim. If strict
 *   atomicity is required, extract the scoring logic into a Postgres function.
 */

const supabase = require('../../../config/supabase');
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
      // FIXED: { data, error } — removed this._ref(userId).get() / snap.exists / snap.data()
      const { data, error } = await supabase
        .from(this._table)
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      return data ?? null;
    } catch (err) {
      logger.error('ConversionAggregateRepository.getAggregate failed', {
        userId,
        error: err.message,
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Counter Increment + Score Update
  // ---------------------------------------------------------------------------

  /**
   * incrementAndUpdate(userId, eventType, computeScoresFn)
   *
   * FIXED: replaced this._db.runTransaction() with read → compute → upsert.
   *
   * Reads the current aggregate, increments the eventType counter,
   * calls computeScoresFn to derive new scores, then upserts the full row.
   *
   * computeScoresFn signature (unchanged from original):
   *   (existingData, eventCounts) => {
   *     engagementScore, monetizationScore, totalIntentScore,
   *     isEngagementEvent, isMonetizationEvent
   *   }
   */
  async incrementAndUpdate(userId, eventType, computeScoresFn) {
    try {
      // 1. Read current state
      const { data: existing, error: readError } = await supabase
        .from(this._table)
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (readError) throw readError;

      // 2. Compute new counts and scores in JS (same logic as original)
      const existingData  = existing ?? null;
      const eventCounts   = { ...(existingData?.event_counts || existingData?.eventCounts || {}) };
      const currentCount  = eventCounts[eventType] || 0;
      eventCounts[eventType] = Math.min(currentCount + 1, HARD_COUNTER_LIMIT);

      const {
        engagementScore,
        monetizationScore,
        totalIntentScore,
        isEngagementEvent,
        isMonetizationEvent,
      } = computeScoresFn(existingData, eventCounts);

      const now = new Date().toISOString();

      // 3. Build upsert payload
      // FIXED: replaced FieldValue.serverTimestamp() with ISO string timestamps
      const payload = {
        user_id:            userId,
        event_counts:       eventCounts,
        engagement_score:   engagementScore,
        monetization_score: monetizationScore,
        total_intent_score: totalIntentScore,
        score_version:      SCORE_VERSION,
        last_updated_at:    now,
        last_event_at:      now,
      };

      if (isEngagementEvent)    payload.last_engagement_event_at   = now;
      if (isMonetizationEvent)  payload.last_monetization_event_at = now;

      // 4. Upsert — insert if no row exists, update if it does
      // FIXED: replaced tx.set(ref, ...) / tx.update(ref, ...) with single upsert
      const { error: upsertError } = await supabase
        .from(this._table)
        .upsert([payload], { onConflict: 'user_id' });

      if (upsertError) throw upsertError;

      logger.debug('ConversionAggregateRepository.incrementAndUpdate', {
        userId,
        eventType,
      });
    } catch (err) {
      logger.error('ConversionAggregateRepository.incrementAndUpdate failed', {
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

  /**
   * upsertAggregate(userId, data)
   *
   * FIXED: replaced this._ref(userId).set({ merge: true }) with supabase upsert.
   */
  async upsertAggregate(userId, data) {
    try {
      // FIXED: removed FieldValue.serverTimestamp() — ISO string used instead
      const { error } = await supabase
        .from(this._table)
        .upsert([{
          ...data,
          user_id:         userId,
          score_version:   SCORE_VERSION,
          last_updated_at: new Date().toISOString(),
        }], { onConflict: 'user_id' });

      if (error) throw error;
    } catch (err) {
      logger.error('ConversionAggregateRepository.upsertAggregate failed', {
        userId,
        error: err.message,
      });
      throw err;
    }
  }
}

module.exports = new ConversionAggregateRepository();