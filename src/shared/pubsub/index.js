'use strict';

/**
 * src/shared/pubsub/index.js
 *
 * Self-contained Pub/Sub module — no local dependencies besides utils/logger.
 * EventTypes and buildEnvelope are inlined to avoid missing module issues.
 * @google-cloud/pubsub is lazy-loaded so server starts fine in local dev.
 */

const logger = require('../../utils/logger');

// ── EventTypes (inlined from shared/events) ───────────────────────────────────

const EventTypes = Object.freeze({
  RESUME_SUBMITTED:           'RESUME_SUBMITTED',
  RESUME_PARSED:              'RESUME_PARSED',
  SCORE_UPDATED:              'SCORE_UPDATED',
  SALARY_BENCHMARK_REQUESTED: 'SALARY_BENCHMARK_REQUESTED',
  SALARY_BENCHMARK_COMPLETE:  'SALARY_BENCHMARK_COMPLETE',
  CAREER_PATH_REQUESTED:      'CAREER_PATH_REQUESTED',
  CAREER_PATH_COMPLETE:       'CAREER_PATH_COMPLETE',
  NOTIFICATION_REQUESTED:     'NOTIFICATION_REQUESTED',
  NOTIFICATION_SENT:          'NOTIFICATION_SENT',
  NOTIFICATION_FAILED:        'NOTIFICATION_FAILED',
  JOB_FAILED:                 'JOB_FAILED',
  JOB_DEAD:                   'JOB_DEAD',
});

const SchemaVersions = Object.freeze({
  [EventTypes.RESUME_SUBMITTED]:           '1.0',
  [EventTypes.SALARY_BENCHMARK_REQUESTED]: '1.0',
  [EventTypes.CAREER_PATH_REQUESTED]:      '1.0',
  [EventTypes.SCORE_UPDATED]:              '1.0',
  [EventTypes.NOTIFICATION_REQUESTED]:     '1.0',
  [EventTypes.JOB_FAILED]:                 '1.0',
  [EventTypes.JOB_DEAD]:                   '1.0',
});

function buildEnvelope(eventType, payload, source) {
  const { randomUUID } = require('crypto');
  return {
    eventId:       randomUUID(),
    eventType,
    schemaVersion: SchemaVersions[eventType] ?? '1.0',
    publishedAt:   new Date().toISOString(),
    source:        source ?? process.env.SERVICE_NAME ?? 'hirerise',
    payload,
  };
}

// ── PubSub client (lazy-loaded) ───────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    let PubSub;
    try {
      PubSub = require('@google-cloud/pubsub').PubSub;
    } catch (e) {
      throw new Error('@google-cloud/pubsub is not installed. Run: npm install @google-cloud/pubsub');
    }
    _client = new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  }
  return _client;
}

// ── Publisher ─────────────────────────────────────────────────────────────────

async function publishEvent(topicName, eventType, payload, attributes = {}) {
  const client   = getClient();
  const envelope = buildEnvelope(eventType, payload, process.env.SERVICE_NAME);
  const data     = Buffer.from(JSON.stringify(envelope));

  const msgAttributes = {
    eventType:     envelope.eventType,
    schemaVersion: envelope.schemaVersion,
    eventId:       envelope.eventId,
    ...attributes,
  };

  try {
    const pubsubMessageId = await client.topic(topicName).publishMessage({ data, attributes: msgAttributes });
    logger.info('Event published', { eventId: envelope.eventId, eventType, topicName, pubsubMessageId });
    return { eventId: envelope.eventId, pubsubMessageId };
  } catch (err) {
    logger.error('Failed to publish event', { err, eventType, topicName });
    const wrapped = new Error(`Failed to publish event ${eventType} to ${topicName}: ${err.message}`);
    wrapped.code  = 'PUBSUB_PUBLISH_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }
}

// ── Subscriber ────────────────────────────────────────────────────────────────

function createSubscriber(subscriptionName, handler, options = {}) {
  const client       = getClient();
  const subscription = client.subscription(subscriptionName, {
    flowControl: { maxMessages: options.maxMessages ?? 10 },
    ackDeadline: options.ackDeadlineSeconds ?? 60,
  });

  subscription.on('message', async (message) => {
    let envelope;
    try {
      envelope = JSON.parse(message.data.toString());
    } catch (err) {
      logger.error('Invalid JSON in Pub/Sub message', { err, subscriptionName, pubsubMessageId: message.id });
      message.ack();
      return;
    }

    const childLogger = logger.child({
      subscriptionName,
      pubsubMessageId: message.id,
      eventId:         envelope?.eventId,
      eventType:       envelope?.eventType,
      deliveryAttempt: message.deliveryAttempt,
    });

    try {
      childLogger.info('Message received');
      await handler(envelope, message);
      message.ack();
      childLogger.info('Message acknowledged');
    } catch (err) {
      childLogger.error('Message handler failed — nacking', { err, deliveryAttempt: message.deliveryAttempt });
      message.nack();
    }
  });

  subscription.on('error', (err) => logger.error('Subscription error', { err, subscriptionName }));
  subscription.on('close', ()  => logger.warn('Subscription closed',  { subscriptionName }));

  logger.info('Subscriber started', { subscriptionName });
  return subscription;
}

module.exports = { publishEvent, createSubscriber, EventTypes };








