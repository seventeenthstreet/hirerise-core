'use strict';

/**
 * shared/repositories/base.repository.js
 *
 * BaseRepository — Production Hardened for Supabase
 *
 * ✅ Zero Firebase legacy assumptions
 * ✅ Centralized query execution
 * ✅ Better timeout safety
 * ✅ Strong null safety
 * ✅ Query operator map
 * ✅ Soft-delete aware
 * ✅ Bulk insert / upsert optimized
 * ✅ Consistent timestamps
 * ✅ Predictable return behavior
 * ✅ Improved maintainability
 */

const { supabase } = require('../config/supabaseClient');
const logger = require('../logger');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_LIMIT = 50;
const DEFAULT_COLUMNS = '*';

const OPERATOR_MAP = {
  '==': 'eq',
  '!=': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  in: 'in',
  like: 'like',
  ilike: 'ilike',
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeDbError(error, context = {}) {
  const err = new Error(error?.message || 'Database operation failed');
  err.code = error?.code || 'DB_ERROR';
  err.details = error?.details;
  err.hint = error?.hint;
  err.context = context;
  return err;
}

async function execute(query, context = {}) {
  let timeoutId;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error('Database query timeout');
        err.code = 'DB_TIMEOUT';
        reject(err);
      }, DEFAULT_TIMEOUT_MS);
    });

    const result = await Promise.race([query, timeoutPromise]);

    clearTimeout(timeoutId);

    const { data, error } = result;

    if (error) {
      const normalized = normalizeDbError(error, context);

      logger.error('Supabase query failed', {
        ...context,
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      });

      throw normalized;
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);

    logger.error('Repository execution failure', {
      ...context,
      code: error.code,
      message: error.message,
    });

    throw error;
  }
}

class BaseRepository {
  constructor(tableName) {
    if (!tableName || typeof tableName !== 'string') {
      throw new Error('BaseRepository requires a valid table name');
    }

    this.table = tableName;
  }

  baseSelect(columns = DEFAULT_COLUMNS) {
    return supabase
      .from(this.table)
      .select(columns)
      .is('deleted_at', null);
  }

  applyConditions(query, conditions = []) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return query;
    }

    for (const condition of conditions) {
      if (!Array.isArray(condition) || condition.length !== 3) continue;

      const [field, operator, value] = condition;

      if (!field || value === undefined) continue;

      const method = OPERATOR_MAP[operator];

      if (!method || typeof query[method] !== 'function') {
        logger.warn('Unsupported query operator skipped', {
          table: this.table,
          field,
          operator,
        });
        continue;
      }

      query = query[method](field, value);
    }

    return query;
  }

  // ─────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────

  async findById(id, columns = DEFAULT_COLUMNS) {
    if (!id) return null;

    const query = this.baseSelect(columns)
      .eq('id', id)
      .maybeSingle();

    return execute(query, {
      method: 'findById',
      table: this.table,
      id,
    });
  }

  async findWhere(
    conditions = [],
    {
      limit = DEFAULT_LIMIT,
      offset = 0,
      orderBy = null,
      columns = DEFAULT_COLUMNS,
    } = {}
  ) {
    let query = this.baseSelect(columns);

    query = this.applyConditions(query, conditions);

    if (orderBy?.field) {
      query = query.order(orderBy.field, {
        ascending: orderBy.direction !== 'desc',
      });
    }

    query = query.range(offset, offset + limit - 1);

    const rows = await execute(query, {
      method: 'findWhere',
      table: this.table,
    });

    return rows || [];
  }

  async exists(id) {
    if (!id) return false;

    const row = await this.findById(id, 'id');
    return !!row;
  }

  // ─────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────

  async create(data, { returning = 'minimal' } = {}) {
    if (!data || typeof data !== 'object') {
      throw new Error('create() requires a valid payload object');
    }

    const timestamp = nowIso();

    const payload = {
      ...data,
      created_at: data.created_at || timestamp,
      updated_at: timestamp,
      deleted_at: null,
    };

    let query = supabase.from(this.table).insert(payload);

    if (returning === 'full') {
      query = query.select().maybeSingle();
    }

    const result = await execute(query, {
      method: 'create',
      table: this.table,
    });

    return returning === 'full' ? result : payload.id ?? null;
  }

  async bulkInsert(records = [], { returning = 'minimal' } = {}) {
    if (!Array.isArray(records) || records.length === 0) {
      return [];
    }

    const timestamp = nowIso();

    const payload = records.map((record) => ({
      ...record,
      created_at: record.created_at || timestamp,
      updated_at: timestamp,
      deleted_at: null,
    }));

    let query = supabase.from(this.table).insert(payload);

    if (returning === 'full') {
      query = query.select();
    }

    const result = await execute(query, {
      method: 'bulkInsert',
      table: this.table,
      count: records.length,
    });

    return returning === 'full' ? result : [];
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────

  async update(id, data, { returning = 'minimal' } = {}) {
    if (!id || !data || typeof data !== 'object') {
      throw new Error('update() requires id and payload');
    }

    let query = supabase
      .from(this.table)
      .update({
        ...data,
        updated_at: nowIso(),
      })
      .eq('id', id)
      .is('deleted_at', null);

    if (returning === 'full') {
      query = query.select().maybeSingle();
    }

    return execute(query, {
      method: 'update',
      table: this.table,
      id,
    });
  }

  async upsert(id, data, { returning = 'minimal' } = {}) {
    if (!id || !data || typeof data !== 'object') {
      throw new Error('upsert() requires id and payload');
    }

    let query = supabase.from(this.table).upsert(
      {
        id,
        ...data,
        updated_at: nowIso(),
        deleted_at: null,
      },
      {
        onConflict: 'id',
      }
    );

    if (returning === 'full') {
      query = query.select().maybeSingle();
    }

    return execute(query, {
      method: 'upsert',
      table: this.table,
      id,
    });
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────

  async softDelete(id, deletedBy = null) {
    if (!id) {
      throw new Error('softDelete() requires id');
    }

    return execute(
      supabase
        .from(this.table)
        .update({
          deleted_at: nowIso(),
          deleted_by: deletedBy,
          updated_at: nowIso(),
        })
        .eq('id', id)
        .is('deleted_at', null),
      {
        method: 'softDelete',
        table: this.table,
        id,
      }
    );
  }
}

module.exports = { BaseRepository };