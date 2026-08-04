'use strict';

const { supabase } = require('../../../config/supabase');
const { randomUUID: uuidv4 } = require('crypto');
const logger = require('../../../utils/logger');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

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

          // 🔒 WP-DASH-05 — Failure classification (retry timing/count unchanged):
          //
          // At this point neither the insert nor the takeover update acquired
          // the lock. PostgREST/supabase-js already distinguishes these two
          // cases via the {data, error} contract this file relies on:
          //
          //   • updateError is truthy → the takeover query itself could not
          //     be executed (missing table, schema cache mismatch, RLS/
          //     permission failure, PostgREST/network fault, etc.). This is
          //     a provider/infrastructure failure, not lock contention. It
          //     will not resolve itself between attempts, so fail fast
          //     instead of burning through all retries with backoff delays
          //     first — that's what previously turned a missing-table error
          //     into a ~2s hang before finally surfacing.
          //
          //   • updateError is falsy AND data is falsy → the takeover query
          //     executed successfully but matched zero rows, i.e. the
          //     resource is held by another, still-unexpired lock. This is
          //     genuine lock contention and IS worth retrying with backoff.
          //
          // WP-DASH-05A: the original provider error's message/code/details/
          // hint are preserved in AppError.metadata so callers still see
          // exactly what the provider raised, now with a correct statusCode
          // attached instead of defaulting to 500.
          if (updateError) {
            logger.warn('[LockService] Provider error during lock takeover', {
              resource,
              lockId,
              attempt,
              message: updateError.message,
              code: updateError.code,
              details: updateError.details,
              hint: updateError.hint,
            });

            throw new AppError(
              updateError.message || 'Lock provider error',
              503,
              {
                resource,
                lockId,
                providerCode: updateError.code,
                details: updateError.details,
                hint: updateError.hint,
              },
              ErrorCodes.SERVICE_UNAVAILABLE
            );
          }

          // 🔁 Genuine contention — retry with backoff
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
            continue;
          }

          throw new AppError(
            `Resource "${resource}" is locked by another process`,
            409,
            { resource },
            'RESOURCE_LOCKED'
          );

        } catch (err) {
          // AppError instances above are already fully classified — either
          // a provider failure (fail fast, never retried) or contention on
          // the last attempt (nothing left to retry). Only bare/unexpected
          // exceptions from the supabase calls themselves (network blips,
          // etc.) get the retry treatment here, and now share the same
          // backoff as the {data,error} path instead of spinning immediately.
          if (err instanceof AppError) {
            throw err;
          }

          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
            continue;
          }

          throw err;
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
        // NOTE: Promise.race only stops *waiting* on fn() — it does not
        // cancel fn() itself. If fn() loses the race, it keeps running in
        // the background after this function has already returned/thrown,
        // and the lock below is released immediately regardless. This is a
        // soft timeout, not a hard abort; if fn() needs to be interruptible,
        // it must accept and honor an AbortSignal internally.
        const result = await Promise.race([
          fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new AppError(
              'Lock-protected operation timed out',
              504,
              { resource, timeoutMs },
              'LOCK_EXEC_TIMEOUT'
            )), timeoutMs)
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