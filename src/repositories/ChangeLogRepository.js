/**
 * ChangeLogRepository — Audit Trail Management
 *
 * ENTERPRISE GOVERNANCE: Change Tracking System
 *
 * Purpose:
 *   - Record all data modifications for audit compliance
 *   - Enable rollback and recovery operations
 *   - Provide accountability (who changed what when)
 *   - Support regulatory requirements (SOC2, GDPR, etc.)
 *
 * CRITICAL FEATURES:
 *   - Stores only diffs, not full document snapshots (storage efficient)
 *   - Immutable logs (changeLogs are never updated or deleted)
 *   - Automatic TTL via Firestore TTL policies (optional)
 *   - Supports querying by collection, document, user, or date range
 *
 * SCALABILITY:
 *   - Logs are written asynchronously (non-blocking)
 *   - Batch write support for bulk import operations
 *   - Indexed on [collectionName, documentId, timestamp]
 *
 * @module repositories/ChangeLogRepository
 */

'use strict';

const BaseRepository = require('./BaseRepository');
const { Timestamp } = require('firebase-admin/firestore');
const logger = require('../utils/logger');

class ChangeLogRepository extends BaseRepository {
  constructor() {
    super('changeLogs');
  }

  /**
   * Log a change operation
   *
   * CRITICAL: This method NEVER throws - logs are best-effort
   * If logging fails, the primary operation should still succeed
   *
   * @param {object} changeData - {
   *   collectionName: string,
   *   documentId: string,
   *   operation: 'create' | 'update' | 'delete' | 'upsert',
   *   changedFields: object (diff),
   *   previousValue: object (for deletes),
   *   newValue: object (for creates),
   *   userId: string,
   *   metadata: object (optional extra context)
   * }
   * @returns {Promise<void>}
   */
  async logChange(changeData) {
    try {
      const {
        collectionName,
        documentId,
        operation,
        changedFields = {},
        previousValue = null,
        newValue = null,
        userId = 'system',
        metadata = {},
      } = changeData;

      // Validate required fields
      if (!collectionName || !documentId || !operation) {
        logger.warn('[ChangeLog] Missing required fields, skipping log', {
          collectionName,
          documentId,
          operation,
        });
        return;
      }

      const logEntry = {
        collectionName,
        documentId,
        operation,
        changedFields,
        previousValue,
        newValue,
        userId,
        metadata,
        timestamp: Timestamp.now(),
        // Metadata is automatically added by BaseRepository
      };

      // Use create() to get automatic metadata
      await this.create(logEntry, userId);

      logger.debug('[ChangeLog] Logged change', {
        collectionName,
        documentId,
        operation,
        fieldsChanged: Object.keys(changedFields).length,
      });
    } catch (error) {
      // CRITICAL: Never let logging failures break primary operations
      logger.error('[ChangeLog] Failed to log change (non-fatal)', {
        error: error.message,
        changeData,
      });
    }
  }

  /**
   * Log multiple changes in batch (for bulk imports)
   *
   * @param {Array<object>} changes - Array of changeData objects
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async logChangesBatch(changes, userId = 'system') {
    try {
      if (!Array.isArray(changes) || changes.length === 0) {
        return;
      }

      const items = changes.map(change => ({
        id: this.db.collection(this.collectionName).doc().id, // Generate ID
        data: {
          ...change,
          timestamp: Timestamp.now(),
        },
      }));

      await this.batchWrite(items, userId, 'create');

      logger.info('[ChangeLog] Batch logged changes', {
        count: changes.length,
        userId,
      });
    } catch (error) {
      logger.error('[ChangeLog] Batch logging failed (non-fatal)', {
        error: error.message,
        changeCount: changes.length,
      });
    }
  }

  /**
   * Get change history for a specific document
   *
   * @param {string} collectionName
   * @param {string} documentId
   * @param {object} options - { limit, startAfter }
   * @returns {Promise<{docs: Array, hasMore: boolean}>}
   */
  async getDocumentHistory(collectionName, documentId, options = {}) {
    const filters = [
      { field: 'collectionName', op: '==', value: collectionName },
      { field: 'documentId', op: '==', value: documentId },
    ];

    const queryOptions = {
      ...options,
      orderBy: { field: 'timestamp', direction: 'desc' },
      includeSoftDeleted: false, // Change logs should never be soft-deleted
    };

    return await this.find(filters, queryOptions);
  }

  /**
   * Get all changes by a specific user
   *
   * Useful for:
   *   - User activity audits
   *   - Investigating suspicious behavior
   *   - Compliance reporting
   *
   * @param {string} userId
   * @param {object} options - { limit, startAfter, startDate, endDate }
   * @returns {Promise<{docs: Array, hasMore: boolean}>}
   */
  async getUserActivity(userId, options = {}) {
    const filters = [
      { field: 'userId', op: '==', value: userId },
    ];

    // Optional date range filtering
    if (options.startDate) {
      filters.push({
        field: 'timestamp',
        op: '>=',
        value: Timestamp.fromDate(options.startDate),
      });
    }

    if (options.endDate) {
      filters.push({
        field: 'timestamp',
        op: '<=',
        value: Timestamp.fromDate(options.endDate),
      });
    }

    const queryOptions = {
      limit: options.limit,
      startAfter: options.startAfter,
      orderBy: { field: 'timestamp', direction: 'desc' },
      includeSoftDeleted: false,
    };

    return await this.find(filters, queryOptions);
  }

  /**
   * Get recent changes across all collections
   *
   * Useful for:
   *   - Admin dashboards showing recent activity
   *   - Real-time monitoring
   *   - Compliance reporting
   *
   * @param {number} limit
   * @param {Date} since - Optional cutoff date
   * @returns {Promise<Array>}
   */
  async getRecentChanges(limit = 100, since = null) {
    const filters = [];

    if (since) {
      filters.push({
        field: 'timestamp',
        op: '>=',
        value: Timestamp.fromDate(since),
      });
    }

    const result = await this.find(filters, {
      limit,
      orderBy: { field: 'timestamp', direction: 'desc' },
      includeSoftDeleted: false,
    });

    return result.docs;
  }

  /**
   * Get change statistics for a collection
   *
   * Returns aggregated metrics:
   *   - Total changes
   *   - Changes by operation type
   *   - Most active users
   *   - Change frequency over time
   *
   * NOTE: This is expensive - use caching for dashboards
   *
   * @param {string} collectionName
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<object>}
   */
  async getCollectionStats(collectionName, startDate, endDate) {
    try {
      const filters = [
        { field: 'collectionName', op: '==', value: collectionName },
        { field: 'timestamp', op: '>=', value: Timestamp.fromDate(startDate) },
        { field: 'timestamp', op: '<=', value: Timestamp.fromDate(endDate) },
      ];

      // Fetch all changes in range (WARNING: could be large)
      const result = await this.find(filters, {
        limit: 10000, // Cap to prevent memory exhaustion
        includeSoftDeleted: false,
      });

      const changes = result.docs;

      // Aggregate statistics
      const stats = {
        totalChanges: changes.length,
        byOperation: {},
        byUser: {},
        byDay: {},
      };

      changes.forEach(change => {
        // Count by operation
        stats.byOperation[change.operation] = (stats.byOperation[change.operation] || 0) + 1;

        // Count by user
        stats.byUser[change.userId] = (stats.byUser[change.userId] || 0) + 1;

        // Count by day
        const day = change.timestamp.toDate().toISOString().split('T')[0];
        stats.byDay[day] = (stats.byDay[day] || 0) + 1;
      });

      return stats;
    } catch (error) {
      logger.error('[ChangeLog] Failed to calculate collection stats', {
        error: error.message,
        collectionName,
      });
      throw error;
    }
  }

  /**
   * Reconstruct document state at a specific point in time
   *
   * ADVANCED FEATURE: Enables "time travel" debugging
   *
   * WARNING: This is computationally expensive
   *   - Fetches all changes since document creation
   *   - Applies them in reverse chronological order
   *   - Only use for debugging/auditing, not in normal flows
   *
   * @param {string} collectionName
   * @param {string} documentId
   * @param {Date} pointInTime
   * @returns {Promise<object|null>} Document state at that time
   */
  async reconstructDocumentState(collectionName, documentId, pointInTime) {
    try {
      // Get all changes up to that point in time
      const filters = [
        { field: 'collectionName', op: '==', value: collectionName },
        { field: 'documentId', op: '==', value: documentId },
        { field: 'timestamp', op: '<=', value: Timestamp.fromDate(pointInTime) },
      ];

      const result = await this.find(filters, {
        limit: 1000,
        orderBy: { field: 'timestamp', direction: 'asc' },
        includeSoftDeleted: false,
      });

      if (result.docs.length === 0) {
        return null; // Document didn't exist at that time
      }

      let state = null;

      // Apply changes in chronological order
      for (const change of result.docs) {
        if (change.operation === 'create') {
          state = change.newValue;
        } else if (change.operation === 'update') {
          if (state) {
            // Apply changed fields
            for (const [field, { new: newValue }] of Object.entries(change.changedFields)) {
              state[field] = newValue;
            }
          }
        } else if (change.operation === 'delete') {
          state = null; // Document was deleted
        }
      }

      return state;
    } catch (error) {
      logger.error('[ChangeLog] Failed to reconstruct document state', {
        error: error.message,
        collectionName,
        documentId,
      });
      throw error;
    }
  }
}

module.exports = ChangeLogRepository;
