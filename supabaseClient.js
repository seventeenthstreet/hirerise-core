'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const logger = require('./src/utils/logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('[SupabaseClient] Missing environment variables');
}

const REQUEST_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS || '8000', 10);
const MAX_RETRIES = parseInt(process.env.SUPABASE_MAX_RETRIES || '2', 10);

// ✅ CLIENT
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: {
    fetch: (url, options) => {
      return Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SUPABASE_TIMEOUT')), REQUEST_TIMEOUT_MS)
        ),
      ]);
    },
  },
});

// ─────────────────────────────────────────────
// Safe Query
// ─────────────────────────────────────────────

async function safeQuery(fn, label = 'query') {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const start = Date.now();

      const result = await fn();

      if (result.error) {
        throw new Error(result.error.message);
      }

      logger.debug('[Supabase] Query success', {
        label,
        latencyMs: Date.now() - start,
      });

      return result;

    } catch (err) {
      attempt++;

      logger.warn('[Supabase] Query failed', {
        label,
        attempt,
        error: err.message,
      });

      if (attempt > MAX_RETRIES) {
        logger.error('[Supabase] Query exhausted retries', {
          label,
          error: err.message,
        });
        throw err;
      }

      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
}

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────

async function ping() {
  try {
    const { error } = await supabase
      .from('resumes')
      .select('id')
      .limit(1);

    return { ok: !error, error: error?.message || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ✅ 🔥 ATTACH HELPERS TO CLIENT
supabase.safeQuery = safeQuery;
supabase.ping = ping;

// ✅ EXPORT CLIENT DIRECTLY
module.exports = supabase;