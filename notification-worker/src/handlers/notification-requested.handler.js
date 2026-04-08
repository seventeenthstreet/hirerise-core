'use strict';

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../../shared/logger/index.js';
import { safeValidateEnvelope } from '../../../shared/validators/envelope.validator.js';
import {
  claimEvent,
  releaseEvent,
} from '../../../shared/deduplication/index.js';
import { EventTypes } from '../../../shared/pubsub/index.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
  );
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

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
    body:
      data.message ||
      'Complete your profile to unlock your Career Health Score.',
    actionUrl: data.actionUrl || '/onboarding',
    channels: ['in_app', 'push'],
  }),
};

export async function handleNotificationRequested(envelope, message) {
  const validated = safeValidateEnvelope(
    envelope,
    EventTypes.NOTIFICATION_REQUESTED
  );

  if (!validated) return;

  const { payload } = validated;
  const { userId, notificationType, data = {} } = payload;
  const { eventId } = envelope;

  const childLogger = logger.child({
    handler: 'notification-requested',
    userId,
    notificationType,
    eventId,
    deliveryAttempt: message?.deliveryAttempt,
  });

  if (!userId) {
    childLogger.warn('Missing userId — skipping notification');
    return;
  }

  const { claimed } = await claimEvent(eventId, {
    userId,
    notificationType,
  });

  if (!claimed) {
    childLogger.info('Duplicate notification — skipped');
    return;
  }

  try {
    const templateFn = NOTIFICATION_TEMPLATES[notificationType];

    if (!templateFn) {
      childLogger.warn('No template for notification type');
      await releaseEvent(eventId);
      return;
    }

    const template = templateFn(data);
    const notificationId = `${userId}_${eventId}`;

    const { error: insertError } = await supabaseAdmin
      .from('notifications')
      .upsert(
        {
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
            push: template.channels.includes('push')
              ? 'pending'
              : 'not_applicable',
          },
        },
        {
          onConflict: 'id',
        }
      );

    if (insertError) {
      throw insertError;
    }

    childLogger.info('Notification saved');

    if (template.channels.includes('push')) {
      await deliverPushNotification(
        userId,
        notificationId,
        childLogger
      );
    }
  } catch (err) {
    childLogger.error('Notification processing failed', {
      error: err?.message,
    });

    await releaseEvent(eventId);
    throw err;
  }
}

async function deliverPushNotification(
  userId,
  notificationId,
  log
) {
  const deliveryId = `${notificationId}_push`;

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('notification_delivery')
    .select('status')
    .eq('id', deliveryId)
    .maybeSingle();

  if (fetchError) throw fetchError;

  if (existing?.status === 'sent') {
    log.info('Push already sent — skipping');
    return;
  }

  const { data: tokenRow, error: tokenError } = await supabaseAdmin
    .from('user_fcm_tokens')
    .select('token')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (tokenError) throw tokenError;

  const pushToken = tokenRow?.token;

  if (!pushToken) {
    await supabaseAdmin
      .from('notification_delivery')
      .upsert({
        id: deliveryId,
        status: 'no_token',
        attempted_at: new Date().toISOString(),
      });

    return;
  }

  await simulatePushSend(pushToken);

  await supabaseAdmin
    .from('notification_delivery')
    .upsert({
      id: deliveryId,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

  // FIX: replaced 3-step SELECT → JS merge → UPDATE with a single atomic
  // database-level merge via merge_notification_delivery_status().
  //
  // BEFORE (race condition):
  //   const { data: existingNotif } = await supabaseAdmin
  //     .from('notifications').select('delivery_status').eq('id', notificationId).single();
  //   const updatedStatus = { ...(existingNotif?.delivery_status || {}), push: 'delivered' };
  //   await supabaseAdmin.from('notifications').update({ delivery_status: updatedStatus, ... })
  //
  // Two concurrent workers would both read the same delivery_status snapshot,
  // both spread it, and the last writer would silently overwrite the first —
  // dropping whichever channel the first worker had already merged in.
  //
  // AFTER: single UPDATE with COALESCE || jsonb_build_object inside Postgres.
  // No read round-trip. Row-level lock guarantees no interleaving between workers.
  const { error: mergeError } = await supabaseAdmin.rpc(
    'merge_notification_delivery_status',
    {
      p_notification_id: notificationId,
      p_channel:         'push',
      p_status:          'delivered',
    }
  );

  if (mergeError) throw mergeError;

  // push_delivered_at is a separate scalar column — safe to update independently
  // since it's not part of the JSONB merge and has no concurrent writers.
  const { error: timestampError } = await supabaseAdmin
    .from('notifications')
    .update({ push_delivered_at: new Date().toISOString() })
    .eq('id', notificationId);

  if (timestampError) throw timestampError;

  log.info('Push delivered');
}

function simulatePushSend() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function getExpiresAt(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}