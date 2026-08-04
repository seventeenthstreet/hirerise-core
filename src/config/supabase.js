'use strict';

/**
 * src/config/supabase.js
 *
 * FINAL — Production-safe Supabase singleton
 * Patch 33 compliant:
 * - global fetch timeout protection
 * - latency telemetry
 * - slow request warnings
 * - timeout anomaly detection
 */

const { createClient } = require('@supabase/supabase-js');

// Node 20 has no native global WebSocket (stable only from Node 22+).
// @supabase/supabase-js's RealtimeClient requires one at construction time
// regardless of whether realtime features are used, and throws synchronously
// if none is found — crashing the whole process on boot. This repo's
// engines field pins Node to >=20 <21, so we always need to supply one
// explicitly via the `ws` package rather than relying on a native global.
const WebSocket = require('ws');

let logger;
try {
  logger =
    require('../utils/logger').logger ||
    require('../utils/logger');
} catch {
  logger = console;
}

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = parseInt(
  process.env.SUPABASE_TIMEOUT_MS || '10000',
  10
);

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

if (!SUPABASE_URL || !SUPABASE_KEY) {
  logger.error('[Supabase] Missing env', {
    hasUrl: Boolean(SUPABASE_URL),
    hasKey: Boolean(SUPABASE_KEY),
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
    realtime: {
      transport: WebSocket,
    },
    global: {
      fetch: async (url, options = {}) => {
        const controller = new AbortController();

        const timeout = setTimeout(() => {
          logger.error(
            '[Telemetry] Supabase request timeout',
            {
              url: String(url),
              timeout_ms: TIMEOUT_MS,
            }
          );

          controller.abort();
        }, TIMEOUT_MS);

        const startedAt = process.hrtime.bigint();

        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          const durationMs =
            Number(
              process.hrtime.bigint() - startedAt
            ) / 1e6;

          logger.info(
            '[Telemetry] Supabase fetch completed',
            {
              url: String(url),
              status: response.status,
              duration_ms: Number(
                durationMs.toFixed(2)
              ),
            }
          );

          if (durationMs > 1500) {
            logger.warn(
              '[Telemetry] Slow Supabase request',
              {
                url: String(url),
                status: response.status,
                duration_ms: Number(
                  durationMs.toFixed(2)
                ),
              }
            );
          }

          return response;
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
        await new Promise((resolve) =>
          setTimeout(resolve, 200 * (i + 1))
        );
      }
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

async function verifyConnection() {
  try {
    const db = getClient();

    const { error } = await db
      .from('health_check')
      .select('id')
      .limit(1);

    if (error) throw error;

    logger.info('[Supabase] Connection verified');
    return true;
  } catch (err) {
    logger.error('[Supabase] Connection failed', {
      message: err?.message,
    });

    if (process.env.NODE_ENV === 'production') {
      throw err;
    }

    return false;
  }
}

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = {
  supabase: getClient(),
  getClient,
  withRetry,
  verifyConnection,
};