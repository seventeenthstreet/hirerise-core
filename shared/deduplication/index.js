'use strict';

/**
 * shared/deduplication/index.js
 *
 * Distributed event deduplication for Pub/Sub workers.
 *
 * PROBLEM:
 *   Google Cloud Pub/Sub guarantees at-least-once delivery. A single message
 *   may be delivered more than once — either from a retry after a failed ack
 *   or from Pub/Sub's own internal re-delivery (rare but possible).
 *   Without deduplication, workers process the same event twice: double
 *   resume scores, duplicate notifications, etc.
 *
 * SOLUTION:
 *   Redis SETNX (SET if Not eXists) with a 24-hour TTL acts as a distributed
 *   seen-set. The first delivery claims the key; subsequent deliveries
 *   find the key present and skip processing.
 *
 * KEY STRUCTURE:
 *   event:dedup:{eventId}
 *
 *   eventId is the Pub/Sub message ID (envelope.eventId from shared/events).
 *   It is unique per logical event, so re-deliveries share the same ID.
 *
 * LIFECYCLE:
 *   1. Worker receives message.
 *   2. Worker calls claimEvent(eventId).
 *   3. claimEvent does: SET event:dedup:{eventId} 1 NX EX 86400
 *      - Returns true  → first delivery → proceed
 *      - Returns false → duplicate      → ack and return
 *   4. On completion, key remains until it naturally expires after 24 h.
 *   5. On retryable failure, releaseEvent(eventId) deletes the key so the
 *      next delivery can claim it and re-process.
 *
 * GRACEFUL DEGRADATION:
 *   If Redis is unavailable, claimEvent returns true (fail-open) and logs
 *   a warning. The worker processes the event without deduplication rather
 *   than blocking all progress.
 *
 * USAGE:
 *   import { claimEvent, releaseEvent } from '../../shared/deduplication/index.js';
 *
 *   const { claimed } = await claimEvent(eventId, { userId, resumeId });
 *   if (!claimed) {
 *     processingLogger.info('Duplicate event — skipped via dedup');
 *     return; // ack the message silently
 *   }
 *   // ... process ...
 *   // On retryable error:
 *   await releaseEvent(eventId);
 *   throw err; // nack for retry
 *
 * @module shared/deduplication
 */

import redis from '../redis.client.js';

const KEY_PREFIX  = 'event:dedup:';
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ── Lazy logger (shared/logger may not always be available) ───────────────────

function getLogger() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../logger/index.js').logger ?? console;
  } catch {
    return console;
  }
}

// ─── claimEvent ──────────────────────────────────────────────────────────────

/**
 * claimEvent(eventId, meta?)
 *
 * Attempts to claim exclusive processing rights for the given event ID.
 *
 * @param {string} eventId  — Pub/Sub message ID (envelope.eventId)
 * @param {object} [meta]   — Optional logging context (userId, jobId, …)
 * @returns {Promise<{ claimed: boolean }>}
 *   claimed: true  → proceed; this worker owns the event
 *   claimed: false → duplicate; skip silently
 */
export async function claimEvent(eventId, meta = {}) {
  const log = getLogger();

  if (!eventId || typeof eventId !== 'string') {
    log.warn('[Deduplication] claimEvent called with invalid eventId — skipping dedup', { eventId });
    return { claimed: true }; // fail-open: don't block workers on bad input
  }

  // Redis unavailable — fail open so workers don't stall
  if (!redis) {
    log.warn('[Deduplication] Redis unavailable — deduplication skipped (fail-open)', { eventId, ...meta });
    return { claimed: true };
  }

  try {
    const key = `${KEY_PREFIX}${eventId}`;

    // SET key 1 NX EX ttl
    //   NX  — only set if key does NOT exist
    //   EX  — expire after TTL seconds
    // Returns 'OK' if key was set (first claim), null if key already existed (duplicate)
    const result = await redis.set(key, '1', 'NX', 'EX', TTL_SECONDS);

    if (result === 'OK') {
      log.debug('[Deduplication] Event claimed', { eventId, ...meta });
      return { claimed: true };
    }

    // Key already existed — duplicate delivery
    log.info('[Deduplication] Duplicate event detected — skipping', { eventId, ...meta });
    return { claimed: false };

  } catch (err) {
    // Redis error — fail open to avoid blocking all workers during a Redis blip
    log.error('[Deduplication] Redis error during claimEvent — failing open', {
      eventId,
      error: err.message,
      ...meta,
    });
    return { claimed: true };
  }
}

// ─── releaseEvent ─────────────────────────────────────────────────────────────

/**
 * releaseEvent(eventId)
 *
 * Deletes the deduplication key, allowing the next Pub/Sub delivery to
 * re-claim and re-process the event. Call this ONLY on retryable failures
 * where you want Pub/Sub to retry the message.
 *
 * Do NOT call on permanent failures (bad payload, schema error) — those
 * should be silently acked and let expire naturally.
 *
 * @param {string} eventId
 * @returns {Promise<void>}
 */
export async function releaseEvent(eventId) {
  const log = getLogger();

  if (!eventId || typeof eventId !== 'string') return;
  if (!redis) return;

  try {
    await redis.del(`${KEY_PREFIX}${eventId}`);
    log.debug('[Deduplication] Event lock released for retry', { eventId });
  } catch (err) {
    // Non-fatal — if the DEL fails, the key will expire naturally in 24 h.
    // The event won't be re-processed until a new message arrives anyway.
    log.warn('[Deduplication] Failed to release event lock', {
      eventId,
      error: err.message,
    });
  }
}