'use strict';

const { supabase } = require('../../../config/supabase');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../utils/logger');

const TABLE = 'distributed_locks';

// ─────────────────────────────────────────────
// TEST MODE
// ─────────────────────────────────────────────

if (process.env.NODE_ENV === 'test') {
  class MockLockService {
    async acquire()               { return { release: async () => true }; }
    async release()               { return true; }
    async executeWithLock(_r, fn) { return await fn(); }
  }
  module.exports = new MockLockService();
} else {

  class LockService {

    // ─────────────────────────────────────────────
    // ACQUIRE (SAFE + RETRY)
    // ─────────────────────────────────────────────
    async acquire(resource, ttl = 30000, retries = 3) {
      const lockId = uuidv4();
      const now = new Date();
      const expiresAt = new Date(Date.now() + ttl);

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          // 🔥 Try insert (fast path)
          const { error } = await supabase
            .from(TABLE)
            .insert({
              resource,
              lock_id: lockId,
              expires_at: expiresAt.toISOString(),
              acquired_at: now.toISOString(),
            });

          if (!error) {
            logger.debug('[LockService] Lock acquired (insert)', { resource, lockId });
            return { resource, lockId, expiresAt };
          }

          // 🔥 Try takeover if expired (ATOMIC)
          const { data, error: updateError } = await supabase
            .from(TABLE)
            .update({
              lock_id: lockId,
              expires_at: expiresAt.toISOString(),
              acquired_at: now.toISOString(),
            })
            .eq('resource', resource)
            .lt('expires_at', new Date().toISOString()) // 🔥 critical fix
            .select()
            .maybeSingle();

          if (!updateError && data) {
            logger.debug('[LockService] Lock acquired (takeover)', { resource, lockId });
            return { resource, lockId, expiresAt };
          }

          // 🔁 Retry with backoff
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
            continue;
          }

          throw new Error('RESOURCE_LOCKED');

        } catch (err) {
          if (attempt >= retries) throw err;
        }
      }
    }

    // ─────────────────────────────────────────────
    // RELEASE (SAFE)
    // ─────────────────────────────────────────────
    async release(lock) {
      if (!lock?.lockId || !lock?.resource) return;

      await supabase
        .from(TABLE)
        .delete()
        .eq('resource', lock.resource)
        .eq('lock_id', lock.lockId); // 🔥 ensure ownership

      logger.debug('[LockService] Lock released', { resource: lock.resource });
    }

    // ─────────────────────────────────────────────
    // EXECUTE WITH LOCK (SAFE)
    // ─────────────────────────────────────────────
    async executeWithLock(resource, fn, ttl = 30000, timeoutMs = 10000) {
      const lock = await this.acquire(resource, ttl);

      try {
        // 🔥 Timeout protection
        const result = await Promise.race([
          fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('LOCK_EXEC_TIMEOUT')), timeoutMs)
          )
        ]);

        return result;

      } finally {
        await this.release(lock);
      }
    }
  }

  module.exports = new LockService();
}