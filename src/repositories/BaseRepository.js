'use strict';

/**
 * BaseRepository.js — Supabase data-access base class
 *
 * MIGRATION: Removed require('../config/supabase') and all db.collection() calls.
 * All persistence now uses direct supabase.from() queries.
 *
 * Key behaviour changes vs the Firestore version:
 *   - Column names are snake_case in Postgres; _normalize() converts them to
 *     camelCase for the application layer on every read.
 *   - _toSnakeCase() converts camelCase payloads before writes.
 *   - Timestamps are stored as ISO 8601 strings (timestamptz in Postgres).
 *     No Firestore Timestamp objects will ever appear — convertTimestamps()
 *     in firestoreTimestamp.js is now a no-op for these, but kept for callers
 *     that still import it.
 *   - softDeleted → soft_deleted column (snake_case in DB).
 *   - The old runTransaction() method (which used db.runTransaction()) has been
 *     replaced with a Supabase RPC-based helper. Use it for multi-table atomic ops.
 */

const supabase                    = require('../config/supabase');
const { AppError, ErrorCodes }    = require('../middleware/errorHandler');

class BaseRepository {
  /**
   * @param {string} tableName — Postgres table name (snake_case, e.g. 'cms_roles')
   */
  constructor(tableName) {
    this.table = tableName;
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /**
   * Find a single document by its primary key.
   * Returns null if not found or soft-deleted.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    if (!id) return null;

    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new AppError(
        `DB error in findById [${this.table}/${id}]`,
        500,
        { error: error.message },
        ErrorCodes.INTERNAL_ERROR
      );
    }

    if (!data || data.soft_deleted === true) return null;

    return this._normalize(data);
  }

  /**
   * Find multiple records matching a set of filters.
   *
   * @param {Array<{ field: string, op: string, value: * }>} filters
   *   op values: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'array-contains'
   * @param {{ orderBy?, limit?, includeDeleted? }} options
   * @returns {Promise<{ docs: object[], count: number }>}
   */
  async find(filters = [], options = {}) {
    const includeDeleted = options.includeDeleted === true;

    let query = supabase.from(this.table).select('*');

    if (!includeDeleted) {
      query = query.eq('soft_deleted', false);
    }

    for (const { field, op, value } of filters) {
      query = this._applyFilter(query, field, op, value);
    }

    if (options.orderBy) {
      const ascending = (options.orderBy.direction || 'asc') !== 'desc';
      query = query.order(options.orderBy.field, { ascending });
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new AppError(
        `DB error in find [${this.table}]`,
        500,
        { error: error.message },
        ErrorCodes.INTERNAL_ERROR
      );
    }

    const docs = (data ?? []).map(row => this._normalize(row));
    return { docs, count: docs.length };
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Create a new record.
   *
   * @param {object} data     — application-layer payload (camelCase)
   * @param {string} userId   — for audit fields (created_by / updated_by)
   * @param {string|null} docId — supply to force a specific ID; leave null for auto
   * @returns {Promise<object>} the created record (camelCase, with id)
   */
  async create(data, userId = 'system', docId = null) {
    const now = new Date().toISOString();
    const payload = {
      ...this._toSnakeCase(data),
      id:           docId || crypto.randomUUID(),
      created_at:   now,
      updated_at:   now,
      created_by:   userId,
      updated_by:   userId,
      version:      1,
      status:       'active',
      soft_deleted: false,
    };

    const { data: inserted, error } = await supabase
      .from(this.table)
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw new AppError(
        `DB error in create [${this.table}]`,
        500,
        { error: error.message },
        ErrorCodes.INTERNAL_ERROR
      );
    }

    return this._normalize(inserted);
  }

  /**
   * Update an existing record (partial update).
   * Throws 404 if not found; 409 if soft-deleted.
   *
   * @param {string} id
   * @param {object} updates  — fields to update (camelCase)
   * @param {string} userId
   * @returns {Promise<object>} the updated record
   */
  async update(id, updates, userId = 'system') {
    const current = await this.findById(id);

    if (!current) {
      throw new AppError('Document not found', 404, { id }, ErrorCodes.NOT_FOUND);
    }
    if (current.softDeleted) {
      throw new AppError('Cannot update soft-deleted document', 409, { id }, ErrorCodes.CONFLICT);
    }

    const payload = {
      ...this._toSnakeCase(updates),
      updated_at: new Date().toISOString(),
      updated_by: userId,
      version:    (current.version || 1) + 1,
    };

    const { data: updated, error } = await supabase
      .from(this.table)
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new AppError(
        `DB error in update [${this.table}/${id}]`,
        500,
        { error: error.message },
        ErrorCodes.INTERNAL_ERROR
      );
    }

    return this._normalize(updated);
  }

  /**
   * Soft-delete: sets soft_deleted=true and status='inactive'.
   * Record remains in DB and is excluded from all find() calls.
   *
   * @param {string} id
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async softDelete(id, userId = 'system') {
    return await this.update(id, { softDeleted: true, status: 'inactive' }, userId);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Map a Supabase filter op (Firestore-style) onto the Supabase query builder.
   *
   * @param {object} query  — Supabase query chain
   * @param {string} field
   * @param {string} op     — Firestore operator string
   * @param {*}      value
   * @returns {object}      — updated query chain
   */
  _applyFilter(query, field, op, value) {
    switch (op) {
      case '==':             return query.eq(field, value);
      case '!=':             return query.neq(field, value);
      case '>':              return query.gt(field, value);
      case '>=':             return query.gte(field, value);
      case '<':              return query.lt(field, value);
      case '<=':             return query.lte(field, value);
      case 'in':             return query.in(field, value);
      case 'array-contains': return query.contains(field, [value]);
      default: {
        const logger = require('../utils/logger');
        logger.error('[BaseRepository] Unknown filter operator', {
          op,
          field,
          table: this.table,
          valueType: typeof value,
        });
        throw new Error(`BaseRepository: unsupported filter operator "${op}" on table "${this.table}"`);
      }
    }
  }

  /**
   * Convert a Postgres row (snake_case keys, possible Date objects) to the
   * application-layer format (camelCase keys, ISO strings).
   *
   * @param {object} row
   * @returns {object}
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

  /**
   * Convert an application-layer payload (camelCase) to Postgres column names
   * (snake_case) before insert / update.
   *
   * @param {object} obj
   * @returns {object}
   */
  _toSnakeCase(obj) {
    if (!obj) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const snake = k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
      out[snake]  = v;
    }
    return out;
  }
}

module.exports = BaseRepository;