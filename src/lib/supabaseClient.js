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
    global: {
      headers: {
        'x-application-name': 'hirerise-core',
      },
    },
  });

  return client;
}

module.exports = {
  getSupabaseClient,
};