'use strict';

/**
 * shared/deduplication/index.js
 *
 * Production-ready distributed event deduplication
 * ✅ Firebase-free
 * ✅ Supabase worker safe
 * ✅ Redis fail-open
 * ✅ Dynamic service scoping
 * ✅ Safer Redis readiness detection
 * ✅ Modern Redis SET syntax
 * ✅ Key normalization
 * ✅ Better retry semantics
 */

const redis = require('../redis.client');
const logger = require('../logger');

const NODE_ENV = process.env.NODE_ENV || 'development';
const TTL_SECONDS = 24 * 60 * 60; // 24h

function getServiceName() {
  return process.env.SERVICE_NAME || 'unknown-service';
}

function getKeyPrefix() {
  return `event:dedup:${NODE_ENV}:${getServiceName()}:`;
}

function normalizeEventId(eventId) {
  return String(eventId).trim().slice(0, 200);
}

function isRedisAvailable() {
  try {
    if (!redis) return false;

    if (typeof redis.isReady === 'function') {
      return redis.isReady();
    }

    if (typeof redis.isOpen === 'boolean') {
      return redis.isOpen;
    }

    if (typeof redis.status === 'string') {
      return redis.status === 'ready';
    }

    return typeof redis.set === 'function';
  } catch {
    return false;
  }
}

/**
 * Attempt to claim event for processing.
 * Fail-open by design to avoid blocking core business flow.
 */
async function claimEvent(eventId, meta = {}) {
  if (!eventId || typeof eventId !== 'string') {
    logger.warn('[Deduplication] Invalid eventId — skipping dedup', {
      eventId,
      ...meta,
    });
    return { claimed: true };
  }

  if (!isRedisAvailable()) {
    logger.warn('[Deduplication] Redis unavailable — fail-open', {
      eventId,
      ...meta,
    });
    return { claimed: true };
  }

  const normalizedEventId = normalizeEventId(eventId);
  const key = `${getKeyPrefix()}${normalizedEventId}`;

  try {
    const result = await redis.set(key, '1', {
      NX: true,
      EX: TTL_SECONDS,
    });

    if (result === 'OK' || result === true) {
      logger.debug('[Deduplication] Event claimed', {
        eventId: normalizedEventId,
        ...meta,
      });

      return { claimed: true };
    }

    logger.info('[Deduplication] Duplicate event skipped', {
      eventId: normalizedEventId,
      ...meta,
    });

    return { claimed: false };

  } catch (error) {
    logger.error('[Deduplication] Redis error — fail-open', {
      eventId: normalizedEventId,
      error: error.message,
      ...meta,
    });

    return { claimed: true };
  }
}

/**
 * Release dedup lock to allow safe retry after worker failure.
 */
async function releaseEvent(eventId, meta = {}) {
  if (!eventId || typeof eventId !== 'string') return;
  if (!isRedisAvailable()) return;

  const normalizedEventId = normalizeEventId(eventId);
  const key = `${getKeyPrefix()}${normalizedEventId}`;

  try {
    await redis.del(key);

    logger.debug('[Deduplication] Lock released for retry', {
      eventId: normalizedEventId,
      ...meta,
    });
  } catch (error) {
    logger.warn('[Deduplication] Failed to release lock', {
      eventId: normalizedEventId,
      error: error.message,
      ...meta,
    });
  }
}

module.exports = {
  claimEvent,
  releaseEvent,
};