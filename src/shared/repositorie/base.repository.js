'use strict';

// FIXED: Fully converted from Firestore shim patterns to native Supabase.
// Removed: this.collection.doc(), snap.exists, snap.data(), .where(), .orderBy()
// Added: supabase.from(this.table), { data, error } destructuring, .maybeSingle()

const supabase = require('../../src/config/supabase');
const logger   = require('../logger');

class BaseRepository {
  /**
   * @param {string} tableName — Postgres table name (snake_case, e.g. 'users')
   */
  constructor(tableName) {
    if (!tableName) throw new Error('BaseRepository requires a table name');
    this.table = tableName;
  }

  // ─── Timestamp helper ──────────────────────────────────────────────────────

  get serverTimestamp() {
    return new Date().toISOString();
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /**
   * Find a single record by primary key.
   * Returns null if not found or soft-deleted.
   */
  async findById(id) {
    if (!id) return null;

    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error(`[BaseRepository] findById error [${this.table}/${id}]`, { error: error.message });
      throw new Error(`DB error in findById [${this.table}]: ${error.message}`);
    }

    if (!data) return null;
    if (data.deleted_at || data.deletedAt) return null;

    return this._normalize(data);
  }

  /**
   * Find the first record matching all conditions.
   * conditions: array of [field, op, value] triples  (Firestore-compatible signature kept)
   */
  async findOneWhere(conditions = []) {
    let query = supabase
      .from(this.table)
      .select('*')
      .is('deleted_at', null);

    for (const [field, op, value] of conditions) {
      query = this._applyCondition(query, field, op, value);
    }

    const { data, error } = await query.limit(1).maybeSingle();

    if (error) {
      logger.error(`[BaseRepository] findOneWhere error [${this.table}]`, { error: error.message });
      throw new Error(`DB error in findOneWhere [${this.table}]: ${error.message}`);
    }

    if (!data) return null;
    return this._normalize(data);
  }

  /**
   * Find multiple records matching conditions.
   * conditions: array of [field, op, value] triples
   */
  async findWhere(conditions = [], { limit = 100, orderBy = null } = {}) {
    let query = supabase
      .from(this.table)
      .select('*')
      .is('deleted_at', null);

    for (const [field, op, value] of conditions) {
      query = this._applyCondition(query, field, op, value);
    }

    if (orderBy) {
      const ascending = (orderBy.direction ?? 'asc') !== 'desc';
      query = query.order(orderBy.field, { ascending });
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      logger.error(`[BaseRepository] findWhere error [${this.table}]`, { error: error.message });
      throw new Error(`DB error in findWhere [${this.table}]: ${error.message}`);
    }

    return (data ?? []).map(row => this._normalize(row));
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Create a new record.
   * @param {string|null} id   — supply to force a specific ID; null for auto-UUID
   * @param {object}      data — payload
   * @returns {Promise<string>} the created record's id
   */
  async create(id, data) {
    const now = this.serverTimestamp;
    const payload = {
      ...data,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    if (id) payload.id = id;

    const { data: inserted, error } = await supabase
      .from(this.table)
      .insert(payload)
      .select('id')
      .single();

    if (error) {
      logger.error(`[BaseRepository] create error [${this.table}]`, { error: error.message });
      throw new Error(`DB error in create [${this.table}]: ${error.message}`);
    }

    return inserted.id;
  }

  /**
   * Partial update. Throws if the record does not exist or is soft-deleted.
   */
  async update(id, data) {
    // Verify existence first (also checks soft-delete via findById)
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Document ${id} not found in ${this.table}`);
    }

    const payload = {
      ...data,
      updated_at: this.serverTimestamp,
    };

    const { error } = await supabase
      .from(this.table)
      .update(payload)
      .eq('id', id);

    if (error) {
      logger.error(`[BaseRepository] update error [${this.table}/${id}]`, { error: error.message });
      throw new Error(`DB error in update [${this.table}/${id}]: ${error.message}`);
    }
  }

  /**
   * Upsert: insert or merge-update on conflict.
   */
  async upsert(id, data) {
    const now = this.serverTimestamp;
    const payload = {
      ...data,
      id,
      updated_at: now,
      deleted_at: null,
    };

    const { error } = await supabase
      .from(this.table)
      .upsert(payload, { onConflict: 'id' });

    if (error) {
      logger.error(`[BaseRepository] upsert error [${this.table}/${id}]`, { error: error.message });
      throw new Error(`DB error in upsert [${this.table}/${id}]: ${error.message}`);
    }

    return id;
  }

  /**
   * Soft-delete: sets deleted_at timestamp, record remains in DB.
   */
  async softDelete(id, deletedBy = null) {
    const payload = {
      deleted_at: this.serverTimestamp,
      updated_at: this.serverTimestamp,
    };
    if (deletedBy !== null) payload.deleted_by = deletedBy;

    const { error } = await supabase
      .from(this.table)
      .update(payload)
      .eq('id', id);

    if (error) {
      logger.error(`[BaseRepository] softDelete error [${this.table}/${id}]`, { error: error.message });
      throw new Error(`DB error in softDelete [${this.table}/${id}]: ${error.message}`);
    }
  }

  /**
   * Returns true if a non-deleted record with this id exists.
   */
  async exists(id) {
    const { data, error } = await supabase
      .from(this.table)
      .select('id, deleted_at')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return false;
    return !data.deleted_at;
  }

  /**
   * Batch write helper. Each operation: { type: 'set'|'update'|'delete', id, data?, options? }
   * Supabase does not have Firestore-style batches; operations are executed via Promise.all
   * in chunks to avoid overwhelming the connection pool.
   */
  async batchWrite(operations) {
    const chunks = this._chunk(operations, 100);

    for (const chunk of chunks) {
      await Promise.all(chunk.map(op => {
        if (op.type === 'set') {
          return supabase
            .from(this.table)
            .upsert({ ...op.data, id: op.id }, { onConflict: 'id' });
        }
        if (op.type === 'update') {
          return supabase
            .from(this.table)
            .update({ ...op.data, updated_at: this.serverTimestamp })
            .eq('id', op.id);
        }
        if (op.type === 'delete') {
          return supabase
            .from(this.table)
            .update({ deleted_at: this.serverTimestamp })
            .eq('id', op.id);
        }
        throw new Error(`[BaseRepository] Unknown batch op type: ${op.type}`);
      }));
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Map a Firestore-style condition operator to Supabase query builder method.
   */
  _applyCondition(query, field, op, value) {
    switch (op) {
      case '==':  return query.eq(field, value);
      case '!=':  return query.neq(field, value);
      case '>':   return query.gt(field, value);
      case '>=':  return query.gte(field, value);
      case '<':   return query.lt(field, value);
      case '<=':  return query.lte(field, value);
      case 'in':  return query.in(field, value);
      case 'array-contains': return query.contains(field, [value]);
      default:
        throw new Error(`[BaseRepository] Unsupported filter operator "${op}" on table "${this.table}"`);
    }
  }

  /**
   * Convert a Postgres row to the application layer.
   * snake_case → camelCase; Date objects → ISO strings.
   */
  _normalize(row) {
    if (!row) return null;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[camel]  = v instanceof Date ? v.toISOString() : v;
    }
    return out;
  }

  _chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

module.exports = { BaseRepository };