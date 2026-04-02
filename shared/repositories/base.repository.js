'use strict';

/**
 * BaseRepository — PRODUCTION HARDENED (SUPABASE)
 *
 * ✅ Select optimization
 * ✅ Pagination support
 * ✅ Error normalization
 * ✅ Timeout protection
 * ✅ Bulk operations added
 */

const { supabase } = require('../config/supabaseClient');
const logger = require('../logger');

const DEFAULT_TIMEOUT = 10000;

// ─────────────────────────────────────────────
// Helper: Safe Query Execution
// ─────────────────────────────────────────────
async function execute(queryPromise, context) {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DB_TIMEOUT')), DEFAULT_TIMEOUT)
    );

    const { data, error } = await Promise.race([queryPromise, timeout]);

    if (error) {
      logger.error('Database error', { error, ...context });

      const err = new Error(error.message);
      err.code = 'DB_ERROR';
      throw err;
    }

    return data;
  } catch (err) {
    logger.error('Database failure', { err, ...context });
    throw err;
  }
}

// ─────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────

class BaseRepository {
  constructor(tableName) {
    if (!tableName) throw new Error('BaseRepository requires a table name');
    this.table = tableName;
  }

  // ─────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────

  async findById(id, columns = '*') {
    const query = supabase
      .from(this.table)
      .select(columns)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();

    return await execute(query, { method: 'findById', table: this.table });
  }

  async findWhere(
    conditions = [],
    {
      limit = 50,
      offset = 0,
      orderBy = null,
      columns = '*',
    } = {}
  ) {
    let query = supabase
      .from(this.table)
      .select(columns)
      .range(offset, offset + limit - 1);

    for (const [field, op, value] of conditions) {
      if (op === '==') query = query.eq(field, value);
      else if (op === '!=') query = query.neq(field, value);
      else if (op === '>') query = query.gt(field, value);
      else if (op === '<') query = query.lt(field, value);
    }

    query = query.is('deleted_at', null);

    if (orderBy) {
      query = query.order(orderBy.field, {
        ascending: orderBy.direction !== 'desc',
      });
    }

    return (await execute(query, { method: 'findWhere' })) || [];
  }

  // ─────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────

  async create(data, { returning = 'minimal' } = {}) {
    const payload = {
      ...data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };

    let query = supabase.from(this.table).insert(payload);

    if (returning === 'full') {
      query = query.select().maybeSingle();
    }

    const result = await execute(query, { method: 'create' });

    return returning === 'full' ? result : payload.id;
  }

  // ─────────────────────────────────────────────
  // BULK INSERT (NEW)
  // ─────────────────────────────────────────────

  async bulkInsert(records = []) {
    if (!records.length) return [];

    const payload = records.map((r) => ({
      ...r,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }));

    return await execute(
      supabase.from(this.table).insert(payload),
      { method: 'bulkInsert' }
    );
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────

  async update(id, data) {
    return await execute(
      supabase
        .from(this.table)
        .update({
          ...data,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .is('deleted_at', null),
      { method: 'update', id }
    );
  }

  async upsert(id, data) {
    const payload = {
      id,
      ...data,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };

    return await execute(
      supabase.from(this.table).upsert(payload, { onConflict: 'id' }),
      { method: 'upsert', id }
    );
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────

  async softDelete(id, deletedBy = null) {
    return await execute(
      supabase
        .from(this.table)
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by: deletedBy,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id),
      { method: 'softDelete', id }
    );
  }

  async exists(id) {
    const data = await execute(
      supabase
        .from(this.table)
        .select('id')
        .eq('id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      { method: 'exists', id }
    );

    return !!data;
  }
}

module.exports = { BaseRepository };