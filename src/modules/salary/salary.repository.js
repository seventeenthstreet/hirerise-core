'use strict';

const { supabase } = require('../../config/supabase');
const BaseRepository = require('../../repositories/BaseRepository');
const logger = require('../../utils/logger');
const { invalidateSalaryCache } = require('../../utils/salaryCache');
const crypto = require('crypto');

const COLLECTION = 'salary_data';

class SalaryRepository extends BaseRepository {
  constructor() {
    super(COLLECTION);
  }

  // ─────────────────────────────────────────────────────────
  // Find by roleId
  // ─────────────────────────────────────────────────────────
  async findByRoleId(roleId) {
    if (!roleId) return [];

    const { data, error } = await supabase
      .from(COLLECTION)
      .select('*')
      .eq('roleId', roleId)          // ⚠️ snake_case → role_id
      .eq('softDeleted', false);     // ⚠️ → soft_deleted

    if (error) throw error;

    return (data || []).map(row => ({ id: row.id, ...row }));
  }

  // ─────────────────────────────────────────────────────────
  // Find with filters
  // ─────────────────────────────────────────────────────────
  async findByRoleIdWithFilters(roleId, filters = {}) {

    let query = supabase
      .from(COLLECTION)
      .select('*')
      .eq('roleId', roleId)
      .eq('softDeleted', false);

    if (filters.location) {
      query = query.eq('location', filters.location);
    }

    if (filters.experienceLevel) {
      query = query.eq('experienceLevel', filters.experienceLevel);
    }

    if (filters.industry) {
      query = query.eq('industry', filters.industry);
    }

    const { data, error } = await query;

    if (error) throw error;

    return (data || []).map(row => ({ id: row.id, ...row }));
  }

  // ─────────────────────────────────────────────────────────
  // Duplicate check
  // ─────────────────────────────────────────────────────────
  async isDuplicate(record) {

    const { data, error } = await supabase
      .from(COLLECTION)
      .select('id')
      .eq('roleId', record.roleId)
      .eq('location', record.location || '')
      .eq('experienceLevel', record.experienceLevel || '')
      .eq('sourceName', record.sourceName || '')
      .eq('minSalary', record.minSalary)
      .eq('maxSalary', record.maxSalary)
      .limit(1);

    if (error) throw error;

    return (data && data.length > 0);
  }

  // ─────────────────────────────────────────────────────────
  // Insert single
  // ─────────────────────────────────────────────────────────
  async insertSalaryRecord(record, adminId = 'system') {

    const created = await super.create({
      ...record,
      sourceType: record.sourceType || 'ADMIN',
      confidenceScore: record.confidenceScore ?? 1.0,
    }, adminId);

    invalidateSalaryCache(record.roleId);

    return created;
  }

  // ─────────────────────────────────────────────────────────
  // Batch insert (FIXED)
  // ─────────────────────────────────────────────────────────
  async batchInsert(records, adminId = 'system') {

    if (!records || records.length === 0) {
      return { inserted: 0, duplicates: 0 };
    }

    const BATCH_SIZE = 500;
    let inserted = 0;
    let duplicates = 0;
    const nowISO = new Date().toISOString();
    const affectedRoles = new Set();

    for (let i = 0; i < records.length; i += BATCH_SIZE) {

      const chunk = records.slice(i, i + BATCH_SIZE);
      const insertPayload = [];

      for (const record of chunk) {

        const isDup = await this.isDuplicate(record);

        if (isDup) {
          duplicates++;
          continue;
        }

        insertPayload.push({
          id: crypto.randomUUID(),
          ...record,
          createdAt: nowISO,
          updatedAt: nowISO,
          createdBy: adminId,
          updatedBy: adminId,
          softDeleted: false,
          status: 'active',
          version: 1,
          sourceType: record.sourceType || 'CSV',
          confidenceScore: record.confidenceScore ?? 0.8,
        });

        inserted++;
        affectedRoles.add(record.roleId);
      }

      if (insertPayload.length > 0) {
        const { error } = await supabase
          .from(COLLECTION)
          .insert(insertPayload);

        if (error) throw error;
      }

      logger.info('[SalaryRepository] Batch inserted', {
        chunk: i / BATCH_SIZE + 1,
        inserted
      });
    }

    for (const roleId of affectedRoles) {
      invalidateSalaryCache(roleId);
    }

    return { inserted, duplicates };
  }

  // ─────────────────────────────────────────────────────────
  // Find by sourceType
  // ─────────────────────────────────────────────────────────
  async findBySourceType(sourceType) {

    const { data, error } = await supabase
      .from(COLLECTION)
      .select('*')
      .eq('sourceType', sourceType)
      .eq('softDeleted', false);

    if (error) throw error;

    return (data || []).map(row => ({ id: row.id, ...row }));
  }
}

module.exports = new SalaryRepository();
