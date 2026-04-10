'use strict';

/**
 * @file src/shared/pubsub/index.js
 * @description
 * Production-grade Pub/Sub abstraction.
 *
 * Wave 3 Priority #3 hardening:
 * - lazy singleton
 * - poison-message protection
 * - publish timeout safety
 * - local-dev graceful fallback
 */

const { randomUUID } = require('crypto');
const logger = require('../../utils/logger');

const EventTypes = Object.freeze({
  RESUME_SUBMITTED: 'RESUME_SUBMITTED',
  RESUME_PARSED: 'RESUME_PARSED',
  SCORE_UPDATED: 'SCORE_UPDATED',
  SALARY_BENCHMARK_REQUESTED: 'SALARY_BENCHMARK_REQUESTED',
  SALARY_BENCHMARK_COMPLETE: 'SALARY_BENCHMARK_COMPLETE',
  CAREER_PATH_REQUESTED: 'CAREER_PATH_REQUESTED',
  CAREER_PATH_COMPLETE: 'CAREER_PATH_COMPLETE',
  NOTIFICATION_REQUESTED: 'NOTIFICATION_REQUESTED',
  NOTIFICATION_SENT: 'NOTIFICATION_SENT',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
  JOB_FAILED: 'JOB_FAILED',
  JOB_DEAD: 'JOB_DEAD',
});

const SchemaVersions = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]: '1.0',
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: '1.0',
  [EventTypes.CAREER_PATH_REQUESTED]: '1.0',
  [EventTypes.SCORE_UPDATED]: '1.0',
  [EventTypes.NOTIFICATION_REQUESTED]: '1.0',
  [EventTypes.JOB_FAILED]: '1.0',
  [EventTypes.JOB_DEAD]: '1.0',
});

const MAX_DELIVERY_ATTEMPTS = 5;
const PUBLISH_TIMEOUT_MS = 8000;

function buildEnvelope(eventType, payload, source) {
  return {
    eventId: randomUUID(),
    eventType,
    schemaVersion: SchemaVersions[eventType] ?? '1.0',
    publishedAt: new Date().toISOString(),
    source: source || process.env.SERVICE_NAME || 'hirerise',
    payload: payload ?? {},
  };
}

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      let PubSub;

      try {
        ({ PubSub } = require('@google-cloud/pubsub'));
      } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
          logger.warn(
            '[PubSub] dependency missing, using noop local fallback'
          );

          return {
            topic: () => ({
              publishMessage: async () => 'local-noop-message-id',
            }),
            subscription: () => ({
              on: () => {},
            }),
          };
        }

        const wrapped = new Error(
          '@google-cloud/pubsub dependency missing'
        );
        wrapped.code = 'PUBSUB_DEPENDENCY_MISSING';
        wrapped.cause = error;
        throw wrapped;
      }

      return new PubSub({
        projectId: process.env.GOOGLE_CLOUD_PROJECT,
      });
    })();
  }

  return clientPromise;
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`${label} timed out after ${timeoutMs}ms`)
          ),
        timeoutMs
      )
    ),
  ]);
}

async function publishEvent(topicName, eventType, payload, attributes = {}) {
  if (!topicName) {
    throw new Error('publishEvent requires topicName');
  }

  const client = await getClient();
  const envelope = buildEnvelope(
    eventType,
    payload,
    process.env.SERVICE_NAME
  );

  const data = Buffer.from(JSON.stringify(envelope));

  const msgAttributes = {
    eventType: envelope.eventType,
    schemaVersion: envelope.schemaVersion,
    eventId: envelope.eventId,
    ...attributes,
  };

  try {
    const pubsubMessageId = await withTimeout(
      client
        .topic(topicName)
        .publishMessage({ data, attributes: msgAttributes }),
      PUBLISH_TIMEOUT_MS,
      'PubSub publish'
    );

    logger.info('Event published', {
      topicName,
      eventType,
      eventId: envelope.eventId,
      pubsubMessageId,
    });

    return {
      eventId: envelope.eventId,
      pubsubMessageId,
    };
  } catch (error) {
    logger.error('Failed to publish event', {
      topicName,
      eventType,
      error: error.message,
    });

    const wrapped = new Error(
      `Failed to publish ${eventType} to ${topicName}: ${error.message}`
    );
    wrapped.code = 'PUBSUB_PUBLISH_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }
}

async function createSubscriber(subscriptionName, handler, options = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('createSubscriber requires handler');
  }

  const client = await getClient();

  const subscription = client.subscription(subscriptionName, {
    flowControl: {
      maxMessages: Number(options.maxMessages) || 10,
    },
    ackDeadline: Number(options.ackDeadlineSeconds) || 60,
  });

  subscription.on('message', async (message) => {
    let envelope;

    try {
      envelope = JSON.parse(message.data.toString('utf8'));
    } catch (error) {
      logger.error('Invalid Pub/Sub JSON payload', {
        subscriptionName,
        pubsubMessageId: message.id,
      });
      message.ack();
      return;
    }

    const attempt = message.deliveryAttempt || 1;

    const childLogger = logger.child({
      subscriptionName,
      pubsubMessageId: message.id,
      eventId: envelope?.eventId || null,
      eventType: envelope?.eventType || null,
      deliveryAttempt: attempt,
    });

    try {
      childLogger.info('Message received');
      await handler(envelope, message);
      message.ack();
      childLogger.info('Message acknowledged');
    } catch (error) {
      childLogger.error('Message handler failed', {
        error: error.message,
      });

      if (attempt >= MAX_DELIVERY_ATTEMPTS) {
        childLogger.error(
          'Poison message threshold reached, acking permanently'
        );
        message.ack();
      } else {
        message.nack();
      }
    }
  });

  subscription.on('error', (error) => {
    logger.error('Subscription error', {
      subscriptionName,
      error: error.message,
    });
  });

  subscription.on('close', () => {
    logger.warn('Subscription closed', { subscriptionName });
  });

  logger.info('Subscriber started', { subscriptionName });

  return subscription;
}

module.exports = Object.freeze({
  publishEvent,
  createSubscriber,
  buildEnvelope,
  EventTypes,
});