'use strict';

/**
 * shared/config/index.js
 *
 * Production-ready centralized configuration loader
 * ✅ Firebase fully removed
 * ✅ Supabase-first
 * ✅ Strong env validation
 * ✅ Safer numeric parsing
 * ✅ Optional Pub/Sub transport support
 * ✅ Immutable config output
 */

const SERVICE_ENV_REQUIREMENTS = Object.freeze({
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
});

/**
 * Read required string env safely
 */
function getEnv(name, fallback = undefined) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).trim();
}

/**
 * Parse integer env with validation
 */
function getIntEnv(name, fallback) {
  const raw = getEnv(name);

  if (raw === undefined) return fallback;

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`[Config] Invalid integer for ${name}: ${raw}`);
  }

  return parsed;
}

/**
 * Validate URL env
 */
function getUrlEnv(name) {
  const value = getEnv(name);

  if (!value) {
    throw new Error(`[Config] Missing required URL env: ${name}`);
  }

  try {
    new URL(value);
    return value;
  } catch {
    throw new Error(`[Config] Invalid URL format for ${name}`);
  }
}

/**
 * Validate required service env vars
 */
function validateRequiredEnv(serviceName) {
  const required = SERVICE_ENV_REQUIREMENTS[serviceName] ?? [];

  const missing = required.filter((key) => !getEnv(key));

  if (missing.length > 0) {
    throw new Error(
      `[Config] Missing required environment variables for ${serviceName}: ${missing.join(', ')}`
    );
  }
}

/**
 * Centralized config loader
 */
function loadConfig(serviceName) {
  if (!serviceName || typeof serviceName !== 'string') {
    throw new Error('[Config] serviceName is required');
  }

  validateRequiredEnv(serviceName);

  const config = {
    nodeEnv: getEnv('NODE_ENV', 'development'),
    port: getIntEnv('PORT', 8080),
    logLevel: getEnv('LOG_LEVEL', 'info'),
    serviceName,

    /**
     * Supabase primary data platform
     */
    supabase: Object.freeze({
      url: getUrlEnv('SUPABASE_URL'),
      serviceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    }),

    /**
     * Transport layer (optional)
     * Can later be swapped with Realtime / NOTIFY
     */
    pubsub: Object.freeze({
      resumeTopic: getEnv('PUBSUB_RESUME_TOPIC'),
      salaryTopic: getEnv('PUBSUB_SALARY_TOPIC'),
      careerTopic: getEnv('PUBSUB_CAREER_TOPIC'),
      notificationTopic: getEnv('PUBSUB_NOTIFICATION_TOPIC'),
      scoreTopic: getEnv('PUBSUB_SCORE_UPDATED_TOPIC'),

      resumeSubscription: getEnv('PUBSUB_RESUME_SUBSCRIPTION'),
      salarySubscription: getEnv('PUBSUB_SALARY_SUBSCRIPTION'),
      careerSubscription: getEnv('PUBSUB_CAREER_SUBSCRIPTION'),
      notificationSubscription: getEnv('PUBSUB_NOTIFICATION_SUBSCRIPTION'),

      maxDeliveryAttempts: getIntEnv('PUBSUB_MAX_DELIVERY_ATTEMPTS', 5),
      ackDeadlineSeconds: getIntEnv('PUBSUB_ACK_DEADLINE', 60),
    }),

    /**
     * Versioned engines
     */
    engines: Object.freeze({
      resumeVersion: getEnv('RESUME_ENGINE_VERSION', 'resume_score_v1.0'),
      salaryVersion: getEnv('SALARY_ENGINE_VERSION', 'salary_bench_v1.0'),
      careerVersion: getEnv('CAREER_ENGINE_VERSION', 'career_path_v1.0'),
    }),

    /**
     * Security layer
     */
    security: Object.freeze({
      internalServiceToken: getEnv('INTERNAL_SERVICE_TOKEN'),
      allowedAudience: getEnv('ALLOWED_AUDIENCE'),
    }),
  };

  return Object.freeze(config);
}

module.exports = {
  loadConfig,
};