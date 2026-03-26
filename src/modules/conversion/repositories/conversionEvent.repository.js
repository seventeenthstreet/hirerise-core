'use strict';

const supabase = require('../../../core/supabaseClient');
const logger = require('../utils/conversion.logger');
const { DEDUP_WINDOW_MS } = require('../utils/eventWeights.config');

const TABLE = 'conversion_events';
const MAX_METADATA_SIZE_BYTES = 10 * 1024;

class ConversionEventRepository {

  async isDuplicate(userId, eventType, idempotencyKey) {
    if (!idempotencyKey) return false;

    const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

    try {
      const { data, error } = await supabase
        .from(TABLE)
        .select('id')
        .eq('user_id', userId)
        .eq('event_type', eventType)
        .eq('idempotency_key', idempotencyKey)
        .gte('timestamp', windowStart)
        .limit(1);

      if (error) throw error;

      return (data || []).length > 0;
    } catch (err) {
      logger.error('ConversionEventRepository.isDuplicate failed', {
        userId,
        eventType,
        error: err.message,
      });
      return false;
    }
  }

  async recordEvent(userId, eventType, metadata = {}, idempotencyKey = null) {
    try {
      const safeMetadata = this._sanitizeMetadata(metadata);

      const { data, error } = await supabase
        .from(TABLE)
        .insert({
          user_id: userId,
          event_type: eventType,
          metadata: safeMetadata,
          idempotency_key: idempotencyKey,
          timestamp: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      return data.id;
    } catch (err) {
      logger.error('ConversionEventRepository.recordEvent failed', {
        userId,
        eventType,
        error: err.message,
      });
      throw err;
    }
  }

  async batchRecordEvents(userId, events) {
    if (!events?.length) return;

    const rows = events.map(({ eventType, metadata = {}, idempotencyKey = null }) => ({
      user_id: userId,
      event_type: eventType,
      metadata: this._sanitizeMetadata(metadata),
      idempotency_key: idempotencyKey,
      timestamp: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from(TABLE)
      .insert(rows);

    if (error) {
      logger.error('ConversionEventRepository.batchRecordEvents failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  async getUserEvents(userId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    return data || [];
  }

  async getRecentEvents(userId, limit = 50) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return data || [];
  }

  _sanitizeMetadata(metadata) {
    try {
      const str = JSON.stringify(metadata || {});
      const size = Buffer.byteLength(str, 'utf8');

      if (size > MAX_METADATA_SIZE_BYTES) {
        logger.warn('ConversionEventRepository: metadata truncated', {
          originalSize: size,
        });
        return { truncated: true };
      }

      return JSON.parse(str);
    } catch (err) {
      logger.warn('ConversionEventRepository: invalid metadata', {
        error: err.message,
      });
      return {};
    }
  }
}

module.exports = new ConversionEventRepository();





