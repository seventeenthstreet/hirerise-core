'use strict';

/**
 * salary.repository.js — Data Access Layer for salary_data collection
 *
 * PERFORMANCE UPGRADE: Cache invalidation added to insertSalaryRecord()
 * and batchInsert(). When new records are inserted for a roleId, the
 * cached aggregation for that role is automatically cleared.
 *
 * Design principles:
 *   - NEVER overwrite existing salary records — always append
 *   - Multiple salary records per role are expected and intentional
 *   - Duplicate detection uses (roleId + location + experienceLevel + sourceName + min + max)
 *   - Batch Firestore writes for bulk inserts (max 500 per batch)
 *
 * @module modules/salary/salary.repository
 */

const BaseRepository = require('../../repositories/BaseRepository');
const { db }         = require('../../config/supabase');
const logger         = require('../../utils/logger');
const { invalidateSalaryCache } = require('../../utils/salaryCache');

const COLLECTION = 'salary_data';

class SalaryRepository extends BaseRepository {
  constructor() {
    super(COLLECTION);
  }

  /**
   * Find all salary records for a given roleId.
   */
  async findByRoleId(roleId) {
    if (!roleId) return [];
    const col  = this._getCollection();
    const snap = await col
      .where('roleId', '==', roleId)
      .where('softDeleted', '==', false)
      .get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Find salary records filtered by roleId + optional filters.
   */
  async findByRoleIdWithFilters(roleId, filters = {}) {
    const col = this._getCollection();
    let query = col
      .where('roleId', '==', roleId)
      .where('softDeleted', '==', false);

    if (filters.location)        query = query.where('location',        '==', filters.location);
    if (filters.experienceLevel) query = query.where('experienceLevel', '==', filters.experienceLevel);
    if (filters.industry)        query = query.where('industry',        '==', filters.industry);

    const snap = await query.get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Check if a duplicate record exists.
   */
  async isDuplicate(record) {
    const col  = this._getCollection();
    const snap = await col
      .where('roleId',          '==', record.roleId)
      .where('location',        '==', record.location        || '')
      .where('experienceLevel', '==', record.experienceLevel || '')
      .where('sourceName',      '==', record.sourceName      || '')
      .where('minSalary',       '==', record.minSalary)
      .where('maxSalary',       '==', record.maxSalary)
      .limit(1)
      .get();
    return !snap.empty;
  }

  /**
   * Insert a single salary record. Never updates — always creates new doc.
   * CACHE: Invalidates cached aggregations for this roleId after insert.
   */
  async insertSalaryRecord(record, adminId = 'system') {
    const created = await super.create({
      ...record,
      sourceType:      record.sourceType      || 'ADMIN',
      confidenceScore: record.confidenceScore ?? 1.0,
    }, adminId);

    // Invalidate cached aggregation — new data changes the result
    invalidateSalaryCache(record.roleId);

    return created;
  }

  /**
   * Batch insert salary records. Firestore batched writes, chunked at 499.
   * CACHE: Invalidates cached aggregations for all affected roleIds after insert.
   */
  async batchInsert(records, adminId = 'system') {
    if (!records || records.length === 0) return { inserted: 0, duplicates: 0 };

    const BATCH_SIZE  = 499;
    let inserted      = 0;
    let duplicates    = 0;
    const now         = new Date();
    const col         = this._getCollection();
    const affectedRoles = new Set();

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      for (const record of chunk) {
        const isDup = await this.isDuplicate(record);
        if (isDup) {
          duplicates++;
          continue;
        }

        const docRef  = col.doc();
        const payload = {
          ...record,
          createdAt:       now,
          updatedAt:       now,
          createdBy:       adminId,
          updatedBy:       adminId,
          softDeleted:     false,
          status:          'active',
          version:         1,
          sourceType:      record.sourceType      || 'CSV',
          confidenceScore: record.confidenceScore ?? 0.8,
        };
        batch.set(docRef, payload);
        inserted++;
        affectedRoles.add(record.roleId);
      }

      await batch.commit();
      logger.info('[SalaryRepository] Batch committed', { chunk: i / BATCH_SIZE + 1, inserted });
    }

    // Invalidate cache for all roles that had new records inserted
    for (const roleId of affectedRoles) {
      invalidateSalaryCache(roleId);
    }

    return { inserted, duplicates };
  }

  /**
   * Find all records by sourceType.
   */
  async findBySourceType(sourceType) {
    const col  = this._getCollection();
    const snap = await col
      .where('sourceType',  '==', sourceType)
      .where('softDeleted', '==', false)
      .get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

module.exports = new SalaryRepository();








