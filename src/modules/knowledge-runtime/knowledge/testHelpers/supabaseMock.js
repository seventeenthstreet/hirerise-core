'use strict';

/**
 * modules/knowledge-runtime/knowledge/__tests__/testUtils/supabaseMock.js
 *
 * Minimal in-memory fake of the subset of the Supabase query-builder API
 * that `repositories/BaseRepository.js` exercises: chainable filters
 * (.eq/.neq/.gt/.gte/.lt/.lte/.in/.contains/.is/.not), .select(), .order(),
 * .limit(), .maybeSingle(), .insert().select().single(), and thenable
 * resolution (`await query`).
 *
 * Not a general-purpose Supabase mock — scoped to what BaseRepository's
 * `findById`/`find` actually call, so repository tests can exercise real
 * KnowledgeRepository -> BaseRepository code paths without a live database.
 */

function matchesFilter(row, { field, op, value }) {
  const actual = row[field];

  switch (op) {
    case 'eq':
      return actual === value;
    case 'neq':
      return actual !== value;
    case 'gt':
      return actual > value;
    case 'gte':
      return actual >= value;
    case 'lt':
      return actual < value;
    case 'lte':
      return actual <= value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'contains':
      return Array.isArray(actual) && value.every((v) => actual.includes(v));
    case 'is':
      return value === null ? actual === null || actual === undefined : actual === value;
    case 'not_is':
      return !(actual === null || actual === undefined);
    default:
      throw new Error(`Unsupported mock filter op: ${op}`);
  }
}

class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows;
    this._filters = [];
    this._orderBy = null;
    this._limitN = null;
    this._single = false;
    this._forcedError = null;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this._filters.push({ field, op: 'eq', value });
    return this;
  }

  neq(field, value) {
    this._filters.push({ field, op: 'neq', value });
    return this;
  }

  gt(field, value) {
    this._filters.push({ field, op: 'gt', value });
    return this;
  }

  gte(field, value) {
    this._filters.push({ field, op: 'gte', value });
    return this;
  }

  lt(field, value) {
    this._filters.push({ field, op: 'lt', value });
    return this;
  }

  lte(field, value) {
    this._filters.push({ field, op: 'lte', value });
    return this;
  }

  in(field, value) {
    this._filters.push({ field, op: 'in', value });
    return this;
  }

  contains(field, value) {
    this._filters.push({ field, op: 'contains', value });
    return this;
  }

  is(field, value) {
    this._filters.push({ field, op: 'is', value });
    return this;
  }

  not(field) {
    this._filters.push({ field, op: 'not_is' });
    return this;
  }

  order(field, { ascending = true } = {}) {
    this._orderBy = { field, ascending };
    return this;
  }

  limit(n) {
    this._limitN = n;
    return this;
  }

  range() {
    return this;
  }

  maybeSingle() {
    this._single = true;
    return this;
  }

  single() {
    this._single = true;
    return this;
  }

  insert(payload) {
    this._insertedRow = payload;
    this._rows.push(payload);
    return this;
  }

  _resolve() {
    if (this._forcedError) {
      return { data: null, error: this._forcedError, count: 0 };
    }

    if (this._insertedRow) {
      return { data: this._insertedRow, error: null, count: 1 };
    }

    let matched = this._rows.filter((row) =>
      this._filters.every((f) => matchesFilter(row, f))
    );

    if (this._orderBy) {
      const { field, ascending } = this._orderBy;
      matched = [...matched].sort((a, b) => {
        if (a[field] === b[field]) return 0;
        const cmp = a[field] > b[field] ? 1 : -1;
        return ascending ? cmp : -cmp;
      });
    }

    if (this._limitN != null) {
      matched = matched.slice(0, this._limitN);
    }

    if (this._single) {
      return { data: matched[0] ?? null, error: null, count: matched.length };
    }

    return { data: matched, error: null, count: matched.length };
  }

  then(resolve, reject) {
    return Promise.resolve(this._resolve()).then(resolve, reject);
  }
}

/**
 * @param {Record<string, object[]>} tables — tableName -> array of raw
 *   (snake_case) rows, matching what a real Supabase table would return.
 */
function createSupabaseMock(tables = {}) {
  return {
    from(table) {
      const rows = tables[table] ?? [];
      return new FakeQueryBuilder(rows);
    },
  };
}

module.exports = { createSupabaseMock, FakeQueryBuilder };
