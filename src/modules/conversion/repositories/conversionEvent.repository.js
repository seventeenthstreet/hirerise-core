'use strict';

/**
 * src/modules/conversion/repositories/conversionEvent.repository.js
 *
 * Production-grade Supabase conversion event repository.
 *
 * Final architecture:
 * - SQL unique partial index is source of truth for dedupe
 * - No application-side duplicate checks in write paths
 * - Safe under concurrency, retries, and multi-worker traffic
 * - isDuplicate retained as optional observability helper only
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../utils/conversion.logger');
const { DEDUP_WINDOW_MS } = require('../utils/eventWeights.config');

const TABLE = 'conversion_events';
const MAX_METADATA_SIZE_BYTES = 10 * 1024;
const MAX_RECENT_LIMIT = 500;

class ConversionEventRepository {
  constructor() {
    this.table = TABLE;
  }

  // ---------------------------------------------------------------------------
  // Optional Observability Helper (NOT write-path safety)
  // ---------------------------------------------------------------------------

  async isDuplicate(userId, eventType, idempotencyKey) {
    if (!idempotencyKey) return false;

    try {
      const windowStart = new Date(
        Date.now() - DEDUP_WINDOW_MS
      ).toISOString();

      const { data, error } = await supabase
        .from(this.table)
        .select('id')
        .eq('user_id', userId)
        .eq('event_type', eventType)
        .eq('idempotency_key', idempotencyKey)
        .gte('timestamp', windowStart)
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      return Boolean(data);
    } catch (error) {
      logger.warn('ConversionEventRepository.isDuplicate observability failed', {
        userId,
        eventType,
        error: error.message,
      });

      // fail-open by design; DB remains source of truth
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Single Event Record (SQL-native dedupe)
  // ---------------------------------------------------------------------------

  async recordEvent(
    userId,
    eventType,
    metadata = {},
    idempotencyKey = null
  ) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      if (!eventType) {
        throw new Error('eventType is required');
      }

      const payload = {
        user_id: userId,
        event_type: eventType,
        metadata: this._sanitizeMetadata(metadata),
        idempotency_key: idempotencyKey,
        timestamp: new Date().toISOString(),
      };

      const builder = supabase.from(this.table);

      const { data, error } = idempotencyKey
        ? await builder
            .upsert(payload, {
              onConflict: 'user_id,event_type,idempotency_key',
              ignoreDuplicates: true,
            })
            .select('id')
            .maybeSingle()
        : await builder
            .insert(payload)
            .select('id')
            .single();

      if (error) throw error;

      return data?.id ?? null;
    } catch (error) {
      logger.error('ConversionEventRepository.recordEvent failed', {
        userId,
        eventType,
        idempotencyKey,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Batch Event Record (SQL-native dedupe)
  // ---------------------------------------------------------------------------

  async batchRecordEvents(userId, events) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      if (!Array.isArray(events) || events.length === 0) {
        return;
      }

      const now = new Date().toISOString();

      const rows = events.map(
        ({ eventType, metadata = {}, idempotencyKey = null }) => ({
          user_id: userId,
          event_type: eventType,
          metadata: this._sanitizeMetadata(metadata),
          idempotency_key: idempotencyKey,
          timestamp: now,
        })
      );

      const { error } = await supabase
        .from(this.table)
        .upsert(rows, {
          onConflict: 'user_id,event_type,idempotency_key',
          ignoreDuplicates: true,
        });

      if (error) throw error;
    } catch (error) {
      logger.error(
        'ConversionEventRepository.batchRecordEvents failed',
        {
          userId,
          error: error.message,
        }
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getUserEvents(userId) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      const { data, error } = await supabase
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false });

      if (error) throw error;

      return data ?? [];
    } catch (error) {
      logger.error('ConversionEventRepository.getUserEvents failed', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  async getRecentEvents(userId, limit = 50) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      const safeLimit = Math.min(Number(limit) || 50, MAX_RECENT_LIMIT);

      const { data, error } = await supabase
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false })
        .limit(safeLimit);

      if (error) throw error;

      return data ?? [];
    } catch (error) {
      logger.error('ConversionEventRepository.getRecentEvents failed', {
        userId,
        limit,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Metadata Safety
  // ---------------------------------------------------------------------------

  _sanitizeMetadata(metadata) {
    try {
      const serialized = JSON.stringify(metadata || {});
      const size = Buffer.byteLength(serialized, 'utf8');

      if (size > MAX_METADATA_SIZE_BYTES) {
        logger.warn('ConversionEventRepository metadata truncated', {
          originalSize: size,
        });
        return { truncated: true };
      }

      return JSON.parse(serialized);
    } catch (error) {
      logger.warn('ConversionEventRepository invalid metadata', {
        error: error.message,
      });
      return {};
    }
  }
}

module.exports = new ConversionEventRepository();