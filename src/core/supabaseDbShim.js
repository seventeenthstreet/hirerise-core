'use strict';

/**
 * src/core/supabaseDbShim.js
 *
 * Firestore-compatible shim over Supabase.
 *
 * Allows all existing modules that use the Firestore API style to keep working
 * without a full rewrite:
 *
 *   db.collection('users').doc(id).get()
 *   db.collection('users').where('status', '==', 'active').limit(10).get()
 *   db.collection('users').add({ name: 'Alice' })
 *   db.collectionGroup('jobs').where(...).count().get()
 *   db.runTransaction(async (tx) => { ... })
 *   db.batch()
 *
 * Also exports FieldValue and Timestamp stubs so callers do not crash at
 * require-time when those are destructured alongside `db`.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * TRANSLATION MAP
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  Firestore call                               Supabase equivalent
 *  ─────────────────────────────────────────── ────────────────────────────────
 *  collection(t).doc(id).get()                  from(t).select('*').eq('id',id).single()
 *  collection(t).doc(id).set(data)              from(t).upsert({id,...data})
 *  collection(t).doc(id).update(data)           from(t).update(data).eq('id',id)
 *  collection(t).doc(id).delete()               from(t).delete().eq('id',id)
 *  collection(t).add(data)                      from(t).insert(data).select().single()
 *  collection(t).where(f,op,v).get()            from(t).select('*').<op>(f,v)
 *  collection(t).where(...).count().get()       from(t).select('*',{count:'exact',head:true})
 *  collection(t).orderBy(f,dir).limit(n).get()  from(t).select('*').order(f).limit(n)
 *  collectionGroup(sub)                         Searches all tables named `sub`
 *  runTransaction(fn)                           Emulated (sequential, best-effort)
 *  batch()                                      Emulated (collected then flushed)
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * OPERATOR MAP
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  Firestore   Supabase builder method
 *  ───────── ─────────────────────────
 *  '=='      .eq(field, value)
 *  '!='      .neq(field, value)
 *  '<'       .lt(field, value)
 *  '<='      .lte(field, value)
 *  '>'       .gt(field, value)
 *  '>='      .gte(field, value)
 *  'in'      .in(field, value)          value must be an array
 *  'not-in'  .not(field, 'in', value)
 *  'array-contains'     .contains(field, value)
 *  'array-contains-any' .overlaps(field, value)
 */

const supabase = require('../../src/config/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a single Firestore-style where clause to a Supabase query builder.
 */
function applyWhere(query, field, operator, value) {
  switch (operator) {
    case '==':              return query.eq(field, value);
    case '!=':              return query.neq(field, value);
    case '<':               return query.lt(field, value);
    case '<=':              return query.lte(field, value);
    case '>':               return query.gt(field, value);
    case '>=':              return query.gte(field, value);
    case 'in':              return query.in(field, value);
    case 'not-in':          return query.not(field, 'in', value);
    case 'array-contains':  return query.contains(field, [value]);
    case 'array-contains-any': return query.overlaps(field, value);
    default:
      console.warn(`[supabaseDbShim] Unknown operator "${operator}" — skipping filter`);
      return query;
  }
}

/**
 * Wrap a raw Supabase response so it looks like a Firestore DocumentSnapshot.
 *
 *   snap.exists        → boolean
 *   snap.id            → string (the "id" column value)
 *   snap.data()        → plain object  (or null)
 *   snap.get(field)    → field value
 */
function makeDocSnap(row, id) {
  const _data = row || null;
  return {
    exists: !!_data,
    id: (id || _data?.id || null),
    data()       { return _data ? { ..._data } : null; },
    get(field)   { return _data?.[field]; },
  };
}

/**
 * Wrap an array of rows so it looks like a Firestore QuerySnapshot.
 *
 *   snap.empty      → boolean
 *   snap.size       → number
 *   snap.docs       → DocSnap[]
 *   snap.forEach()
 *   snap.data()     → { count } (for count queries)
 */
function makeQuerySnap(rows, countValue) {
  if (countValue !== undefined) {
    // count().get() path
    return {
      empty: countValue === 0,
      size:  countValue,
      docs:  [],
      forEach() {},
      data() { return { count: countValue }; },
    };
  }

  const docs = (rows || []).map((r) => makeDocSnap(r, r?.id));
  return {
    empty:   docs.length === 0,
    size:    docs.length,
    docs,
    forEach: (fn) => docs.forEach(fn),
    data()   { return docs[0]?.data() ?? null; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds up a Firestore-style fluent query, then executes it against Supabase
 * when .get() / .set() / .update() / .add() is called.
 *
 * @param {string} tableName   - Supabase table name
 * @param {string|null} docId  - if set, operations target a single row
 * @param {boolean} isGroup    - true when called from collectionGroup()
 */
function createQueryBuilder(tableName, docId = null, isGroup = false) {
  const _filters   = [];   // [{ field, operator, value }]
  let   _orderBy   = null; // { field, direction }
  let   _limit     = null;
  let   _startAfter = null;
  let   _isCount   = false;

  const builder = {
    // ── Chaining ───────────────────────────────────────────────────────────

    where(field, operator, value) {
      _filters.push({ field, operator, value });
      return builder;
    },

    orderBy(field, direction = 'asc') {
      _orderBy = { field, direction };
      return builder;
    },

    limit(n) {
      _limit = n;
      return builder;
    },

    startAfter(value) {
      _startAfter = value;
      return builder;
    },

    /** Mimics Firestore's .count() — call .get() after */
    count() {
      _isCount = true;
      return builder;
    },

    /**
     * Return a sub-collection builder.
     * Used in partitioned patterns:
     *   db.collection('automationJobs').doc(shard).collection('jobs').doc(id)
     */
    collection(subName) {
      return createQueryBuilder(subName, null, false);
    },

    /**
     * Return a document-scoped builder.
     * Calling .collection() on the result enables sub-collections.
     */
    doc(id) {
      return createQueryBuilder(tableName, id, isGroup);
    },

    // ── Terminal: READ ─────────────────────────────────────────────────────

    async get() {
      try {
        if (docId !== null) {
          // Single-document fetch
          const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq('id', docId)
            .single();

          if (error && error.code !== 'PGRST116') {
            // PGRST116 = "no rows returned" — that is not an error for us
            console.error(`[supabaseDbShim] get error on ${tableName}/${docId}:`, error.message);
          }

          return makeDocSnap(data || null, docId);
        }

        if (_isCount) {
          // count().get() — use Supabase's head + count
          let query = supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true });

          for (const { field, operator, value } of _filters) {
            query = applyWhere(query, field, operator, value);
          }

          const { count, error } = await query;

          if (error) {
            console.error(`[supabaseDbShim] count error on ${tableName}:`, error.message);
            return makeQuerySnap(null, 0);
          }

          return makeQuerySnap(null, count ?? 0);
        }

        // Collection query
        let query = supabase.from(tableName).select('*');

        for (const { field, operator, value } of _filters) {
          query = applyWhere(query, field, operator, value);
        }

        if (_orderBy) {
          query = query.order(_orderBy.field, {
            ascending: _orderBy.direction !== 'desc',
          });
        }

        if (_limit !== null) {
          query = query.limit(_limit);
        }

        const { data, error } = await query;

        if (error) {
          console.error(`[supabaseDbShim] query error on ${tableName}:`, error.message);
          return makeQuerySnap([]);
        }

        return makeQuerySnap(data || []);

      } catch (err) {
        console.error(`[supabaseDbShim] unexpected error in get():`, err);
        return docId !== null ? makeDocSnap(null, docId) : makeQuerySnap([]);
      }
    },

    // ── Terminal: WRITE ────────────────────────────────────────────────────

    async set(data, options = {}) {
      try {
        const payload = docId
          ? { id: docId, ...resolveFieldValues(data) }
          : resolveFieldValues(data);

        if (options.merge) {
          // upsert with merge → Supabase upsert (onConflict: 'id')
          const { error } = await supabase
            .from(tableName)
            .upsert(payload, { onConflict: 'id' });

          if (error) console.error(`[supabaseDbShim] set/merge error on ${tableName}:`, error.message);
          return;
        }

        // Full overwrite — delete + insert pattern, or just upsert
        const { error } = await supabase
          .from(tableName)
          .upsert(payload, { onConflict: 'id' });

        if (error) console.error(`[supabaseDbShim] set error on ${tableName}:`, error.message);

      } catch (err) {
        console.error(`[supabaseDbShim] unexpected error in set():`, err);
      }
    },

    async update(data) {
      try {
        if (!docId) {
          console.warn('[supabaseDbShim] update() called without a doc id — skipping');
          return;
        }

        const { error } = await supabase
          .from(tableName)
          .update(resolveFieldValues(data))
          .eq('id', docId);

        if (error) console.error(`[supabaseDbShim] update error on ${tableName}/${docId}:`, error.message);

      } catch (err) {
        console.error(`[supabaseDbShim] unexpected error in update():`, err);
      }
    },

    async add(data) {
      try {
        const { data: inserted, error } = await supabase
          .from(tableName)
          .insert(resolveFieldValues(data))
          .select()
          .single();

        if (error) {
          console.error(`[supabaseDbShim] add error on ${tableName}:`, error.message);
          return { id: null };
        }

        // Return a ref-like object (callers use .id)
        return { id: inserted?.id ?? null };

      } catch (err) {
        console.error(`[supabaseDbShim] unexpected error in add():`, err);
        return { id: null };
      }
    },

    async delete() {
      try {
        if (!docId) {
          console.warn('[supabaseDbShim] delete() called without a doc id — skipping');
          return;
        }

        const { error } = await supabase
          .from(tableName)
          .delete()
          .eq('id', docId);

        if (error) console.error(`[supabaseDbShim] delete error on ${tableName}/${docId}:`, error.message);

      } catch (err) {
        console.error(`[supabaseDbShim] unexpected error in delete():`, err);
      }
    },
  };

  return builder;
}

// ─────────────────────────────────────────────────────────────────────────────
// FieldValue Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively resolve FieldValue sentinels inside a data payload.
 * This prevents raw sentinel objects from being written to Supabase.
 */
function resolveFieldValues(data) {
  if (!data || typeof data !== 'object') return data;

  const resolved = {};
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === 'object') {
      if (val.__isServerTimestamp) {
        resolved[key] = new Date().toISOString();
      } else if (val.__increment !== undefined) {
        // We cannot do atomic increments without the current value here.
        // Store the sentinel; the caller is responsible for handling it,
        // or it will be stored as a plain object (harmless for crash prevention).
        // In a full migration you would use a Postgres RPC / .rpc('increment', ...).
        resolved[key] = val; // pass through — at least it won't crash
      } else if (val.__arrayUnion) {
        resolved[key] = val.__arrayUnion; // stored as array, merge logic is app-level
      } else if (val.__arrayRemove) {
        resolved[key] = null; // best-effort
      } else {
        resolved[key] = val;
      }
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction Emulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight transaction emulator.
 *
 * Firestore transactions guarantee read-then-write atomicity.
 * Supabase requires Postgres RPCs or advisory locks for the same guarantee.
 *
 * For crash-prevention purposes this emulates the *API shape* so existing
 * code does not crash. Atomic consistency is a phase-2 concern.
 */
async function runTransaction(updateFn) {
  const tx = {
    async get(ref) {
      return ref.get();
    },
    set(ref, data, options)  { return ref.set(data, options); },
    update(ref, data)        { return ref.update(data); },
    delete(ref)              { return ref.delete(); },
  };

  return updateFn(tx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Emulation
// ─────────────────────────────────────────────────────────────────────────────

function createBatch() {
  const _ops = [];

  return {
    set(ref, data, options)  { _ops.push({ type: 'set',    ref, data, options }); },
    update(ref, data)        { _ops.push({ type: 'update', ref, data }); },
    delete(ref)              { _ops.push({ type: 'delete', ref }); },

    async commit() {
      for (const op of _ops) {
        try {
          if (op.type === 'set')    await op.ref.set(op.data, op.options ?? {});
          else if (op.type === 'update') await op.ref.update(op.data);
          else if (op.type === 'delete') await op.ref.delete();
        } catch (err) {
          console.error('[supabaseDbShim] batch op failed:', err);
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// db object
// ─────────────────────────────────────────────────────────────────────────────

const db = {
  /**
   * db.collection('tableName')
   * Returns a query builder scoped to `tableName`.
   */
  collection(name) {
    return createQueryBuilder(name);
  },

  /**
   * db.collectionGroup('subCollection')
   *
   * In Firestore this queries across ALL sub-collections with the given name.
   * In Supabase we treat it as a direct table query — callers must ensure the
   * denormalised table (e.g. `jobs`) exists and contains the expected columns.
   */
  collectionGroup(name) {
    return createQueryBuilder(name, null, true);
  },

  /**
   * db.runTransaction(async (tx) => { ... })
   */
  runTransaction,

  /**
   * db.batch()
   */
  batch: createBatch,
};

// ─────────────────────────────────────────────────────────────────────────────
// FieldValue stubs
// ─────────────────────────────────────────────────────────────────────────────

const FieldValue = {
  /**
   * Returns an ISO string that resolveFieldValues() writes as a timestamp.
   * The sentinel object is also tagged so resolveFieldValues can detect it.
   */
  serverTimestamp() {
    const sentinel = new String(new Date().toISOString()); // eslint-disable-line no-new-wrappers
    sentinel.__isServerTimestamp = true;
    return sentinel;
  },

  /**
   * Returns a sentinel object. resolveFieldValues passes it through.
   * In a fully migrated service, replace with a Postgres RPC increment call.
   */
  increment(n) {
    return { __increment: n };
  },

  /**
   * Returns the items as a plain array (best-effort union).
   */
  arrayUnion(...items) {
    return { __arrayUnion: items.flat() };
  },

  /**
   * Returns a sentinel for array removal (best-effort).
   */
  arrayRemove(...items) {
    return { __arrayRemove: items.flat() };
  },

  /**
   * Sentinel for deleteField() — omit the key when detected.
   */
  delete() {
    return { __deleteField: true };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp stubs
// ─────────────────────────────────────────────────────────────────────────────

class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds     = seconds;
    this.nanoseconds = nanoseconds;
  }

  toDate() {
    return new Date(this.seconds * 1000);
  }

  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }

  toISOString() {
    return this.toDate().toISOString();
  }

  static now() {
    return Timestamp.fromDate(new Date());
  }

  static fromDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return new Timestamp(Math.floor(d.getTime() / 1000), (d.getTime() % 1000) * 1e6);
  }

  static fromMillis(ms) {
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  db,
  FieldValue,
  Timestamp,
  // convenience re-export so callers that do `require(...).supabase` also work
  supabase,
};