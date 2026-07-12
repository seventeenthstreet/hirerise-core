'use strict';

/**
 * shared/repositories/__tests__/testHelpers/supabaseMock.js
 *
 * Minimal in-memory fake of the subset of the Supabase query-builder API
 * that PartitionedJobRepository (shared/repositories/partitioned-jobs.repository.js)
 * exercises: `.from(table).insert(row)`, `.select().eq().in().is().order()
 * .limit().maybeSingle()`, and `.rpc(name, args)`.
 *
 * Not a general-purpose Supabase mock. In particular this fake DOES enforce
 * a fixed column allowlist per table on `.insert()`, on purpose: real
 * PostgREST rejects unknown columns with a PGRST204 error ("Could not find
 * the 'X' column ... in the schema cache"), and that behavior is exactly
 * what exposed the createJob defect this test suite guards against. A mock
 * that silently accepted any key would hide that class of regression.
 */

function matchesFilter(row, { field, op, value }) {
  const actual = row[field];

  switch (op) {
    case 'eq':
      return actual === value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'is':
      return value === null ? actual === null || actual === undefined : actual === value;
    default:
      throw new Error(`Unsupported mock filter op: ${op}`);
  }
}

class FakeQueryBuilder {
  constructor(table, state) {
    this._table = table;
    this._state = state;
    this._filters = [];
    this._orderBy = null;
    this._limitN = null;
    this._wantSingle = false;
    this._pendingInsert = null;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this._filters.push({ field, op: 'eq', value });
    return this;
  }

  in(field, value) {
    this._filters.push({ field, op: 'in', value });
    return this;
  }

  is(field, value) {
    this._filters.push({ field, op: 'is', value });
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

  maybeSingle() {
    this._wantSingle = true;
    return this;
  }

  insert(row) {
    this._pendingInsert = row;
    return this;
  }

  _rows() {
    return this._state.tables[this._table] || [];
  }

  _runSelect() {
    let rows = this._rows().filter((row) =>
      this._filters.every((f) => matchesFilter(row, f))
    );

    if (this._orderBy) {
      const { field, ascending } = this._orderBy;
      rows = [...rows].sort((a, b) =>
        ascending ? (a[field] > b[field] ? 1 : -1) : (a[field] < b[field] ? 1 : -1)
      );
    }

    if (this._limitN != null) {
      rows = rows.slice(0, this._limitN);
    }

    if (this._wantSingle) {
      return { data: rows[0] ?? null, error: null };
    }

    return { data: rows, error: null };
  }

  _runInsert() {
    const allowedColumns = this._state.schemas[this._table];

    if (allowedColumns) {
      const unknown = Object.keys(this._pendingInsert).filter(
        (key) => !allowedColumns.includes(key)
      );

      if (unknown.length > 0) {
        return {
          data: null,
          error: {
            code: 'PGRST204',
            message: `Could not find the '${unknown[0]}' column of '${this._table}' in the schema cache`,
          },
        };
      }
    }

    this._state.tables[this._table] = this._rows();
    this._state.tables[this._table].push({ ...this._pendingInsert });

    return { data: { id: this._pendingInsert.id }, error: null };
  }

  then(resolve, reject) {
    try {
      const result = this._pendingInsert ? this._runInsert() : this._runSelect();
      resolve(result);
    } catch (err) {
      reject ? reject(err) : Promise.reject(err);
    }
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.tables]  — initial rows keyed by table name
 * @param {object} [options.schemas] — allowed insert columns keyed by table
 *   name; omit a table here to skip column validation for it.
 * @param {object} [options.rpc]     — { [rpcName]: (args) => ({ data, error }) }
 */
function createSupabaseMock({ tables = {}, schemas = {}, rpc = {} } = {}) {
  const state = {
    tables: Object.fromEntries(
      Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))])
    ),
    schemas,
  };

  return {
    from(table) {
      return new FakeQueryBuilder(table, state);
    },
    async rpc(name, args) {
      const handler = rpc[name];
      if (!handler) {
        throw new Error(`Mock rpc handler not configured for: ${name}`);
      }
      return handler(args);
    },
    __state: state,
  };
}

module.exports = { createSupabaseMock };