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
 *
 * WP-ADMIN-04F-02 — Permission Repository: additively extended with
 * `.update()`, `.delete()`, and `.or()` (simple `field.ilike.%term%,...`
 * clauses only), plus DB-default-style `id`/`created_at`/`updated_at`
 * autofill on `.insert()`, because src/domain/permission/repository/
 * permission.repository.js exercises those and no existing repository
 * test needed them yet. Every prior method's behavior is unchanged, so
 * this remains a backward-compatible addition to the one shared fake
 * rather than a second, duplicated query-builder mock — per this WP's
 * own "reuse existing implementations, do not duplicate infrastructure"
 * audit requirement, applied to test infrastructure as much as
 * application code.
 */

let _mockIdCounter = 0;
function nextMockId() {
  _mockIdCounter += 1;
  return `mock-id-${_mockIdCounter}`;
}

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
    this._orFilterGroups = [];
    this._updatePayload = null;
    this._isDelete = false;
  }

  select(_columns, opts) {
    if (opts && opts.count) {
      this._countRequested = true;
    }
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

  /**
   * Supports the subset PermissionRepository.search() (and
   * adminCmsSkills.repository.js before it) actually issues:
   * `"field1.ilike.%term%,field2.ilike.%term%"` — comma-separated
   * `field.ilike.%value%` clauses, OR'd together. Any single clause
   * matching makes the row eligible (still AND'd with whatever `.eq()`
   * filters are also present on this query, matching real PostgREST
   * `.or()` semantics of combining with prior filters).
   */
  or(orExpression) {
    const clauses = String(orExpression)
      .split(',')
      .map((clause) => clause.trim())
      .filter(Boolean)
      .map((clause) => {
        const [field, op, ...rest] = clause.split('.');
        return { field, op, value: rest.join('.') };
      });
    this._orFilterGroups.push(clauses);
    return this;
  }

  update(payload) {
    this._updatePayload = payload;
    return this;
  }

  delete() {
    this._isDelete = true;
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
    // Autofills what a real Postgres/Supabase table default would supply,
    // so callers of methods like PermissionRepository.create() (which
    // insert a row without an id/timestamps and expect them back) get a
    // realistic row shape back, same as a live table would return.
    const now = new Date().toISOString();
    this._insertedRow = {
      id: nextMockId(),
      created_at: now,
      updated_at: now,
      ...payload,
    };
    this._rows.push(this._insertedRow);
    return this;
  }

  _matchOrGroups(row) {
    if (this._orFilterGroups.length === 0) return true;
    return this._orFilterGroups.every((clauses) =>
      clauses.some(({ field, op, value }) => {
        const actual = row[field];
        if (op === 'ilike') {
          const pattern = String(value).replace(/^%|%$/g, '');
          return typeof actual === 'string' && actual.toLowerCase().includes(pattern.toLowerCase());
        }
        return matchesFilter(row, { field, op: op === 'eq' ? 'eq' : op, value });
      })
    );
  }

  _resolve() {
    if (this._forcedError) {
      return { data: null, error: this._forcedError, count: 0 };
    }

    if (this._insertedRow && !this._updatePayload && !this._isDelete) {
      return { data: this._insertedRow, error: null, count: 1 };
    }

    let matched = this._rows.filter(
      (row) => this._filters.every((f) => matchesFilter(row, f)) && this._matchOrGroups(row)
    );

    if (this._updatePayload) {
      matched.forEach((row) => Object.assign(row, this._updatePayload));
    }

    if (this._isDelete) {
      matched.forEach((row) => {
        const idx = this._rows.indexOf(row);
        if (idx !== -1) this._rows.splice(idx, 1);
      });
    }

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
