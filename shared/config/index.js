'use strict';

/**
 * config/index.js
 *
 * ✅ Firebase & Firestore completely removed
 * ✅ Google Cloud dependency minimized (only Pub/Sub if still used)
 * ✅ Supabase-first architecture
 */

const REQUIRED_VARS = {
  'api-service': [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PUBSUB_RESUME_TOPIC',
    'PUBSUB_SALARY_TOPIC',
    'PUBSUB_CAREER_TOPIC',
  ],
  'resume-worker': [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PUBSUB_RESUME_SUBSCRIPTION',
  ],
  'salary-worker': [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PUBSUB_SALARY_SUBSCRIPTION',
  ],
  'career-worker': [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PUBSUB_CAREER_SUBSCRIPTION',
  ],
  'notification-worker': [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PUBSUB_NOTIFICATION_SUBSCRIPTION',
  ],
};

function loadConfig(serviceName) {
  const required = REQUIRED_VARS[serviceName] ?? [];
  const missing = required.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(
      `[Config] Missing required environment variables for ${serviceName}: ${missing.join(', ')}`
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '8080', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    serviceName,

    // ✅ Supabase Config (PRIMARY DB)
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },

    // ✅ Pub/Sub (keep ONLY if you're still using it)
    pubsub: {
      resumeTopic: process.env.PUBSUB_RESUME_TOPIC,
      salaryTopic: process.env.PUBSUB_SALARY_TOPIC,
      careerTopic: process.env.PUBSUB_CAREER_TOPIC,
      notificationTopic: process.env.PUBSUB_NOTIFICATION_TOPIC,
      scoreTopic: process.env.PUBSUB_SCORE_UPDATED_TOPIC,

      resumeSubscription: process.env.PUBSUB_RESUME_SUBSCRIPTION,
      salarySubscription: process.env.PUBSUB_SALARY_SUBSCRIPTION,
      careerSubscription: process.env.PUBSUB_CAREER_SUBSCRIPTION,
      notificationSubscription: process.env.PUBSUB_NOTIFICATION_SUBSCRIPTION,

      maxDeliveryAttempts: parseInt(process.env.PUBSUB_MAX_DELIVERY_ATTEMPTS ?? '5', 10),
      ackDeadlineSeconds: parseInt(process.env.PUBSUB_ACK_DEADLINE ?? '60', 10),
    },

    // ✅ Engine versions (unchanged)
    engines: {
      resumeVersion: process.env.RESUME_ENGINE_VERSION ?? 'resume_score_v1.0',
      salaryVersion: process.env.SALARY_ENGINE_VERSION ?? 'salary_bench_v1.0',
      careerVersion: process.env.CAREER_ENGINE_VERSION ?? 'career_path_v1.0',
    },

    // ❌ REMOVED: firestore completely

    // ✅ Security
    security: {
      internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,
      allowedAudience: process.env.ALLOWED_AUDIENCE,
    },
  };
}

module.exports = { loadConfig };