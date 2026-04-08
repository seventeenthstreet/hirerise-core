'use strict';

/**
 * BaseRepository — Supabase-native generic repository
 *
 * Supports:
 *  - CRUD operations
 *  - Soft delete (optional)
 *  - Automatic timestamps (optional)
 *  - Batch operations
 *  - SQL-style condition mapping
 *  - snake_case → camelCase normalization
 */

const { supabase } = require('../../config/supabase');
const logger = require('../logger');

class BaseRepository {
  /**
   * @param {string} tableName
   * @param {object} [options={}]
   * @param {boolean} [options.hasSoftDelete=false]
   * @param {boolean} [options.hasTimestamps=true]
   */
  constructor(tableName, options = {}) {
    if (!tableName) {
      throw new Error('BaseRepository requires a table name');
    }

    this.table = tableName;
    this.hasSoftDelete = options.hasSoftDelete ?? false;
    this.hasTimestamps = options.hasTimestamps ?? true;
  }

  // ───────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────

  get serverTimestamp() {
    return new Date().toISOString();
  }

  _baseQuery() {
    let query = supabase.from(this.table).select('*');

    if (this.hasSoftDelete) {
      query = query.is('deleted_at', null);
    }

    return query;
  }

  // ───────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────

  async findById(id) {
    if (!id) return null;

    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error(
        `[BaseRepository] findById error [${this.table}/${id}]`,
        { error: error.message }
      );
      throw new Error(`DB error in findById [${this.table}]`);
    }

    if (!data) return null;
    if (this.hasSoftDelete && data.deleted_at) return null;

    return this._normalize(data);
  }

  async findOneWhere(conditions = []) {
    let query = this._baseQuery();

    for (const [field, op, value] of conditions) {
      query = this._applyCondition(query, field, op, value);
    }

    const { data, error } = await query.limit(1).maybeSingle();

    if (error) {
      logger.error(
        `[BaseRepository] findOneWhere error [${this.table}]`,
        { error: error.message }
      );
      throw new Error(`DB error in findOneWhere [${this.table}]`);
    }

    return data ? this._normalize(data) : null;
  }

  async findWhere(
    conditions = [],
    { limit = 100, orderBy = null } = {}
  ) {
    let query = this._baseQuery();

    for (const [field, op, value] of conditions) {
      query = this._applyCondition(query, field, op, value);
    }

    if (orderBy) {
      const ascending = (orderBy.direction ?? 'asc') !== 'desc';
      query = query.order(orderBy.field, { ascending });
    }

    const { data, error } = await query.limit(limit);

    if (error) {
      logger.error(
        `[BaseRepository] findWhere error [${this.table}]`,
        { error: error.message }
      );
      throw new Error(`DB error in findWhere [${this.table}]`);
    }

    return (data ?? []).map((row) => this._normalize(row));
  }

  // ───────────────────────────────────────────────────────────
  // Write
  // ───────────────────────────────────────────────────────────

  async create(id, data) {
    const now = this.serverTimestamp;

    const payload = {
      ...data,
      ...(this.hasTimestamps && {
        created_at: now,
        updated_at: now,
      }),
      ...(this.hasSoftDelete && {
        deleted_at: null,
      }),
    };

    if (id) payload.id = id;

    const { data: inserted, error } = await supabase
      .from(this.table)
      .insert(payload)
      .select('id')
      .single();

    if (error) {
      logger.error(`[BaseRepository] create error [${this.table}]`, {
        error: error.message,
      });
      throw new Error(`DB error in create [${this.table}]`);
    }

    return inserted.id;
  }

  async update(id, data) {
    const existing = await this.findById(id);

    if (!existing) {
      throw new Error(`Record ${id} not found in ${this.table}`);
    }

    const payload = {
      ...data,
      ...(this.hasTimestamps && {
        updated_at: this.serverTimestamp,
      }),
    };

    const { error } = await supabase
      .from(this.table)
      .update(payload)
      .eq('id', id);

    if (error) {
      logger.error(
        `[BaseRepository] update error [${this.table}/${id}]`,
        { error: error.message }
      );
      throw new Error(`DB error in update [${this.table}/${id}]`);
    }
  }

  async upsert(id, data) {
    const payload = {
      ...data,
      id,
      ...(this.hasTimestamps && {
        updated_at: this.serverTimestamp,
      }),
      ...(this.hasSoftDelete && {
        deleted_at: null,
      }),
    };

    const { error } = await supabase
      .from(this.table)
      .upsert(payload, { onConflict: 'id' });

    if (error) {
      logger.error(
        `[BaseRepository] upsert error [${this.table}/${id}]`,
        { error: error.message }
      );
      throw new Error(`DB error in upsert [${this.table}/${id}]`);
    }

    return id;
  }

  async softDelete(id, deletedBy = null) {
    if (!this.hasSoftDelete) {
      throw new Error(`Soft delete not enabled for table ${this.table}`);
    }

    const payload = {
      deleted_at: this.serverTimestamp,
      ...(this.hasTimestamps && {
        updated_at: this.serverTimestamp,
      }),
      ...(deletedBy !== null && {
        deleted_by: deletedBy,
      }),
    };

    const { error } = await supabase
      .from(this.table)
      .update(payload)
      .eq('id', id);

    if (error) {
      logger.error(
        `[BaseRepository] softDelete error [${this.table}/${id}]`,
        { error: error.message }
      );
      throw new Error(`DB error in softDelete [${this.table}/${id}]`);
    }
  }

  async exists(id) {
    const { data, error } = await supabase
      .from(this.table)
      .select('id, deleted_at')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return false;
    if (this.hasSoftDelete && data.deleted_at) return false;

    return true;
  }

  async batchWrite(operations = []) {
    const chunks = this._chunk(operations, 100);

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map((op) => {
          if (op.type === 'set') {
            return supabase
              .from(this.table)
              .upsert(
                { ...op.data, id: op.id },
                { onConflict: 'id' }
              );
          }

          if (op.type === 'update') {
            return supabase
              .from(this.table)
              .update({
                ...op.data,
                ...(this.hasTimestamps && {
                  updated_at: this.serverTimestamp,
                }),
              })
              .eq('id', op.id);
          }

          if (op.type === 'delete') {
            if (!this.hasSoftDelete) {
              throw new Error(
                `Soft delete not enabled for ${this.table}`
              );
            }

            return supabase
              .from(this.table)
              .update({
                deleted_at: this.serverTimestamp,
              })
              .eq('id', op.id);
          }

          throw new Error(`Unknown batch op type: ${op.type}`);
        })
      );
    }
  }

  // ───────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────

  _applyCondition(query, field, op, value) {
    switch (op) {
      case '==':
        return query.eq(field, value);
      case '!=':
        return query.neq(field, value);
      case '>':
        return query.gt(field, value);
      case '>=':
        return query.gte(field, value);
      case '<':
        return query.lt(field, value);
      case '<=':
        return query.lte(field, value);
      case 'in':
        return query.in(field, value);
      case 'array-contains':
        return query.contains(field, [value]);
      default:
        throw new Error(`Unsupported operator "${op}"`);
    }
  }

  _normalize(row) {
    if (!row) return null;

    const out = {};

    for (const [k, v] of Object.entries(row)) {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = v instanceof Date ? v.toISOString() : v;
    }

    return out;
  }

  _chunk(arr, size) {
    const out = [];

    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }

    return out;
  }
}

module.exports = { BaseRepository };