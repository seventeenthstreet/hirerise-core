import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { logger } from '../../../shared/logger/index.js';
import { safeValidateEnvelope } from '../../../shared/validators/envelope.validator.js';
import { claimEvent, releaseEvent } from '../../../shared/deduplication/index.js';
import { ErrorCodes } from '../../../shared/errors/index.js';

const db = getFirestore();

const NOTIFICATION_TEMPLATES = {
  RESUME_SCORED: (data) => ({
    title: 'Resume analysis complete',
    body: `Your resume scored ${data.overallScore}/100 — ${data.tier} tier.`,
    actionUrl: `/dashboard/resume/${data.resumeId}`,
    channels: ['in_app', 'push'],
  }),
  SALARY_READY: (data) => ({
    title: 'Salary benchmark ready',
    body: `Median salary: $${(data.salaryMedian ?? 0).toLocaleString()}`,
    actionUrl: `/dashboard/salary/${data.jobId}`,
    channels: ['in_app', 'push'],
  }),
  JOB_FAILED: (data) => ({
    title: 'Processing error',
    body: `A processing error occurred (${data.errorCode}). Please try again.`,
    actionUrl: '/dashboard',
    channels: ['in_app'],
  }),

  // PROMPT-2: fired by onboarding.service.js saveDraft() after 24h if user
  // has not progressed past the draft step.
  // data: { actionUrl, message } — both optional, sensible defaults below.
  ONBOARDING_DRAFT_REENGAGEMENT: (data) => ({
    title: 'Your career profile is waiting',
    body: data.message || 'Complete your profile to unlock your Career Health Score.',
    actionUrl: data.actionUrl || '/onboarding',
    channels: ['in_app', 'push'],
  }),
};

export async function handleNotificationRequested(envelope, message) {

  const validated = safeValidateEnvelope(envelope, EventTypes.NOTIFICATION_REQUESTED);
  if (!validated) return;

  const { payload } = validated;
  const { userId, notificationType, data = {} } = payload;
  const { eventId } = envelope;

  const childLogger = logger.child({
    handler: 'notification-requested',
    userId,
    notificationType,
    eventId,
    deliveryAttempt: message.deliveryAttempt,
  });

  // ─────────────────────────────────────────────
  // Dedup
  // ─────────────────────────────────────────────

  const { claimed } = await claimEvent(eventId, { userId, notificationType });
  if (!claimed) {
    childLogger.info('Duplicate notification — skipped');
    return;
  }

  try {

    const templateFn = NOTIFICATION_TEMPLATES[notificationType];
    if (!templateFn) {
      childLogger.warn('No template for notification type');
      return;
    }

    const template = templateFn(data);
    const notificationId = `${userId}_${eventId}`;

    // ─────────────────────────────────────────
    // Write notification (idempotent)
    // ─────────────────────────────────────────

    await db.collection('notifications').doc(notificationId).set({
      notificationId,
      userId,
      notificationType,
      title: template.title,
      body: template.body,
      actionUrl: template.actionUrl,
      data,
      read: false,
      channels: template.channels,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: getExpiresAt(30),
      deliveryStatus: {
        in_app: 'delivered',
        push: 'pending',
      },
    }, { merge: false });

    childLogger.info('Notification saved');

    // ─────────────────────────────────────────
    // Push delivery
    // ─────────────────────────────────────────

    if (template.channels.includes('push')) {
      await deliverPushNotification(userId, template, notificationId, childLogger);
    }

  } catch (err) {

    childLogger.error('Notification processing failed', { err });

    // 🔥 CRITICAL FIX: release dedup on retryable errors
    await releaseEvent(eventId);

    throw err; // nack
  }
}

// ─────────────────────────────────────────────
// Push Delivery
// ─────────────────────────────────────────────

async function deliverPushNotification(userId, template, notificationId, logger) {

  const deliveryRef = db.collection('notificationDelivery')
    .doc(`${notificationId}_push`);

  const deliverySnap = await deliveryRef.get();

  if (deliverySnap.exists && deliverySnap.data().status === 'sent') {
    logger.info('Push already sent — skipping');
    return;
  }

  try {

    const tokenSnap = await db.collection('userFcmTokens').doc(userId).get();
    const fcmToken = tokenSnap.exists ? tokenSnap.data().token : null;

    if (!fcmToken) {
      logger.info('No FCM token — skipping push');
      await deliveryRef.set({
        status: 'no_token',
        attemptedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    await simulateFcmSend(fcmToken);

    await deliveryRef.set({
      status: 'sent',
      sentAt: FieldValue.serverTimestamp(),
    });

    await db.collection('notifications').doc(notificationId)
      .update({
        'deliveryStatus.push': 'delivered',
        pushDeliveredAt: FieldValue.serverTimestamp(),
      });

    logger.info('Push delivered');

  } catch (err) {

    logger.error('Push failed', { err });

    throw err; // handled by outer catch (dedup release)
  }
}

function simulateFcmSend() {
  return new Promise(res => setTimeout(res, 10));
}

function getExpiresAt(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}