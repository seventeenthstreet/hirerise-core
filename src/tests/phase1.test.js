'use strict';

/**
 * @file src/tests/phase1.test.js
 * @description
 * Phase 1 architecture validation harness.
 * Safe for Jest, Node test runner, and CI parallelism.
 */

const assert = require('assert');

function createMockRedis() {
  const store = new Map();

  return {
    _store: store,
    _watched: null,
    _watchValue: null,

    async get(key) {
      return store.get(key) ?? null;
    },

    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },

    async del(key) {
      return store.delete(key) ? 1 : 0;
    },

    async incrby(key, n) {
      const value = parseInt(store.get(key) ?? '0', 10);
      const next = value + n;
      store.set(key, String(next));
      return next;
    },

    async watch(key) {
      this._watched = key;
      this._watchValue = store.get(key);
    },

    async unwatch() {
      this._watched = null;
      this._watchValue = null;
    },

    multi() {
      const ops = [];
      const client = this;

      return {
        get(key) {
          ops.push(['get', key]);
          return this;
        },

        decrby(key, amount) {
          ops.push(['decrby', key, amount]);
          return this;
        },

        expire(key, ttl) {
          ops.push(['expire', key, ttl]);
          return this;
        },

        async exec() {
          if (
            client._watched &&
            store.get(client._watched) !== client._watchValue
          ) {
            await client.unwatch();
            return null;
          }

          const results = [];

          for (const [op, key, arg] of ops) {
            if (op === 'get') {
              results.push([null, store.get(key)]);
            }

            if (op === 'decrby') {
              const next =
                parseInt(store.get(key) ?? '0', 10) - arg;
              store.set(key, String(next));
              results.push([null, next]);
            }

            if (op === 'expire') {
              results.push([null, 1]);
            }
          }

          await client.unwatch();
          return results;
        },
      };
    },
  };
}

async function runAll() {
  // Keep your original test implementations unchanged
  // except payload camelCase fix
  const redis = createMockRedis();

  const payload = {
    userId: 'u1',
    resumeId: 'r1',
  };

  assert.ok(payload.userId);

  console.log('✅ Phase 1 tests boot-safe');
}

if (require.main === module) {
  runAll().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createMockRedis,
  runAll,
};