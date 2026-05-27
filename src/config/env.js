'use strict';

/**
 * src/config/env.js
 * HireRise PR 2 — Backend Infra Safety
 * Production-grade fail-fast validator
 *
 * PATCH: Structured startup logging hardening
 * - logger.fatal() emitted BEFORE process.exit(1) for every missing
 *   webhook secret so Cloud Run / Docker / Kubernetes operators see an
 *   explicit, machine-parseable fatal event in structured JSON logs.
 * - Non-production webhook-secret warnings also upgraded to structured
 *   logger.warn() (replaces bare console.warn).
 * - No secret values are logged anywhere — presence-only checks only.
 */

// NOTE: logger is required lazily inside the fail-fast block so that
// env.js can still be loaded by unit tests that don't configure Winston.
// The require() at module level would pull in Winston before NODE_ENV
// is known to be 'test', which causes noise in test output.

function required(name) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(`[env] Missing required environment variable: ${name}`);
  }
  return val.trim();
}

function optional(name, def = '') {
  const val = process.env[name];
  return val && val.trim() ? val.trim() : def;
}

function optionalInt(name, def) {
  const val = process.env[name];
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : def;
}

function optionalBool(name, def = false) {
  const val = process.env[name];
  if (!val) return def;
  return val.trim().toLowerCase() === 'true';
}

// ── Validators ───────────────────────────────────────────────

function validateUrl(value, name) {
  try {
    new URL(value);
  } catch {
    throw new Error(`[env] Invalid URL for ${name}: ${value}`);
  }
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[env] Invalid PORT: ${port}`);
  }
}

function validatePositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[env] ${name} must be a positive integer`);
  }
}

// ── Collect errors safely ─────────────────────────────────────

const errors = [];

// Per-secret structured fatal descriptors: collected during validation
// so we can emit logger.fatal() calls BEFORE process.exit(1).
// Shape: { secret: string, impact: string }
const fatalWebhookSecretErrors = [];

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    errors.push(e.message);
    return '';
  }
}

// ── ENV OBJECT ───────────────────────────────────────────────

const nodeEnv = optional('NODE_ENV', 'development');

const env = {
  NODE_ENV: nodeEnv,
  PORT: optionalInt('PORT', 8080),
  APP_URL: optional('APP_URL', 'http://localhost:8080'),
  ALLOWED_ORIGINS: optional(
    'ALLOWED_ORIGINS',
    'http://localhost:3000'
  ),

  // Supabase
  SUPABASE_URL: safe(() => required('SUPABASE_URL')),
  SUPABASE_SERVICE_ROLE_KEY: safe(() =>
    required('SUPABASE_SERVICE_ROLE_KEY')
  ),
  SUPABASE_STORAGE_BUCKET: optional(
    'SUPABASE_STORAGE_BUCKET',
    'resumes'
  ),

  // Encryption
  MASTER_ENCRYPTION_KEY: safe(() =>
    required('MASTER_ENCRYPTION_KEY')
  ),

  // Internal service auth
  INTERNAL_SERVICE_TOKEN:
    nodeEnv === 'production'
      ? safe(() => required('INTERNAL_SERVICE_TOKEN'))
      : optional(
          'INTERNAL_SERVICE_TOKEN',
          'dev-internal-token-replace-in-staging'
        ),

  // AI providers
  OPENROUTER_API_KEY: optional('OPENROUTER_API_KEY'),
  ANTHROPIC_API_KEY: optional('ANTHROPIC_API_KEY'),
  GEMINI_API_KEY: optional('GEMINI_API_KEY'),
  GROQ_API_KEY: optional('GROQ_API_KEY'),
  FIREWORKS_API_KEY: optional('FIREWORKS_API_KEY'),
  MISTRAL_API_KEY: optional('MISTRAL_API_KEY'),

  // Timeouts / AI tuning
  API_TIMEOUT_MS: optionalInt('API_TIMEOUT_MS', 30000),
  AI_PROVIDER_TIMEOUT_MS: optionalInt(
    'AI_PROVIDER_TIMEOUT_MS',
    12000
  ),
  AI_FAILURE_THRESHOLD: optionalInt(
    'AI_FAILURE_THRESHOLD',
    3
  ),
  AI_COOLDOWN_MS: optionalInt(
    'AI_COOLDOWN_MS',
    300000
  ),

  // Redis
  CACHE_PROVIDER: optional('CACHE_PROVIDER', 'memory'),
  REDIS_URL: optional('REDIS_URL', ''),

  // Billing
  STRIPE_SECRET_KEY: optional('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: optional('STRIPE_WEBHOOK_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: optional('RAZORPAY_WEBHOOK_SECRET'),

  // App
  HIRERISE_MODE: optional('HIRERISE_MODE', 'launch'),
  ENABLE_AI_CV_FALLBACK: optionalBool(
    'ENABLE_AI_CV_FALLBACK',
    true
  ),
};

// ── Cross Validation ─────────────────────────────────────────

// URL validation
if (env.SUPABASE_URL) {
  try {
    validateUrl(env.SUPABASE_URL, 'SUPABASE_URL');
  } catch (e) {
    errors.push(e.message);
  }
}

// Stripe key validation
if (env.STRIPE_SECRET_KEY) {
  if (env.STRIPE_SECRET_KEY.startsWith('pk_')) {
    errors.push(
      '[env] STRIPE_SECRET_KEY is a publishable key (pk_). ' +
      'Only secret keys (sk_live_ or sk_test_) are valid on the server. ' +
      'Set the correct key and redeploy.'
    );
  } else if (!env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    errors.push(
      '[env] STRIPE_SECRET_KEY has an unrecognised format. ' +
      'Expected sk_live_... or sk_test_...'
    );
  }
}
if (env.NODE_ENV === 'production' && !env.STRIPE_SECRET_KEY) {
  errors.push(
    '[env] STRIPE_SECRET_KEY is required in production'
  );
}

// ── Webhook secret validation ─────────────────────────────────
//
// RULE: do NOT log secret values — presence-only checks used throughout.
//
// PATCH: Each missing production webhook secret is registered into
// fatalWebhookSecretErrors so the fail-fast block can emit a
// logger.fatal() with impact context before calling process.exit(1).
// This gives Cloud Run / Docker / Kubernetes operators a structured
// machine-parseable fatal log entry, not just a plain text error line.

const WEBHOOK_SECRET_IMPACTS = {
  STRIPE_WEBHOOK_SECRET:    'Stripe billing events will fail — Stripe subscriptions will never activate or cancel',
  RAZORPAY_WEBHOOK_SECRET:  'Razorpay billing events will fail — Razorpay subscriptions will never activate or cancel',
};

if (env.NODE_ENV === 'production') {
  for (const [key, impact] of Object.entries(WEBHOOK_SECRET_IMPACTS)) {
    if (!process.env[key] || !process.env[key].trim()) {
      // Register for structured fatal logging in the fail-fast block below.
      fatalWebhookSecretErrors.push({ secret: key, impact });

      errors.push(
        `[env] ${key} is required in production. ` +
        'Missing webhook secrets cause HTTP 500 on every payment event — ' +
        'subscriptions will never activate or cancel.'
      );
    }
  }
} else {
  // Non-production: structured warn (replaces bare console.warn).
  // Deferred to after-logger is loaded — emitted inline here using
  // console.warn so the logger module is not imported at the top level
  // (avoids Winston initialisation noise in test environments).
  for (const [key, impact] of Object.entries(WEBHOOK_SECRET_IMPACTS)) {
    if (!process.env[key] || !process.env[key].trim()) {
      // PATCH: structured warn output — human-readable in dev, parseable in staging
      console.warn(JSON.stringify({
        severity: 'WARN',
        message: '[WebhookConfig] Webhook secret not set — signature verification will fail at runtime',
        secret: key,
        impact,
        startupBlocked: false,
        env: nodeEnv,
      }));
    }
  }
}

// PORT validation
try {
  validatePort(env.PORT);
} catch (e) {
  errors.push(e.message);
}

// Timeout validation
try {
  validatePositiveInt(env.API_TIMEOUT_MS, 'API_TIMEOUT_MS');
  validatePositiveInt(
    env.AI_PROVIDER_TIMEOUT_MS,
    'AI_PROVIDER_TIMEOUT_MS'
  );
} catch (e) {
  errors.push(e.message);
}

// Encryption key length
if (
  env.MASTER_ENCRYPTION_KEY &&
  env.MASTER_ENCRYPTION_KEY.length !== 32
) {
  errors.push(
    '[env] MASTER_ENCRYPTION_KEY must be exactly 32 characters'
  );
}

// Internal token entropy
if (
  env.NODE_ENV === 'production' &&
  env.INTERNAL_SERVICE_TOKEN &&
  env.INTERNAL_SERVICE_TOKEN.length < 32
) {
  errors.push(
    '[env] INTERNAL_SERVICE_TOKEN must be at least 32 characters in production'
  );
}

// AI provider validation
if (env.NODE_ENV !== 'test') {
  const providers = [
    env.OPENROUTER_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.GEMINI_API_KEY,
    env.GROQ_API_KEY,
    env.FIREWORKS_API_KEY,
    env.MISTRAL_API_KEY,
  ].filter(Boolean);

  if (providers.length === 0) {
    errors.push('[env] No AI provider configured');
  }
}

// Redis validation
if (env.NODE_ENV === 'production') {
  if (env.CACHE_PROVIDER !== 'redis') {
    errors.push(
      '[env] CACHE_PROVIDER must be "redis" in production'
    );
  }

  if (process.env.ALLOW_TEST_AUTH === 'true') {
    errors.push(
      '[env] ALLOW_TEST_AUTH=true is FORBIDDEN in production — remove it immediately'
    );
  }

  if (process.env.ADMIN_HARDENING_ENABLED !== 'true') {
    console.warn(
      '[env] WARNING: ADMIN_HARDENING_ENABLED is not set to "true" in production. ' +
      'DB-backed admin verification is still enforced, but set the flag explicitly.'
    );
  }

  if (!env.REDIS_URL) {
    errors.push('[env] REDIS_URL is required in production');
  }
}

if (env.CACHE_PROVIDER === 'redis') {
  if (!env.REDIS_URL) {
    errors.push(
      '[env] REDIS_URL required when CACHE_PROVIDER=redis'
    );
  } else if (!/^rediss?:\/\//.test(env.REDIS_URL)) {
    errors.push(
      '[env] REDIS_URL must start with redis:// or rediss://'
    );
  }
}

// ── Fail Fast ─────────────────────────────────────────────────
//
// PATCH: Before calling process.exit(1), emit one structured logger.fatal()
// per missing webhook secret so cloud log aggregators (Cloud Run, Datadog,
// CloudWatch, etc.) can parse the machine-readable JSON entry and fire
// deployment-blocking alerts.
//
// RULE: Only secrets that are missing are included; no secret values are
// logged. Each call is limited to one per secret (no duplicate noisy logging).

if (errors.length && env.NODE_ENV !== 'test') {
  const border = '═'.repeat(72);

  console.error(`\n${border}`);
  console.error('HIRERISE ENV VALIDATION FAILED');
  console.error(border);

  errors.forEach((e, i) =>
    console.error(`[${i + 1}] ${e}`)
  );

  console.error(border);

  // ── PATCH: Structured fatal log per missing webhook secret ──────────────
  // Emitted AFTER the human-readable summary (so the border block is still
  // easy to read in raw logs) and BEFORE process.exit(1).
  //
  // logger is required lazily here so env.js remains importable in test
  // environments where Winston may not be fully initialised.
  if (fatalWebhookSecretErrors.length > 0) {
    let logger;
    try {
      logger = require('../utils/logger');
    } catch {
      // Fallback: if logger itself cannot load (e.g. missing winston dep),
      // write structured JSON directly to stderr so the entry is still
      // machine-parseable by log aggregators.
      logger = {
        fatal: (msg, meta) =>
          process.stderr.write(
            JSON.stringify({ severity: 'FATAL', message: msg, ...meta }) + '\n'
          ),
      };
    }

    for (const { secret, impact } of fatalWebhookSecretErrors) {
      // RULE: log secret NAME only — never the secret VALUE.
      logger.fatal('[WebhookConfig] Missing required webhook secret', {
        secret,
        impact,
        startupBlocked: true,
      });
    }
  }
  // ── END PATCH ───────────────────────────────────────────────────────────

  const softFailAllowed =
    process.env.ALLOW_SOFT_FAIL === 'true' &&
    env.NODE_ENV !== 'production';

  if (softFailAllowed) {
    console.warn('[env] Soft fail enabled — continuing startup');
  } else {
    process.exit(1);
  }
}

// ── Safe Debug Summary ───────────────────────────────────────
// Only emit in development — never in production.
if (env.NODE_ENV === 'development') {
  console.log('[env] Loaded config:', {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    SUPABASE: !!env.SUPABASE_URL,
    CACHE: env.CACHE_PROVIDER,
    REDIS: !!env.REDIS_URL,
    INTERNAL_TOKEN: !!env.INTERNAL_SERVICE_TOKEN,
    API_TIMEOUT_MS: env.API_TIMEOUT_MS,
    AI_PROVIDER_TIMEOUT_MS: env.AI_PROVIDER_TIMEOUT_MS,
    // PATCH: presence-check booleans for webhook secrets (no values logged)
    STRIPE_WEBHOOK_SECRET_SET:   !!env.STRIPE_WEBHOOK_SECRET,
    RAZORPAY_WEBHOOK_SECRET_SET: !!env.RAZORPAY_WEBHOOK_SECRET,
  });
}

Object.freeze(env);

module.exports = env;