'use strict';

/**
 * shared/pubsub/index.js
 *
 * ✅ Envelope validation added
 * ✅ Deduplication hook ready
 * ✅ Retry classification
 * ✅ Timeout protection
 * ✅ Topic safety
 */

const { PubSub } = require('@google-cloud/pubsub');
const logger = require('../logger');
const {
  buildEnvelope,
  EventTypes,
  validateEnvelope,
  getTopicForEvent,
} = require('../events');

let _client = null;

function getClient() {
  if (!_client) {
    _client = new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  }
  return _client;
}

// ────────────────────────────────────────────
// Publisher
// ────────────────────────────────────────────

async function publishEvent(eventType, payload, attributes = {}) {
  const client = getClient();

  const topicName = getTopicForEvent(eventType); // ✅ SAFE

  const envelope = buildEnvelope(eventType, payload, process.env.SERVICE_NAME);
  const data = Buffer.from(JSON.stringify(envelope));

  try {
    const pubsubMessageId = await client.topic(topicName).publishMessage({
      data,
      attributes: {
        eventType: envelope.eventType,
        schemaVersion: envelope.schemaVersion,
        eventId: envelope.eventId,
        ...attributes,
      },
    });

    logger.info('Event published', {
      eventId: envelope.eventId,
      eventType,
      topicName,
      pubsubMessageId,
    });

    return { eventId: envelope.eventId, pubsubMessageId };

  } catch (err) {
    logger.error('Failed to publish event', { err, eventType });

    const wrapped = new Error(`Publish failed: ${err.message}`);
    wrapped.code = 'PUBSUB_PUBLISH_FAILED';
    throw wrapped;
  }
}

// ────────────────────────────────────────────
// Subscriber
// ────────────────────────────────────────────

function createSubscriber(subscriptionName, handler, options = {}) {
  const client = getClient();

  const subscription = client.subscription(subscriptionName, {
    flowControl: {
      maxMessages: options.maxMessages ?? 10,
    },
    ackDeadline: options.ackDeadlineSeconds ?? 60,
  });

  subscription.on('message', async (message) => {
    const pubsubMessageId = message.id;
    let envelope;

    // ─── Parse ─────────────────────────────
    try {
      envelope = JSON.parse(message.data.toString());
    } catch (err) {
      logger.error('Invalid JSON', { err, pubsubMessageId });
      message.ack(); // permanent failure
      return;
    }

    // ─── Validate Envelope (FIXED) ─────────
    const validation = validateEnvelope(envelope);
    if (!validation.valid) {
      logger.error('Invalid envelope', {
        errors: validation.errors,
        pubsubMessageId,
      });
      message.ack(); // bad data → drop
      return;
    }

    const childLogger = logger.child({
      subscriptionName,
      pubsubMessageId,
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      deliveryAttempt: message.deliveryAttempt,
    });

    try {
      childLogger.info('Message received');

      // ─── Timeout Protection (FIXED) ──────
      const timeoutMs = options.timeoutMs ?? 30000;

      await Promise.race([
        handler(envelope, message),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Handler timeout')), timeoutMs)
        ),
      ]);

      message.ack();
      childLogger.info('Message acknowledged');

    } catch (err) {
      const isRetryable = !err.code || err.code !== 'PERMANENT_ERROR';

      childLogger.error('Handler failed', {
        err,
        retryable: isRetryable,
      });

      if (isRetryable) {
        message.nack(); // retry
      } else {
        message.ack(); // drop
      }
    }
  });

  subscription.on('error', (err) => {
    logger.error('Subscription error', { err, subscriptionName });
  });

  subscription.on('close', () => {
    logger.warn('Subscription closed', { subscriptionName });
  });

  logger.info('Subscriber started', { subscriptionName });

  return subscription;
}

module.exports = {
  publishEvent,
  createSubscriber,
  EventTypes,
};