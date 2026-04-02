import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// ENV HELPER (STRICT + TYPE SAFE)
// ─────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value.trim();
}

// ─────────────────────────────────────────────
// ENV CONFIG (NO MORE undefined TYPES)
// ─────────────────────────────────────────────

// ✅ ALWAYS returns string
const SUPABASE_URL: string =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  (() => {
    throw new Error('Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
  })();

// ✅ ALWAYS returns string
const SUPABASE_KEY: string = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

// Optional timeout
const TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS || '10000');

// ─────────────────────────────────────────────
// SINGLETON CLIENT
// ─────────────────────────────────────────────

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
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

  console.log('[Supabase] Client initialized');

  return _client;
}

// ─────────────────────────────────────────────
// RETRY WRAPPER
// ─────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2
): Promise<T> {
  let lastError: any;

  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      console.warn('[Supabase Retry]', {
        attempt: i + 1,
        message: err?.message,
      });

      if (i < retries) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

export async function verifySupabaseConnection() {
  try {
    const db = getSupabaseClient();

    const { error } = await db
      .from('health_check') // ✅ must exist
      .select('id')
      .limit(1);

    if (error) throw error;

    console.log('[Supabase] Connection verified');
  } catch (err: any) {
    console.error('[Supabase] Connection failed', err.message);

    if (process.env.NODE_ENV === 'production') {
      throw err;
    }
  }
}