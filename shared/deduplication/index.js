'use strict';

/**
 * shared/deduplication/index.js — FINAL FIXED
 *
 * ✅ CJS compatible
 * ✅ Redis health-aware
 * ✅ Safe fail-open behavior
 * ✅ Production hardened
 */

const redis = require('../redis.client');
const logger = require('../logger');

// Namespace to avoid collisions
const SERVICE = process.env.SERVICE_NAME || 'unknown-service';
const NODE_ENV = process.env.NODE_ENV || 'development';

const KEY_PREFIX = `event:dedup:${NODE_ENV}:${SERVICE}:`;
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ─────────────────────────────────────────────
// Redis Availability Check (FIXED)
// ─────────────────────────────────────────────

function isRedisAvailable() {
  try {
    return (
      redis &&
      typeof redis.set === 'function' &&
      typeof redis.isReady === 'function' &&
      redis.isReady()
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// claimEvent
// ─────────────────────────────────────────────

async function claimEvent(eventId, meta = {}) {
  if (!eventId || typeof eventId !== 'string') {
    logger.warn('[Deduplication] Invalid eventId — skipping dedup', { eventId });
    return { claimed: true };
  }

  if (!isRedisAvailable()) {
    logger.warn('[Deduplication] Redis unavailable — fail-open', {
      eventId,
      ...meta,
    });
    return { claimed: true };
  }

  const key = `${KEY_PREFIX}${eventId}`;

  try {
    const result = await redis.set(key, '1', 'NX', 'EX', TTL_SECONDS);

    if (result === 'OK') {
      logger.debug('[Deduplication] Event claimed', { eventId, ...meta });
      return { claimed: true };
    }

    logger.info('[Deduplication] Duplicate event skipped', { eventId, ...meta });
    return { claimed: false };

  } catch (err) {
    logger.error('[Deduplication] Redis error — fail-open', {
      eventId,
      error: err.message,
      ...meta,
    });

    return { claimed: true };
  }
}

// ─────────────────────────────────────────────
// releaseEvent
// ─────────────────────────────────────────────

async function releaseEvent(eventId) {
  if (!eventId || typeof eventId !== 'string') return;
  if (!isRedisAvailable()) return;

  const key = `${KEY_PREFIX}${eventId}`;

  try {
    await redis.del(key);
    logger.debug('[Deduplication] Lock released for retry', { eventId });
  } catch (err) {
    logger.warn('[Deduplication] Failed to release lock', {
      eventId,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = {
  claimEvent,
  releaseEvent,
};