'use strict';

/**
 * src/modules/salary/salary.repository.js
 *
 * Production-grade Supabase salary repository
 * - Firestore legacy patterns removed
 * - snake_case Postgres columns normalized
 * - conflict-safe bulk upsert
 * - SQL-driven dedupe strategy
 * - efficient cache invalidation
 * - no N+1 duplicate queries
 * - clean row ↔ domain mapping
 */

const { supabase } = require('../../config/supabase');
const BaseRepository = require('../../repositories/BaseRepository');
const logger = require('../../utils/logger');
const { invalidateSalaryCache } = require('../../utils/salaryCache');

const TABLE = 'salary_data';

const READ_COLUMNS = `
  id,
  role_id,
  location,
  experience_level,
  industry,
  source_name,
  source_type,
  min_salary,
  max_salary,
  confidence_score,
  created_at,
  updated_at,
  created_by,
  updated_by,
  soft_deleted,
  status,
  version
`;

class SalaryRepository extends BaseRepository {
  constructor() {
    super(TABLE);
  }

  mapRow(row) {
    if (!row) return null;

    return {
      id: row.id,
      roleId: row.role_id,
      location: row.location,
      experienceLevel: row.experience_level,
      industry: row.industry,
      sourceName: row.source_name,
      sourceType: row.source_type,
      minSalary: row.min_salary,
      maxSalary: row.max_salary,
      confidenceScore: row.confidence_score,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      softDeleted: row.soft_deleted,
      status: row.status,
      version: row.version,
    };
  }

  createDedupeKey(record) {
    return require('crypto')
      .createHash('md5')
      .update([
        record.roleId,
        record.location || '',
        record.experienceLevel || '',
        record.sourceName || '',
        record.minSalary,
        record.maxSalary,
      ].join('|'))
      .digest('hex');
  }

  normalizeRecord(record, adminId, sourceTypeFallback = 'ADMIN') {
    return {
      role_id: record.roleId,
      location: record.location || null,
      experience_level: record.experienceLevel || null,
      industry: record.industry || null,
      source_name: record.sourceName || null,
      source_type: record.sourceType || sourceTypeFallback,
      min_salary: record.minSalary,
      max_salary: record.maxSalary,
      confidence_score: record.confidenceScore ?? 1.0,
      created_by: adminId,
      updated_by: adminId,
      dedupe_key: this.createDedupeKey(record),
    };
  }

  // ─────────────────────────────────────────────────────────
  // Find by roleId
  // ─────────────────────────────────────────────────────────
  async findByRoleId(roleId) {
    if (!roleId) return [];

    const { data, error } = await supabase
      .from(TABLE)
      .select(READ_COLUMNS)
      .eq('role_id', roleId)
      .eq('soft_deleted', false);

    if (error) throw error;

    return (data || []).map((row) => this.mapRow(row));
  }

  // ─────────────────────────────────────────────────────────
  // Find with filters
  // ─────────────────────────────────────────────────────────
  async findByRoleIdWithFilters(roleId, filters = {}) {
    let query = supabase
      .from(TABLE)
      .select(READ_COLUMNS)
      .eq('role_id', roleId)
      .eq('soft_deleted', false);

    if (filters.location) {
      query = query.eq('location', filters.location);
    }

    if (filters.experienceLevel) {
      query = query.eq('experience_level', filters.experienceLevel);
    }

    if (filters.industry) {
      query = query.eq('industry', filters.industry);
    }

    const { data, error } = await query;

    if (error) throw error;

    return (data || []).map((row) => this.mapRow(row));
  }

  // ─────────────────────────────────────────────────────────
  // Insert single
  // ─────────────────────────────────────────────────────────
  async insertSalaryRecord(record, adminId = 'system') {
    const payload = this.normalizeRecord(record, adminId);

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(payload, {
        onConflict: 'dedupe_key',
        ignoreDuplicates: true,
      })
      .select(READ_COLUMNS)
      .single();

    if (error) throw error;

    invalidateSalaryCache(record.roleId);

    return this.mapRow(data);
  }

  // ─────────────────────────────────────────────────────────
  // Batch insert (Production Optimized)
  // ─────────────────────────────────────────────────────────
  async batchInsert(records, adminId = 'system') {
    if (!Array.isArray(records) || records.length === 0) {
      return { inserted: 0, duplicates: 0 };
    }

    const BATCH_SIZE = 1000;
    let inserted = 0;
    const affectedRoles = new Set();

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);

      const payload = chunk.map((record) => {
        affectedRoles.add(record.roleId);
        return this.normalizeRecord(record, adminId, 'CSV');
      });

      const { data, error } = await supabase
        .from(TABLE)
        .upsert(payload, {
          onConflict: 'dedupe_key',
          ignoreDuplicates: true,
        })
        .select('role_id');

      if (error) throw error;

      inserted += data?.length || 0;

      logger.info('[SalaryRepository] Batch upsert completed', {
        chunk: Math.floor(i / BATCH_SIZE) + 1,
        chunkSize: chunk.length,
        insertedSoFar: inserted,
      });
    }

    for (const roleId of affectedRoles) {
      invalidateSalaryCache(roleId);
    }

    return {
      inserted,
      duplicates: records.length - inserted,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Find by source type
  // ─────────────────────────────────────────────────────────
  async findBySourceType(sourceType) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(READ_COLUMNS)
      .eq('source_type', sourceType)
      .eq('soft_deleted', false);

    if (error) throw error;

    return (data || []).map((row) => this.mapRow(row));
  }
}

module.exports = new SalaryRepository();