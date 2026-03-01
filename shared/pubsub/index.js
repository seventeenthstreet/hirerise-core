/**
 * shared/pubsub/index.js
 *
 * Central Pub/Sub integration layer.
 * - Uses canonical event registry (shared/events)
 * - Enforces envelope builder
 * - Structured error handling
 * - Safe subscriber with JSON guard
 * - No duplicate EventTypes definition
 */

import { PubSub } from '@google-cloud/pubsub';
import { logger } from '../logger/index.js';
import { buildEnvelope, EventTypes } from '../events/index.js';
import { ErrorCodes, HireRiseError } from '../errors/index.js';

let _client = null;

function getClient() {
  if (!_client) {
    _client = new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  }
  return _client;
}

//
// ────────────────────────────────────────────────────────────
// Publisher
// ────────────────────────────────────────────────────────────
//

export async function publishEvent(topicName, eventType, payload, attributes = {}) {
  const client = getClient();

  // Build envelope using canonical registry
  const envelope = buildEnvelope(eventType, payload, process.env.SERVICE_NAME);

  const data = Buffer.from(JSON.stringify(envelope));

  const msgAttributes = {
    eventType: envelope.eventType,
    schemaVersion: envelope.schemaVersion,
    eventId: envelope.eventId,
    ...attributes,
  };

  try {
    const pubsubMessageId = await client.topic(topicName).publishMessage({
      data,
      attributes: msgAttributes,
    });

    logger.info('Event published', {
      eventId: envelope.eventId,
      eventType,
      topicName,
      pubsubMessageId,
    });

    return { eventId: envelope.eventId, pubsubMessageId };

  } catch (err) {
    logger.error('Failed to publish event', {
      err,
      eventType,
      topicName,
    });

    throw new HireRiseError(
      ErrorCodes.PUBSUB_PUBLISH_FAILED,
      `Failed to publish event ${eventType}`,
      { topicName }
    );
  }
}

//
// ────────────────────────────────────────────────────────────
// Subscriber
// ────────────────────────────────────────────────────────────
//

export function createSubscriber(subscriptionName, handler, options = {}) {
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

    try {
      envelope = JSON.parse(message.data.toString());
    } catch (err) {
      logger.error('Invalid JSON in Pub/Sub message', {
        err,
        subscriptionName,
        pubsubMessageId,
      });

      // Malformed JSON → permanent failure → ack
      message.ack();
      return;
    }

    const childLogger = logger.child({
      subscriptionName,
      pubsubMessageId,
      eventId: envelope?.eventId,
      eventType: envelope?.eventType,
      deliveryAttempt: message.deliveryAttempt,
    });

    try {
      childLogger.info('Message received');

      await handler(envelope, message);

      message.ack();

      childLogger.info('Message acknowledged');

    } catch (err) {
      childLogger.error('Message handler failed — nacking', {
        err,
        deliveryAttempt: message.deliveryAttempt,
      });

      message.nack(); // Pub/Sub will retry / DLQ
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

// Re-export canonical EventTypes (no duplication!)
export { EventTypes };