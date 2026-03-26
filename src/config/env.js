'use strict';

/**
 * config/env.js — Central Environment Validator (SUPABASE ONLY)
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function required(name) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(
      `[env] Missing required environment variable: ${name}\n` +
      `  Add it to your .env file (see .env.example) or inject it at deploy time.\n` +
      `  Server cannot start without this value.`
    );
  }
  return val.trim();
}

function optional(name, defaultValue = '') {
  const val = process.env[name];
  return (val && val.trim()) ? val.trim() : defaultValue;
}

function optionalInt(name, defaultValue) {
  const val = process.env[name];
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function optionalBool(name, defaultValue = false) {
  const val = process.env[name];
  if (!val) return defaultValue;
  return val.trim().toLowerCase() === 'true';
}

// ── Validation ─────────────────────────────────────────────────────────────

const errors = [];

function safeRequired(name) {
  try {
    return required(name);
  } catch (err) {
    errors.push(err.message);
    return '';
  }
}

// ── Environment object ──────────────────────────────────────────────────────

const env = {

  // ── Runtime ──────────────────────────────────────────────────────────────
  NODE_ENV:   optional('NODE_ENV', 'development'),
  PORT:       optionalInt('PORT', 8080),
  APP_URL:    optional('APP_URL', 'http://localhost:8080'),
  ALLOWED_ORIGINS: optional('ALLOWED_ORIGINS', 'http://localhost:3000'),

  // ── Supabase ─────────────────────────────────────────────────────────────
  SUPABASE_URL:              safeRequired('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: safeRequired('SUPABASE_SERVICE_ROLE_KEY'),
  SUPABASE_STORAGE_BUCKET:   optional('SUPABASE_STORAGE_BUCKET', 'resumes'),

  // ── Encryption ───────────────────────────────────────────────────────────
  MASTER_ENCRYPTION_KEY: safeRequired('MASTER_ENCRYPTION_KEY'),

  // ── AI Providers ─────────────────────────────────────────────────────────
  OPENROUTER_API_KEY:  optional('OPENROUTER_API_KEY'),
  ANTHROPIC_API_KEY:   optional('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL:     optional('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
  GEMINI_API_KEY:      optional('GEMINI_API_KEY'),
  GROQ_API_KEY:        optional('GROQ_API_KEY'),
  FIREWORKS_API_KEY:   optional('FIREWORKS_API_KEY'),
  MISTRAL_API_KEY:     optional('MISTRAL_API_KEY'),

  // ── AI router tuning ─────────────────────────────────────────────────────
  AI_PROVIDER_TIMEOUT_MS: optionalInt('AI_PROVIDER_TIMEOUT_MS', 12000),
  AI_FAILURE_THRESHOLD:   optionalInt('AI_FAILURE_THRESHOLD', 3),
  AI_COOLDOWN_MS:         optionalInt('AI_COOLDOWN_MS', 300000),

  // ── Cache / Redis ─────────────────────────────────────────────────────────
  CACHE_PROVIDER: optional('CACHE_PROVIDER', 'memory'),
  REDIS_HOST:     optional('REDIS_HOST', '127.0.0.1'),
  REDIS_PORT:     optionalInt('REDIS_PORT', 6379),
  REDIS_PASSWORD: optional('REDIS_PASSWORD'),
  REDIS_TLS:      optionalBool('REDIS_TLS', false),
  REDIS_URL:      optional('REDIS_URL', 'redis://127.0.0.1:6379'),

  // ── Billing ───────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY:      optional('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET:  optional('STRIPE_WEBHOOK_SECRET'),

  // ── App behaviour ─────────────────────────────────────────────────────────
  HIRERISE_MODE:           optional('HIRERISE_MODE', 'launch'),
  UPGRADE_URL:             optional('UPGRADE_URL', '/pricing'),
  RESUME_MAX_BYTES:        optionalInt('RESUME_MAX_BYTES', 10485760),
  ENABLE_AI_CV_FALLBACK:   optionalBool('ENABLE_AI_CV_FALLBACK', true),
  ADMIN_HARDENING_ENABLED: optionalBool('ADMIN_HARDENING_ENABLED', true),
  SECRET_ROTATION_GRACE_HOURS: optionalInt('SECRET_ROTATION_GRACE_HOURS', 2),

  // ── Feature flags ─────────────────────────────────────────────────────────
  FEATURE_SEMANTIC_MATCHING: optionalBool('FEATURE_SEMANTIC_MATCHING', false),
  FEATURE_EVENT_BUS:         optionalBool('FEATURE_EVENT_BUS', false),
  FEATURE_PERSONALIZATION:   optionalBool('FEATURE_PERSONALIZATION', false),
  RUN_ENGAGEMENT_WORKER:     optionalBool('RUN_ENGAGEMENT_WORKER', false),
};

// ── Cross-field validation ──────────────────────────────────────────────────

// MASTER_ENCRYPTION_KEY must be exactly 32 characters
if (env.MASTER_ENCRYPTION_KEY && env.MASTER_ENCRYPTION_KEY.length !== 32) {
  errors.push(
    `[env] MASTER_ENCRYPTION_KEY must be exactly 32 ASCII characters.\n` +
    `  Current length: ${env.MASTER_ENCRYPTION_KEY.length}`
  );
}

// At least one AI provider required
if (env.NODE_ENV !== 'test') {
  const aiKeys = [
    env.OPENROUTER_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.GEMINI_API_KEY,
    env.GROQ_API_KEY,
    env.FIREWORKS_API_KEY,
    env.MISTRAL_API_KEY,
  ];
  if (!aiKeys.some(Boolean)) {
    errors.push(
      '[env] No AI provider key found. Set at least ONE AI provider key.'
    );
  }
}

// ── Fail fast ──────────────────────────────────────────────────────────────

if (errors.length > 0 && env.NODE_ENV !== 'test') {
  const border = '═'.repeat(70);
  console.error(`\n${border}`);
  console.error('  HIRERISE STARTUP FAILED — Environment misconfiguration');
  console.error(border);
  errors.forEach((e, i) => console.error(`\n[${i + 1}] ${e}`));
  console.error(`\n${border}\n`);
  process.exit(1);
}

Object.freeze(env);

module.exports = env;







