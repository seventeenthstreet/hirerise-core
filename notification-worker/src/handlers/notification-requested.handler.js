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

function normalizeMergeResult(data) {
  if (data == null) return { success: false };

  if (typeof data === 'boolean') {
    return { success: data };
  }

  if (typeof data === 'number') {
    return { success: data > 0 };
  }

  const row = Array.isArray(data) ? data[0] : data;

  return {
    success: Boolean(
      row?.success ??
      row?.updated ??
      row?.merged ??
      true
    ),
    payload: row,
  };
}

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
        { onConflict: 'id' }
      );

    if (insertError) throw insertError;

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

  // atomic pre-send claim
  const { data: deliveryRow, error: claimError } =
    await supabaseAdmin
      .from('notification_delivery')
      .upsert(
        {
          id: deliveryId,
          status: 'sending',
          attempted_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .select('status')
      .maybeSingle();

  if (claimError) throw claimError;

  if (deliveryRow?.status === 'sent') {
    log.info('Push already sent — skipping');
    return;
  }

  const { data: tokenRow, error: tokenError } =
    await supabaseAdmin
      .from('user_fcm_tokens')
      .select('token')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

  if (tokenError) throw tokenError;

  const pushToken = tokenRow?.token;

  if (!pushToken) {
    await supabaseAdmin.from('notification_delivery').upsert({
      id: deliveryId,
      status: 'no_token',
      attempted_at: new Date().toISOString(),
    });

    return;
  }

  await simulatePushSend(pushToken);

  await supabaseAdmin.from('notification_delivery').upsert({
    id: deliveryId,
    status: 'sent',
    sent_at: new Date().toISOString(),
  });

  const { data, error } = await supabaseAdmin.rpc(
    'merge_notification_delivery_status',
    {
      p_notification_id: notificationId,
      p_channel: 'push',
      p_status: 'delivered',
    }
  );

  if (error) {
    log.error('merge_notification_delivery_status failed', {
      rpc: 'merge_notification_delivery_status',
      notificationId,
      code: error.code,
      details: error.details,
      error: error.message,
    });

    throw error;
  }

  const mergeResult = normalizeMergeResult(data);

  if (!mergeResult.success) {
    log.error('Invalid merge RPC result', {
      notificationId,
      mergeResult,
    });

    throw new Error(
      'merge_notification_delivery_status returned invalid result'
    );
  }

  const { error: timestampError } = await supabaseAdmin
    .from('notifications')
    .update({
      push_delivered_at: new Date().toISOString(),
    })
    .eq('id', notificationId);

  if (timestampError) {
    log.error('push_delivered_at update failed', {
      notificationId,
      error: timestampError.message,
    });

    throw timestampError;
  }

  log.info('Push delivered');
}

function simulatePushSend() {
  return new Promise(resolve => setTimeout(resolve, 10));
}

function getExpiresAt(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}