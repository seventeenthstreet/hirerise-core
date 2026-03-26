'use strict';

const supabase = require('../../../core/supabaseClient');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../utils/logger');

const TABLE = 'distributed_locks';

// Test stub
if (process.env.NODE_ENV === 'test') {
  class MockLockService {
    async acquire()               { return { release: async () => true }; }
    async release()               { return true; }
    async executeWithLock(_r, fn) { return await fn(); }
  }
  module.exports = new MockLockService();
} else {

  class LockService {

    async acquire(resource, ttl = 30000) {
      const lockId = uuidv4();
      const now = new Date();
      const expiresAt = new Date(Date.now() + ttl);

      // Try insert (atomic due to PK constraint)
      const { error } = await supabase
        .from(TABLE)
        .insert({
          resource,
          lock_id: lockId,
          expires_at: expiresAt.toISOString(),
          acquired_at: now.toISOString(),
        });

      if (error) {
        // Check if expired → overwrite
        const { data: existing } = await supabase
          .from(TABLE)
          .select('*')
          .eq('resource', resource)
          .maybeSingle();

        if (existing) {
          const expiry = new Date(existing.expires_at);

          if (expiry > now) {
            throw new Error('RESOURCE_LOCKED');
          }

          // expired → overwrite
          const { error: updateError } = await supabase
            .from(TABLE)
            .update({
              lock_id: lockId,
              expires_at: expiresAt.toISOString(),
              acquired_at: now.toISOString(),
            })
            .eq('resource', resource);

          if (updateError) {
            throw new Error(updateError.message);
          }
        } else {
          throw new Error(error.message);
        }
      }

      logger.debug('[LockService] Lock acquired', { resource, lockId });

      return { resource, lockId, expiresAt };
    }

    async release(lock) {
      if (!lock?.lockId || !lock?.resource) return;

      const { data } = await supabase
        .from(TABLE)
        .select('*')
        .eq('resource', lock.resource)
        .maybeSingle();

      if (!data) return;

      if (data.lock_id !== lock.lockId) return;

      await supabase
        .from(TABLE)
        .delete()
        .eq('resource', lock.resource);

      logger.debug('[LockService] Lock released', { resource: lock.resource });
    }

    async executeWithLock(resource, fn, ttl = 30000) {
      const lock = await this.acquire(resource, ttl);
      try {
        return await fn();
      } finally {
        await this.release(lock);
      }
    }
  }

  module.exports = new LockService();
}





