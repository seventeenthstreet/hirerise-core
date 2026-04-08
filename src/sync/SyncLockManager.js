'use strict';

/**
 * @file src/sync/SyncLockManager.js
 * @description
 * Production-grade distributed sync lock manager.
 * Optimized for Supabase/Postgres lock repositories.
 */

const { randomUUID } = require('crypto');
const syncLockRepository = require('../repositories/syncLock.repository');

class ConflictError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'LOCK_CONFLICT';
    this.meta = meta;
    this.isConflict = true;

    Error.captureStackTrace?.(this, ConflictError);
  }
}

class SyncLockManager {
  constructor({ logger } = {}) {
    if (!logger) {
      throw new Error('SyncLockManager: logger is required');
    }

    this.logger = logger;
    this.instanceId = randomUUID();
  }

  async acquire(context = {}) {
    const { requestId, initiatedBy } = context;

    const lockOwner = this._buildLockOwner({
      requestId,
      initiatedBy,
    });

    const log = this._childLogger({
      requestId,
      initiatedBy,
      phase: 'acquire',
      lockOwner,
    });

    log.info('Attempting sync lock');

    const result = await syncLockRepository.acquireLock(lockOwner);

    if (!result?.acquired) {
      const status = await syncLockRepository.getStatus();

      throw new ConflictError(
        result?.reason || 'Sync lock already active',
        {
          lockOwner,
          lockedBy: status?.locked_by || null,
          lockedAt: status?.locked_at || null,
          requestId: requestId || null,
        }
      );
    }

    log.info('Sync lock acquired');

    return {
      lockId: 'jobSync',
      instanceId: this.instanceId,
      lockOwner,
      acquiredAt: new Date().toISOString(),
    };
  }

  async release(context = {}) {
    const { requestId, initiatedBy } = context;

    const lockOwner = this._buildLockOwner({
      requestId,
      initiatedBy,
    });

    const log = this._childLogger({
      requestId,
      phase: 'release',
      lockOwner,
    });

    await syncLockRepository.releaseLock(lockOwner);

    log.info('Sync lock released');

    return true;
  }

  async runWithLock(asyncFn, context = {}) {
    if (typeof asyncFn !== 'function') {
      throw new TypeError('runWithLock requires a function');
    }

    await this.acquire(context);

    try {
      return await asyncFn();
    } finally {
      await this.release(context);
    }
  }

  _buildLockOwner({ requestId, initiatedBy }) {
    return [
      initiatedBy || 'system',
      requestId || this.instanceId,
      this.instanceId,
    ].join(':');
  }

  _childLogger(bindings) {
    return typeof this.logger.child === 'function'
      ? this.logger.child(bindings)
      : this.logger;
  }
}

module.exports = Object.freeze({
  SyncLockManager,
  ConflictError,
});