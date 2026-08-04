'use strict';

/**
 * supabaseClient.js
 * -----------------
 * Singleton Supabase backend client using service-role credentials.
 *
 * Service role bypasses RLS.
 * Backend-only usage.
 * Never expose this client to frontend code.
 *
 * path: src/lib/supabaseClient.js
 */

const { createClient } = require('@supabase/supabase-js');
// Node 20 has no native global WebSocket — required by RealtimeClient at
// construction time even when realtime isn't used. See config/supabase.js.
const WebSocket = require('ws');

let client = null;

function getSupabaseClient() {
  if (client) {
    return client;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('Missing env var: SUPABASE_URL');
  }

  if (!key) {
    throw new Error('Missing env var: SUPABASE_SERVICE_ROLE_KEY');
  }

  client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    realtime: {
      transport: WebSocket,
    },
    global: {
      headers: {
        'x-application-name': 'hirerise-core',
      },
    },
  });

  return client;
}

module.exports = getSupabaseClient();

// Also export the factory function for callers that need to call getSupabaseClient() explicitly.
// Usage: const supabase = require('../lib/supabaseClient')  → supabase.from(...)  ✅
// Usage: const { getSupabaseClient } = require('../lib/supabaseClient')           ✅
module.exports.getSupabaseClient = getSupabaseClient;