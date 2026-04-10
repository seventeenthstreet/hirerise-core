'use strict';

/**
 * config/env.js — PRODUCTION HARDENED ENV VALIDATOR
 * PR 2: Backend Infra Safety
 * - Enforce Redis in production
 * - Validate INTERNAL_SERVICE_TOKEN
 * - Prevent soft-fail bypass in production
 */

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
  if (port < 1 || port > 65535) {
    throw new Error(`[env] Invalid PORT: ${port}`);
  }
}

// ── Collect errors safely ─────────────────────────────────────

const errors = [];

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    errors.push(e.message);
    return '';
  }
}

// ── ENV OBJECT ───────────────────────────────────────────────

const env = {
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: optionalInt('PORT', 8080),
  APP_URL: optional('APP_URL', 'http://localhost:8080'),
  ALLOWED_ORIGINS: optional('ALLOWED_ORIGINS', 'http://localhost:3000'),

  // Supabase
  SUPABASE_URL: safe(() => required('SUPABASE_URL')),
  SUPABASE_SERVICE_ROLE_KEY: safe(() =>
    required('SUPABASE_SERVICE_ROLE_KEY')
  ),
  SUPABASE_STORAGE_BUCKET: optional('SUPABASE_STORAGE_BUCKET', 'resumes'),

  // Encryption
  MASTER_ENCRYPTION_KEY: safe(() =>
    required('MASTER_ENCRYPTION_KEY')
  ),

  // Internal service token (required for /internal/* routes)
 INTERNAL_SERVICE_TOKEN:
  optional('NODE_ENV', 'development') === 'production'
    ? safe(() => required('INTERNAL_SERVICE_TOKEN'))
    : optional('INTERNAL_SERVICE_TOKEN', 'dev-internal-token'),

  // AI
  OPENROUTER_API_KEY: optional('OPENROUTER_API_KEY'),
  ANTHROPIC_API_KEY: optional('ANTHROPIC_API_KEY'),
  GEMINI_API_KEY: optional('GEMINI_API_KEY'),
  GROQ_API_KEY: optional('GROQ_API_KEY'),
  FIREWORKS_API_KEY: optional('FIREWORKS_API_KEY'),
  MISTRAL_API_KEY: optional('MISTRAL_API_KEY'),

  // Router tuning
  AI_PROVIDER_TIMEOUT_MS: optionalInt('AI_PROVIDER_TIMEOUT_MS', 12000),
  AI_FAILURE_THRESHOLD: optionalInt('AI_FAILURE_THRESHOLD', 3),
  AI_COOLDOWN_MS: optionalInt('AI_COOLDOWN_MS', 300000),

  // Redis
  CACHE_PROVIDER: optional('CACHE_PROVIDER', 'memory'),
  REDIS_URL: optional('REDIS_URL', ''),

  // Billing
  STRIPE_SECRET_KEY: optional('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: optional('STRIPE_WEBHOOK_SECRET'),

  // App
  HIRERISE_MODE: optional('HIRERISE_MODE', 'launch'),
  ENABLE_AI_CV_FALLBACK: optionalBool('ENABLE_AI_CV_FALLBACK', true),
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

// PORT validation
try {
  validatePort(env.PORT);
} catch (e) {
  errors.push(e.message);
}

// Encryption key length
if (env.MASTER_ENCRYPTION_KEY && env.MASTER_ENCRYPTION_KEY.length !== 32) {
  errors.push(
    '[env] MASTER_ENCRYPTION_KEY must be exactly 32 characters'
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
  ].filter(v => v && v.trim());

  if (providers.length === 0) {
    errors.push('[env] No AI provider configured');
  }
}

// PR 2: FORCE Redis in production
if (env.NODE_ENV === 'production') {
  if (env.CACHE_PROVIDER !== 'redis') {
    errors.push('[env] CACHE_PROVIDER must be "redis" in production');
  }

  if (!env.REDIS_URL) {
    errors.push('[env] REDIS_URL is required in production');
  }
}

// Redis validation (non-production)
if (env.CACHE_PROVIDER === 'redis' && !env.REDIS_URL) {
  errors.push('[env] REDIS_URL required when CACHE_PROVIDER=redis');
}

// ── Fail Fast ────────────────────────────────────────────────

if (errors.length && env.NODE_ENV !== 'test') {
  const border = '═'.repeat(70);

  console.error(`\n${border}`);
  console.error('HIRERISE ENV VALIDATION FAILED');
  console.error(border);

  errors.forEach((e, i) => console.error(`[${i + 1}] ${e}`));

  console.error(border);

  // PR 2 hardening:
  // allow soft-fail only outside production
  const softFailAllowed =
    process.env.ALLOW_SOFT_FAIL === 'true' &&
    env.NODE_ENV !== 'production';

  if (softFailAllowed) {
    console.warn('[env] Soft fail enabled — continuing startup');
  } else {
    process.exit(1);
  }
}

// ── Debug Summary ─────────────────────────────────────────────

if (env.NODE_ENV !== 'test') {
  console.log('[env] Loaded config:', {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    SUPABASE: !!env.SUPABASE_URL,
    AI_PROVIDERS: {
      openrouter: !!env.OPENROUTER_API_KEY,
      anthropic: !!env.ANTHROPIC_API_KEY,
      gemini: !!env.GEMINI_API_KEY,
      groq: !!env.GROQ_API_KEY,
    },
    CACHE: env.CACHE_PROVIDER,
    REDIS: !!env.REDIS_URL,
    INTERNAL_TOKEN: !!env.INTERNAL_SERVICE_TOKEN,
  });
}

Object.freeze(env);

module.exports = env;