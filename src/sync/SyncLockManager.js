'use strict';

const { randomUUID } = require('crypto');
const syncLockRepository = require('../repositories/syncLock.repository');

class ConflictError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'LOCK_CONFLICT';
    this.meta = meta;
    this.isConflict = true;
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
    const log = this._childLogger({
      requestId,
      initiatedBy,
      phase: 'acquire',
    });

    const lockedBy = initiatedBy || this.instanceId;

    log.info({ lockedBy }, 'Attempting sync lock');

    const result = await syncLockRepository.acquireLock(lockedBy);

    if (!result?.acquired) {
      const status = await syncLockRepository.getStatus();

      throw new ConflictError(
        result?.reason || 'Sync lock already active',
        {
          lockedBy: status?.locked_by,
          lockedAt: status?.locked_at,
          requestId,
        }
      );
    }

    log.info({ lockedBy }, 'Sync lock acquired');

    return {
      lockId: 'jobSync',
      instanceId: lockedBy,
      acquiredAt: new Date(),
    };
  }

  async release(context = {}) {
    const { requestId, initiatedBy } = context;
    const lockedBy = initiatedBy || this.instanceId;

    const log = this._childLogger({
      requestId,
      phase: 'release',
    });

    try {
      await syncLockRepository.releaseLock(lockedBy);

      log.info({ lockedBy }, 'Sync lock released');

      return true;
    } catch (err) {
      log.error({ err }, 'Lock release failed');
      return false;
    }
  }

  async runWithLock(asyncFn, context = {}) {
    await this.acquire(context);

    try {
      return await asyncFn();
    } finally {
      await this.release(context);
    }
  }

  _childLogger(bindings) {
    return this.logger.child
      ? this.logger.child(bindings)
      : this.logger;
  }
}

module.exports = {
  SyncLockManager,
  ConflictError,
};