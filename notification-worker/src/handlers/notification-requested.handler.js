'use strict';

import { createClient } from '@supabase/supabase-js';
import { publishEvent, EventTypes } from '../../../shared/pubsub/index.js';
import { logger } from '../../../shared/logger/index.js';
import { safeValidateEnvelope } from '../../../shared/validators/envelope.validator.js';
import { claimEvent, releaseEvent } from '../../../shared/deduplication/index.js';
import { ErrorCodes } from '../../../shared/errors/index.js';

// ─── Supabase Admin (RLS BYPASS) ───────────────────────

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Templates ─────────────────────────────────────────

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

  ONBOARDING_DRAFT_REENGAGEMENT: (data) => ({
    title: 'Your career profile is waiting',
    body: data.message || 'Complete your profile to unlock your Career Health Score.',
    actionUrl: data.actionUrl || '/onboarding',
    channels: ['in_app', 'push'],
  }),
};

// ─── Main Handler ─────────────────────────────────────

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

  if (!userId) {
    childLogger.warn('Missing userId — skipping notification');
    return;
  }

  // ─── Dedup ─────────────────────────────────────────

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

    // ─── Insert Notification ─────────────────────────

    const { error: insertError } = await supabaseAdmin
      .from('notifications')
      .insert({
        id: notificationId,
        user_id: userId,
        notification_type: notificationType,
        title: template.title,
        body: template.body,
        action_url: template.actionUrl,
        data,
        read: false,
        channels: template.channels,
        created_at: new Date().toISOString(),
        expires_at: getExpiresAt(30),
        delivery_status: {
          in_app: 'delivered',
          push: 'pending',
        },
      })
      .select();

    if (insertError) {
      childLogger.error('Notification insert failed', insertError);
      throw insertError;
    }

    childLogger.info('Notification saved');

    // ─── Push Delivery ───────────────────────────────

    if (template.channels.includes('push')) {
      await deliverPushNotification(userId, template, notificationId, childLogger);
    }

  } catch (err) {
    childLogger.error('Notification processing failed', { err });

    await releaseEvent(eventId); // allow retry
    throw err;
  }
}

// ─────────────────────────────────────────────
// Push Delivery
// ─────────────────────────────────────────────

async function deliverPushNotification(userId, template, notificationId, logger) {

  // Check existing delivery status
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('notification_delivery')
    .select('*')
    .eq('id', `${notificationId}_push`)
    .maybeSingle();

  if (fetchError) {
    logger.error('Delivery fetch error', fetchError);
    throw fetchError;
  }

  if (existing?.status === 'sent') {
    logger.info('Push already sent — skipping');
    return;
  }

  try {
    // Fetch FCM token
    const { data: tokenRow, error: tokenError } = await supabaseAdmin
      .from('user_fcm_tokens')
      .select('token')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (tokenError) {
      logger.error('Token fetch error', tokenError);
      throw tokenError;
    }

    const fcmToken = tokenRow?.token;

    if (!fcmToken) {
      logger.info('No FCM token — skipping push');

      await supabaseAdmin
        .from('notification_delivery')
        .upsert({
          id: `${notificationId}_push`,
          status: 'no_token',
          attempted_at: new Date().toISOString(),
        });

      return;
    }

    // Simulate push send
    await simulateFcmSend(fcmToken);

    // Mark push sent
    await supabaseAdmin
      .from('notification_delivery')
      .upsert({
        id: `${notificationId}_push`,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

    // ─── FIX: Merge JSON instead of overwrite ─────────

    const { data: existingNotif } = await supabaseAdmin
      .from('notifications')
      .select('delivery_status')
      .eq('id', notificationId)
      .single();

    const updatedStatus = {
      ...(existingNotif?.delivery_status || {}),
      push: 'delivered',
    };

    await supabaseAdmin
      .from('notifications')
      .update({
        delivery_status: updatedStatus,
        push_delivered_at: new Date().toISOString(),
      })
      .eq('id', notificationId);

    logger.info('Push delivered');

  } catch (err) {
    logger.error('Push failed', { err });
    throw err;
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function simulateFcmSend() {
  return new Promise(res => setTimeout(res, 10));
}

function getExpiresAt(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}