'use strict';

/**
 * shared/pubsub/index.js
 *
 * Supabase-native transport layer
 * ✅ Correct Supabase import path
 * ✅ Google Pub/Sub fully removed
 * ✅ Firebase legacy transport removed
 * ✅ Postgres outbox pattern
 * ✅ Retry-safe row lifecycle
 * ✅ Worker polling subscriber
 * ✅ SKIP LOCKED concurrency
 */

const { supabase } = require('../../src/config/supabase');
const logger = require('../logger');
const {
  buildEnvelope,
  EventTypes,
  validateEnvelope,
  getTopicForEvent,
} = require('../events');

const POLL_INTERVAL_MS = 1000;
const MAX_RETRIES = 5;

/**
 * Publish event into Postgres outbox
 */
async function publishEvent(eventType, payload, attributes = {}) {
  const route = getTopicForEvent(eventType);

  const envelope = buildEnvelope(
    eventType,
    payload,
    process.env.SERVICE_NAME,
    attributes
  );

  const { data, error } = await supabase
    .from('event_outbox')
    .insert({
      event_id: envelope.eventId,
      route,
      event_type: envelope.eventType,
      schema_version: envelope.schemaVersion,
      idempotency_key: envelope.idempotencyKey,
      payload: envelope,
      status: 'pending',
      retry_count: 0,
      published_at: envelope.publishedAt,
    })
    .select('id')
    .single();

  if (error) {
    logger.error('Failed to publish event', {
      err: error,
      eventType,
      eventId: envelope.eventId,
    });

    const wrapped = new Error(`Publish failed: ${error.message}`);
    wrapped.code = 'OUTBOX_PUBLISH_FAILED';
    throw wrapped;
  }

  logger.info('Event published', {
    eventId: envelope.eventId,
    eventType,
    route,
    outboxId: data.id,
  });

  return {
    eventId: envelope.eventId,
    outboxId: data.id,
  };
}

/**
 * Create DB polling subscriber
 */
function createSubscriber(route, handler, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let timer = null;

  async function poll() {
    if (stopped) return;

    try {
      const { data: rows, error } = await supabase.rpc(
        'claim_outbox_events',
        {
          p_route: route,
          p_batch_size: options.maxMessages ?? 10,
        }
      );

      if (error) {
        logger.error('Subscriber poll failed', { err: error, route });
        return;
      }

      for (const row of rows || []) {
        const envelope = row.payload;

        const validation = validateEnvelope(envelope);

        if (!validation.valid) {
          logger.error('Invalid envelope', {
            route,
            eventId: row.event_id,
            errors: validation.errors,
          });

          await markProcessed(row.id, 'failed_permanent');
          continue;
        }

        const childLogger = logger.child({
          route,
          eventId: envelope.eventId,
          outboxId: row.id,
          retryCount: row.retry_count,
        });

        try {
          childLogger.info('Message received');

          await Promise.race([
            handler(envelope, row),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Handler timeout')),
                timeoutMs
              )
            ),
          ]);

          await markProcessed(row.id, 'processed');
          childLogger.info('Message acknowledged');
        } catch (err) {
          const retryable =
            !err.code || err.code !== 'PERMANENT_ERROR';

          childLogger.error('Handler failed', {
            err,
            retryable,
          });

          if (retryable && row.retry_count < MAX_RETRIES) {
            await retryEvent(row.id);
          } else {
            await markProcessed(row.id, 'failed');
          }
        }
      }
    } catch (err) {
      logger.error('Subscriber loop error', { err, route });
    }
  }

  timer = setInterval(poll, pollInterval);

  logger.info('Subscriber started', { route });

  return {
    close() {
      stopped = true;
      clearInterval(timer);
      logger.warn('Subscriber closed', { route });
    },
  };
}

async function markProcessed(id, status) {
  await supabase
    .from('event_outbox')
    .update({
      status,
      processed_at: new Date().toISOString(),
    })
    .eq('id', id);
}

async function retryEvent(id) {
  await supabase.rpc('retry_outbox_event', {
    p_id: id,
  });
}

module.exports = {
  publishEvent,
  createSubscriber,
  EventTypes,
};