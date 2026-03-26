'use strict';

/**
 * src/config/supabase.js — Canonical Supabase client singleton
 *
 * Single source of truth for all server-side Supabase access.
 * Replaces:
 *   - src/config/supabase.js      (the migration stub)
 *   - src/core/supabaseClient.js  (the root-level one-off)
 *   - src/core/supabase.js        (the Firestore-compat shim)
 *
 * Usage (raw Supabase):
 *   const supabase = require('../config/supabase');
 *   const { data, error } = await supabase.from('users').select('*').eq('id', userId);
 *
 * Usage (Firestore-compat, for legacy modules):
 *   const { db, FieldValue, Timestamp } = require('../config/supabase');
 *   await db.collection('users').doc(id).get();
 *
 * Environment variables required:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (server-side only, never expose to client)
 */

const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client singleton
// ─────────────────────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[Supabase] Missing environment variables. ' +
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the server.'
    );
  }

  _client = createClient(url, key, {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
  });

  return _client;
}

/**
 * The default export is a Proxy so callers can write:
 *
 *   const supabase = require('../config/supabase');
 *   supabase.from('users').select(...)
 *
 * rather than:
 *
 *   const { getClient } = require('../config/supabase');
 *   getClient().from('users').select(...)
 */
const supabaseProxy = new Proxy({}, {
  get(_, prop) {
    // Allow named exports to be accessed directly without going through the client
    if (prop === 'FieldValue') return FieldValue;
    if (prop === 'Timestamp')  return Timestamp;
    if (prop === 'db')         return require('../core/supabaseDbShim.js').db;

    const client = getClient();
    const val    = client[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// FieldValue stubs  (also available from supabaseDbShim — kept here for
// modules that import directly from config/supabase)
// ─────────────────────────────────────────────────────────────────────────────

const FieldValue = {
  /** ISO timestamp string, tagged so the shim can detect it */
  serverTimestamp() {
    return new Date().toISOString();
  },

  /** Increment sentinel — handled by supabaseDbShim.resolveFieldValues */
  increment(n) {
    return { __increment: n };
  },

  /** Array union — returns items as array */
  arrayUnion(...items) {
    return { __arrayUnion: items.flat() };
  },

  /** Array remove sentinel */
  arrayRemove(...items) {
    return { __arrayRemove: items.flat() };
  },

  /** Delete field sentinel */
  delete() {
    return { __deleteField: true };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp stubs
// ─────────────────────────────────────────────────────────────────────────────

class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds     = seconds;
    this.nanoseconds = nanoseconds;
  }

  toDate() {
    return new Date(this.seconds * 1000);
  }

  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }

  toISOString() {
    return this.toDate().toISOString();
  }

  static now() {
    return Timestamp.fromDate(new Date());
  }

  static fromDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return new Timestamp(Math.floor(d.getTime() / 1000), (d.getTime() % 1000) * 1e6);
  }

  static fromMillis(ms) {
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

// Named exports for destructuring:
//   const { FieldValue, Timestamp, db } = require('../config/supabase');
supabaseProxy.FieldValue = FieldValue;
supabaseProxy.Timestamp  = Timestamp;

module.exports = supabaseProxy;

// Allow explicit re-import for callers that need the raw class
module.exports.FieldValue = FieldValue;
module.exports.Timestamp  = Timestamp;
module.exports.getClient  = getClient;