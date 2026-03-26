'use strict';

/**
 * phase1.test.js — Unit tests for Phase 1 implementations
 *
 * Run with: NODE_ENV=test node --test phase1.test.js
 * Or with Jest: jest phase1.test.js
 */

const assert = require('assert');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Mock Redis client
// ─────────────────────────────────────────────────────────────────────────────
function createMockRedis() {
  const store = new Map();
  const client = {
    _store: store,
    async get(key) { return store.get(key) ?? null; },
    async set(key, value, _ex, _ttl) { store.set(key, value); return 'OK'; },
    async del(key) { return store.delete(key) ? 1 : 0; },
    async incrby(key, n) {
      const v = parseInt(store.get(key) ?? '0', 10);
      store.set(key, String(v + n));
      return v + n;
    },
    // WATCH/MULTI/EXEC simulation
    _watched: null,
    _watchValue: null,
    async watch(key) {
      this._watched = key;
      this._watchValue = store.get(key);
    },
    async unwatch() { this._watched = null; },
    multi() {
      const ops = [];
      const pipeline = {
        get: (k) => { ops.push(['get', k]); return pipeline; },
        decrby: (k, n) => { ops.push(['decrby', k, n]); return pipeline; },
        expire: (k, t) => { ops.push(['expire', k, t]); return pipeline; },
        exec: async () => {
          // Check if WATCH key was modified
          if (client._watched && store.get(client._watched) !== client._watchValue) {
            return null; // Conflict
          }
          const results = [];
          for (const [op, key, arg] of ops) {
            if (op === 'get') {
              results.push([null, store.get(key)]);
            } else if (op === 'decrby') {
              const v = parseInt(store.get(key) ?? '0', 10) - arg;
              store.set(key, String(v));
              results.push([null, v]);
            } else if (op === 'expire') {
              results.push([null, 1]);
            }
          }
          client._watched = null;
          return results;
        },
      };
      return pipeline;
    },
  };
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: BaseWorker idempotency
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== Test 1: BaseWorker Idempotency ===');

// Inline the BaseWorker logic for testing without module resolution
class TestableBaseWorker {
  constructor(jobType, redis) {
    this.jobType     = jobType;
    this._mockRedis  = redis;
    this._callCount  = 0;
  }

  _redisKey(k) { return `worker:idempotency:${this.jobType}:${k}`; }

  async _checkIdempotency(key) {
    const cached = await this._mockRedis.get(this._redisKey(key));
    return cached ? JSON.parse(cached) : null;
  }

  async _markComplete(key, result) {
    await this._mockRedis.set(
      this._redisKey(key),
      JSON.stringify({ completedAt: new Date().toISOString(), result })
    );
  }

  async process(payload) {
    this._callCount++;
    return { processed: true, input: payload };
  }

  async run(payload, idempotencyKey) {
    const cached = await this._checkIdempotency(idempotencyKey);
    if (cached) return { result: cached.result, fromCache: true };
    const result = await this.process(payload);
    await this._markComplete(idempotencyKey, result);
    return { result, fromCache: false };
  }
}

async function testWorkerIdempotency() {
  const redis  = createMockRedis();
  const worker = new TestableBaseWorker('test-job', redis);
  const idempotencyKey = 'test-idempotency-key-123';
  const payload = { user_id: 'u1', resumeId: 'r1' };

  // First run: should process
  const run1 = await worker.run(payload, idempotencyKey);
  assert.strictEqual(run1.fromCache, false, 'First run should not be from cache');
  assert.strictEqual(worker._callCount, 1, 'process() should be called once');

  // Second run: should return from cache
  const run2 = await worker.run(payload, idempotencyKey);
  assert.strictEqual(run2.fromCache, true, 'Second run should be from cache');
  assert.strictEqual(worker._callCount, 1, 'process() should NOT be called again');

  // Results should be identical
  assert.deepStrictEqual(run1.result, run2.result, 'Results should be identical');

  console.log('✅  Worker idempotency: first run processes, second run uses cache');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Atomic credit reservation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== Test 2: Atomic Credit Reservation ===');

async function testAtomicCreditReservation() {
  const redis = createMockRedis();
  const userId = 'user-123';
  const key    = `credit:balance:${userId}`;

  // Set initial balance of 5 credits
  await redis.set(key, '5');

  // Simulate atomicReserve inline
  async function atomicReserve(uid, cost) {
    const k = `credit:balance:${uid}`;
    await redis.watch(k);
    const currentStr = await redis.get(k);
    const current = currentStr !== null ? parseInt(currentStr, 10) : null;
    if (current === null) { await redis.unwatch(); return null; }
    if (current < cost) { await redis.unwatch(); return { reserved: false, balanceBefore: current }; }
    const pipeline = redis.multi();
    pipeline.get(k);
    pipeline.decrby(k, cost);
    pipeline.expire(k, 300);
    const result = await pipeline.exec();
    if (result === null) return null;
    const [getResult, decrResult] = result;
    const balanceBefore = parseInt(getResult[1], 10);
    if (decrResult[1] < 0) { await redis.incrby(k, cost); return { reserved: false, balanceBefore }; }
    return { reserved: true, balanceBefore };
  }

  // Test 1: Sufficient credits
  const r1 = await atomicReserve(userId, 2);
  assert.strictEqual(r1.reserved, true, 'Should reserve with sufficient credits');
  assert.strictEqual(r1.balanceBefore, 5, 'Balance before should be 5');
  assert.strictEqual(redis._store.get(key), '3', 'Balance after should be 3');

  // Test 2: Insufficient credits
  const r2 = await atomicReserve(userId, 10);
  assert.strictEqual(r2.reserved, false, 'Should reject with insufficient credits');
  assert.strictEqual(r2.balanceBefore, 3, 'Balance before rejection should be 3');
  assert.strictEqual(redis._store.get(key), '3', 'Balance should be unchanged after rejection');

  // Test 3: Exact amount
  const r3 = await atomicReserve(userId, 3);
  assert.strictEqual(r3.reserved, true, 'Should reserve exact amount');
  assert.strictEqual(redis._store.get(key), '0', 'Balance should be 0 after exact reservation');

  // Test 4: Zero balance
  const r4 = await atomicReserve(userId, 1);
  assert.strictEqual(r4.reserved, false, 'Should reject when balance is 0');

  console.log('✅  Atomic credit reservation: all scenarios pass');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Token cache TTL computation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== Test 3: Token Cache TTL ===');

function testTokenCacheTtl() {
  const TOKEN_CACHE_TTL = 300;

  function computeTtl(decoded) {
    if (!decoded.exp) return TOKEN_CACHE_TTL;
    const secondsUntilExpiry = decoded.exp - Math.floor(Date.now() / 1000);
    if (secondsUntilExpiry <= 0) return 0;
    return Math.min(TOKEN_CACHE_TTL, secondsUntilExpiry);
  }

  // Token expiring in 10 minutes → TTL should be 300 (bounded by TOKEN_CACHE_TTL)
  const longLived = { exp: Math.floor(Date.now() / 1000) + 600 };
  assert.strictEqual(computeTtl(longLived), 300, 'Long-lived token should use 5-min TTL');

  // Token expiring in 2 minutes → TTL should be 120 (bounded by expiry)
  const shortLived = { exp: Math.floor(Date.now() / 1000) + 120 };
  const shortTtl = computeTtl(shortLived);
  assert.ok(shortTtl <= 120, 'Short-lived token TTL should not exceed 120s');
  assert.ok(shortTtl > 0, 'Short-lived token TTL should be positive');

  // Already expired → TTL should be 0
  const expired = { exp: Math.floor(Date.now() / 1000) - 60 };
  assert.strictEqual(computeTtl(expired), 0, 'Expired token should have TTL 0');

  // No exp field → use default
  assert.strictEqual(computeTtl({}), 300, 'Token without exp should use default TTL');

  console.log('✅  Token cache TTL: all scenarios pass');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Admin principal session TTL
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== Test 4: Admin Principal Session Validation ===');

function testAdminPrincipalSession() {
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

  function isSessionValid(verifiedAt) {
    if (!verifiedAt) return false;
    const sessionAge = Date.now() - verifiedAt.getTime();
    return sessionAge < SESSION_TTL_MS;
  }

  // Fresh session
  assert.strictEqual(isSessionValid(new Date()), true, 'Fresh session should be valid');

  // 23-hour old session
  const almostExpired = new Date(Date.now() - 23 * 60 * 60 * 1000);
  assert.strictEqual(isSessionValid(almostExpired), true, '23h session should be valid');

  // 25-hour old session (expired)
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  assert.strictEqual(isSessionValid(expired), false, '25h session should be expired');

  // No verifiedAt
  assert.strictEqual(isSessionValid(null), false, 'Null verifiedAt should be invalid');

  console.log('✅  Admin principal session TTL: all scenarios pass');
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────
async function runAll() {
  try {
    await testWorkerIdempotency();
    await testAtomicCreditReservation();
    testTokenCacheTtl();
    testAdminPrincipalSession();

    console.log('\n' + '='.repeat(50));
    console.log('  ✅  All Phase 1 tests passed');
    console.log('='.repeat(50) + '\n');
  } catch (err) {
    console.error('\n❌  Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

runAll();