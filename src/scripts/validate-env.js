#!/usr/bin/env node
'use strict';

/**
 * validate-env.js — HireRise Startup Environment Validator
 *
 * Run BEFORE starting the server. Will process.exit(1) on any missing
 * critical variable, printing a clear human-readable and machine-parseable
 * error list.
 *
 * Usage:
 *   node scripts/validate-env.js
 *   // or embed in server.js:
 *   require('./scripts/validate-env')();
 */

const REQUIRED = {
  // Core
  SUPABASE_URL: 'Supabase project URL',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service-role JWT — ROTATE IMMEDIATELY if exposed',
  MASTER_ENCRYPTION_KEY: '32-byte hex key for field encryption (openssl rand -hex 32)',
  INTERNAL_SERVICE_TOKEN: 'Shared token for service-to-service calls',
  ALLOWED_ORIGINS: 'Comma-separated list of allowed CORS origins',

  // AI (at least one must be set — checked separately below)
  // ANTHROPIC_API_KEY or GEMINI_API_KEY or OPENAI_API_KEY

  // Stripe (required for billing)
  STRIPE_SECRET_KEY: 'Stripe secret key',
  STRIPE_WEBHOOK_SECRET: 'Stripe webhook signing secret',
};

const REQUIRED_IN_PRODUCTION = {
  SLACK_ALERT_WEBHOOK_URL: 'Slack webhook for alerts',
  REDIS_URL: 'Redis connection URL',
};

const AI_KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROK_API_KEY', 'MISTRAL_API_KEY'];

const URL_VARS = ['SUPABASE_URL', 'ALLOWED_ORIGINS'];

function validateEnv() {
  const errors = [];
  const warnings = [];
  const isProduction = process.env.NODE_ENV === 'production';

  // Check required vars
  for (const [name, description] of Object.entries(REQUIRED)) {
    const val = process.env[name];
    if (!val || !val.trim()) {
      errors.push({ name, description, reason: 'missing' });
    }
  }

  // Check production-only required vars
  if (isProduction) {
    for (const [name, description] of Object.entries(REQUIRED_IN_PRODUCTION)) {
      const val = process.env[name];
      if (!val || !val.trim()) {
        errors.push({ name, description, reason: 'missing (required in production)' });
      }
    }
  }

  // At least one AI provider must be configured
  const hasAiKey = AI_KEYS.some((k) => !!process.env[k]?.trim());
  if (!hasAiKey) {
    errors.push({
      name: 'AI_PROVIDERS',
      description: `At least one of: ${AI_KEYS.join(', ')}`,
      reason: 'no AI provider configured',
    });
  }

  // Validate URL format
  for (const name of URL_VARS) {
    const val = process.env[name];
    if (val && name === 'SUPABASE_URL') {
      try { new URL(val); } catch {
        errors.push({ name, description: 'Must be a valid URL', reason: 'invalid URL format' });
      }
    }
  }

  // Warn about known-dangerous defaults
  if (isProduction) {
    if (process.env.MASTER_ENCRYPTION_KEY === '0000000000000000000000000000000000000000000000000000000000000000') {
      errors.push({ name: 'MASTER_ENCRYPTION_KEY', description: 'Key is the test default — generate a real key', reason: 'test key in production' });
    }

    if ((process.env.SUPABASE_SERVICE_ROLE_KEY || '').includes('test')) {
      warnings.push('SUPABASE_SERVICE_ROLE_KEY appears to be a test value in production');
    }

    if (!process.env.STRIPE_PRICE_ID || process.env.STRIPE_PRICE_ID === 'price_XXXXXXXXXXXXXXXXXXXXXXXX') {
      warnings.push('STRIPE_PRICE_ID appears to be placeholder — billing will fail');
    }

    // Check for Razorpay live key (warn if missing in prod)
    if (!process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET) {
      warnings.push('Razorpay keys not set — India payment flows will be disabled');
    }
  }

  // Report
  if (errors.length > 0) {
    console.error('\n╔══════════════════════════════════════════════════════════╗');
    console.error('║  HireRise startup failed — environment validation errors  ║');
    console.error('╚══════════════════════════════════════════════════════════╝\n');
    errors.forEach(({ name, description, reason }) => {
      console.error(`  ✗ ${name}`);
      console.error(`    → ${description}`);
      console.error(`    → Reason: ${reason}\n`);
    });
    // Structured fatal log for log aggregators
    process.stderr.write(JSON.stringify({
      level: 'fatal',
      event: 'env_validation_failed',
      errors: errors.map((e) => e.name),
      timestamp: new Date().toISOString(),
    }) + '\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  HireRise environment warnings:');
    warnings.forEach((w) => console.warn(`  ! ${w}`));
    console.warn('');
  }

  console.log(`✅ Environment validation passed (${Object.keys(REQUIRED).length} required vars, ${AI_KEYS.filter(k => !!process.env[k]).length} AI providers)\n`);
}

module.exports = validateEnv;

// Run directly: node validate-env.js
if (require.main === module) validateEnv();
