'use strict';

/**
 * syncLock.repository.js  (v3 — hardened with lock expiry)
 *
 * Improvements:
 * - Lock auto-expiry (crash recovery safe)
 * - Defensive lockedBy validation
 * - merge: true on release
 * - Configurable LOCK_TIMEOUT_MINUTES
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('../../../../shared/logger');

const LOCK_DOC_ID        = 'jobSync';
const LOCK_COLLECTION    = 'syncLocks';
const LOCK_TIMEOUT_MINUTES = 30; // crash recovery window

class SyncLockRepository {
  constructor() {
    this._db = getFirestore();
  }

  _lockRef() {
    return this._db.collection(LOCK_COLLECTION).doc(LOCK_DOC_ID);
  }

  async acquireLock(lockedBy) {
    if (!lockedBy || typeof lockedBy !== 'string') {
      throw new Error('Invalid lockedBy value for sync lock');
    }

    const lockRef = this._lockRef();

    try {
      let acquired = false;
      let reason;

      await this._db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);

        if (snap.exists) {
          const data = snap.data();
          const status   = data?.status;
          const lockedAt = data?.lockedAt?.toDate?.();

          if (status === 'running') {
            const now = new Date();

            // Check if lock is stale
            if (lockedAt) {
              const diffMinutes =
                (now.getTime() - lockedAt.getTime()) / (1000 * 60);

              if (diffMinutes > LOCK_TIMEOUT_MINUTES) {
                logger.warn('[SyncLockRepository] Stale lock detected. Taking over.', {
                  previousLockedBy: data.lockedBy,
                  lockedAt,
                });
              } else {
                acquired = false;
                reason = `Sync already running (started by ${data.lockedBy} at ${lockedAt.toISOString()})`;
                return;
              }
            } else {
              acquired = false;
              reason = 'Sync already running (no timestamp available)';
              return;
            }
          }
        }

        // Claim lock (new or stale takeover)
        tx.set(lockRef, {
          status:     'running',
          lockedBy,
          lockedAt:   FieldValue.serverTimestamp(),
          releasedAt: null,
        }, { merge: true });

        acquired = true;
      });

      if (acquired) {
        logger.info('[SyncLockRepository.acquireLock] acquired', { lockedBy });
      } else {
        logger.warn('[SyncLockRepository.acquireLock] rejected', { reason });
      }

      return { acquired, reason };
    } catch (err) {
      logger.error('[SyncLockRepository.acquireLock] transaction failed', {
        error: err.message,
      });
      throw err;
    }
  }

  async releaseLock() {
    try {
      await this._lockRef().set({
        status:     'idle',
        lockedBy:   null,
        lockedAt:   null,
        releasedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logger.info('[SyncLockRepository.releaseLock] released');
    } catch (err) {
      logger.error(
        '[SyncLockRepository.releaseLock] failed — manual reset may be required',
        { error: err.message }
      );
    }
  }
}

module.exports = new SyncLockRepository();