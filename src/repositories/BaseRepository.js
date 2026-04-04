'use strict';

const crypto = require('node:crypto');
const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class BaseRepository {
  constructor(tableName) {
    if (!tableName) {
      throw new Error('BaseRepository requires a table name');
    }

    this.table = tableName;
    this.db = supabase;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // READ
  // ───────────────────────────────────────────────────────────────────────────

  async findById(id, { includeDeleted = false } = {}) {
    if (!id) return null;

    let query = this.db
      .from(this.table)
      .select('*')
      .eq('id', id)
      .limit(1)
      .maybeSingle();

    if (!includeDeleted) {
      query = query.eq('soft_deleted', false);
    }

    const { data, error } = await query;

    this._throwDbError(error, 'findById', { id });
    return data ? this._normalize(data) : null;
  }

  async find(filters = [], options = {}) {
    const {
      includeDeleted = false,
      orderBy,
      limit,
    } = options;

    let query = this.db
      .from(this.table)
      .select('*', { count: 'exact' });

    if (!includeDeleted) {
      query = query.eq('soft_deleted', false);
    }

    for (const filter of filters) {
      query = this._applyFilter(
        query,
        filter.field,
        filter.op,
        filter.value
      );
    }

    if (orderBy?.field) {
      query = query.order(
        this._toSnakeKey(orderBy.field),
        { ascending: orderBy.direction !== 'desc' }
      );
    }

    if (Number.isInteger(limit) && limit > 0) {
      query = query.limit(limit);
    }

    const { data, error, count } = await query;

    this._throwDbError(error, 'find');

    return {
      docs: (data ?? []).map(row => this._normalize(row)),
      count: count ?? 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // WRITE
  // ───────────────────────────────────────────────────────────────────────────

  async create(data = {}, userId = 'system', docId = null) {
    const now = this._now();

    const payload = {
      ...this._toSnakeCase(data),
      id: docId || crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      created_by: userId,
      updated_by: userId,
      version: 1,
      status: 'active',
      soft_deleted: false,
    };

    const { data: inserted, error } = await this.db
      .from(this.table)
      .insert(payload)
      .select('*')
      .single();

    this._throwDbError(error, 'create');
    return this._normalize(inserted);
  }

  async update(id, updates = {}, userId = 'system') {
    if (!id) {
      throw new AppError(
        'Missing document id',
        400,
        { table: this.table },
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const current = await this.findById(id);

    if (!current) {
      throw new AppError(
        'Document not found',
        404,
        { id },
        ErrorCodes.NOT_FOUND
      );
    }

    const payload = {
      ...this._toSnakeCase(updates),
      updated_at: this._now(),
      updated_by: userId,
      version: Number(current.version ?? 1) + 1,
    };

    const { data: updated, error } = await this.db
      .from(this.table)
      .update(payload)
      .eq('id', id)
      .eq('soft_deleted', false)
      .select('*')
      .single();

    this._throwDbError(error, 'update', { id });
    return this._normalize(updated);
  }

  async softDelete(id, userId = 'system') {
    return this.update(
      id,
      {
        softDeleted: true,
        status: 'inactive',
      },
      userId
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  _applyFilter(query, field, op, value) {
    const dbField = this._toSnakeKey(field);

    switch (op) {
      case '==': return query.eq(dbField, value);
      case '!=': return query.neq(dbField, value);
      case '>': return query.gt(dbField, value);
      case '>=': return query.gte(dbField, value);
      case '<': return query.lt(dbField, value);
      case '<=': return query.lte(dbField, value);
      case 'in': return query.in(dbField, Array.isArray(value) ? value : [value]);
      case 'array-contains': return query.contains(dbField, [value]);
      default:
        logger.error('[BaseRepository] Unsupported filter operator', {
          table: this.table,
          field,
          dbField,
          op,
          valueType: typeof value,
        });

        throw new AppError(
          `Unsupported filter operator: ${op}`,
          400,
          { field, op, table: this.table },
          ErrorCodes.VALIDATION_ERROR
        );
    }
  }

  _normalize(row) {
    if (!row || typeof row !== 'object') return null;

    const out = {};

    for (const [key, value] of Object.entries(row)) {
      out[this._toCamelKey(key)] =
        value instanceof Date ? value.toISOString() : value;
    }

    return out;
  }

  _toSnakeCase(obj) {
    if (!obj || typeof obj !== 'object') return {};

    const out = {};

    for (const [key, value] of Object.entries(obj)) {
      out[this._toSnakeKey(key)] = value;
    }

    return out;
  }

  _toSnakeKey(key) {
    return String(key).replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
  }

  _toCamelKey(key) {
    return String(key).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  _now() {
    return new Date().toISOString();
  }

  _throwDbError(error, operation, meta = {}) {
    if (!error) return;

    logger.error(`[BaseRepository] ${operation} failed`, {
      table: this.table,
      ...meta,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    throw new AppError(
      `DB error in ${operation} [${this.table}]`,
      500,
      {
        table: this.table,
        ...meta,
        error: error.message,
      },
      ErrorCodes.INTERNAL_ERROR
    );
  }
}

module.exports = BaseRepository;