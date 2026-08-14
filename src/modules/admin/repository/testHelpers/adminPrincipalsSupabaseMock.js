'use strict';

/**
 * Minimal in-memory fake of the Supabase query builder, scoped to exactly
 * the chains adminPrincipal.repository.js issues against admin_principals:
 *   .from(T).select('*').eq(col,val).maybeSingle()
 *   .from(T).select(cols).eq(col,val).order(col,opts).limit(n)
 *   .from(T).insert(row)
 *   .from(T).update(patch).eq(col,val)
 *
 * Not a general-purpose Supabase mock — deliberately small.
 */
function createAdminPrincipalsSupabaseMock(initialRows = []) {
  let rows = initialRows.map((r) => ({ ...r }));

  function matches(row, filters) {
    return filters.every(([col, val]) => row[col] === val);
  }

  function from(table) {
    const filters = [];
    let mode = null; // 'select' | 'insert' | 'update'
    let payload = null;

    const builder = {
      select() {
        mode = 'select';
        return builder;
      },
      insert(row) {
        mode = 'insert';
        payload = row;
        // insert() with no further chain must itself be awaitable.
        rows.push({ ...row });
        return Promise.resolve({ data: [{ ...row }], error: null });
      },
      update(patch) {
        mode = 'update';
        payload = patch;
        return builder;
      },
      eq(col, val) {
        filters.push([col, val]);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n) {
        return builder.then((res) => ({ ...res, data: res.data.slice(0, n) }));
      },
      maybeSingle() {
        const found = rows.find((r) => matches(r, filters)) || null;
        return Promise.resolve({ data: found ? { ...found } : null, error: null });
      },
      then(resolve, reject) {
        // Terminal resolution for update() and bare select() (no maybeSingle/limit).
        if (mode === 'update') {
          rows = rows.map((r) =>
            matches(r, filters) ? { ...r, ...payload } : r
          );
          const updated = rows.filter((r) => matches(r, filters));
          return Promise.resolve({ data: updated, error: null }).then(resolve, reject);
        }
        if (mode === 'select') {
          const found = rows.filter((r) => matches(r, filters));
          return Promise.resolve({ data: found, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };

    return builder;
  }

  return {
    from,
    __getRows: () => rows.map((r) => ({ ...r })),
    __setRows: (next) => {
      rows = next.map((r) => ({ ...r }));
    },
  };
}

module.exports = { createAdminPrincipalsSupabaseMock };
