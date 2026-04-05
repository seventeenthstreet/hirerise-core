'use strict';

/**
 * supabase.js (FINAL - PRODUCTION SAFE)
 */

const { createClient } = require('@supabase/supabase-js');

let logger;
try {
  logger = require('../utils/logger').logger || require('../utils/logger');
} catch {
  logger = console;
}

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS || '10000');

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

if (!SUPABASE_URL || !SUPABASE_KEY) {
  logger.error('[Supabase] Missing env', {
    hasUrl: !!SUPABASE_URL,
    hasKey: !!SUPABASE_KEY,
  });

  throw new Error('Supabase configuration missing');
}

// ─────────────────────────────────────────────
// CLIENT SINGLETON
// ─────────────────────────────────────────────

let client = null;

function getClient() {
  if (client) return client;

  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      fetch: async (url, options) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          return await fetch(url, {
            ...options,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  });

  logger.info('[Supabase] Client initialized');

  return client;
}

// ─────────────────────────────────────────────
// RETRY WRAPPER
// ─────────────────────────────────────────────

async function withRetry(fn, retries = 2) {
  let lastError;

  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      logger.warn('[Supabase Retry]', {
        attempt: i + 1,
        message: err?.message,
      });

      if (i < retries) {
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
      }
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────
// HEALTH CHECK (FIXED)
// ─────────────────────────────────────────────

async function verifyConnection() {
  try {
    const db = getClient();

    const { error } = await db
      .from('health_check') // ✅ safe table
      .select('id')
      .limit(1);

    if (error) throw error;

    logger.info('[Supabase] Connection verified');

  } catch (err) {
    logger.error('[Supabase] Connection failed', {
      message: err?.message,
    });

    // Fail fast only in production
    if (process.env.NODE_ENV === 'production') {
      throw err;
    }
  }
}

// ─────────────────────────────────────────────
// FIREBASE COMPAT HELPERS
// ─────────────────────────────────────────────

const FieldValue = {
  serverTimestamp: () => new Date().toISOString(),
  increment: (n) => ({ __increment: n }),
  arrayUnion: (...items) => ({ __arrayUnion: items.flat() }),
  arrayRemove: (...items) => ({ __arrayRemove: items.flat() }),
  delete: () => ({ __deleteField: true }),
};

class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  toDate() {
    return new Date(this.seconds * 1000);
  }

  static now() {
    return Timestamp.fromDate(new Date());
  }

  static fromDate(date) {
    const d = new Date(date);
    return new Timestamp(
      Math.floor(d.getTime() / 1000),
      (d.getTime() % 1000) * 1e6
    );
  }
}

// ─────────────────────────────────────────────
// STARTUP CHECK
// ─────────────────────────────────────────────

verifyConnection();

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = {
  supabase: getClient(),
  getClient,
  withRetry,
  FieldValue,
  Timestamp,
};