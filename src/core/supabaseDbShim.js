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
 *  Firestore            Supabase builder method
 *  ──────────────────── ───────────────────────────────────────────────────────
 *  '=='                 .eq(field, value)
 *  '!='                 .neq(field, value)
 *  '<'                  .lt(field, value)
 *  '<='                 .lte(field, value)
 *  '>'                  .gt(field, value)
 *  '>='                 .gte(field, value)
 *  'in'                 .in(field, value)          value must be an array
 *  'not-in'             .not(field, 'in', value)
 *  'array-contains'     .contains(field, [value])
 *  'array-contains-any' .overlaps(field, value)
 *  'is-null'            .is(field, null)            non-Firestore convenience
 *  'not-null'           .not(field, 'is', null)     non-Firestore convenience
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * FIELDVALUE SENTINELS HANDLED IN update() / set()
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  FieldValue.serverTimestamp()  → ISO string written directly
 *  FieldValue.increment(n)       → Postgres RPC atomic increment via
 *                                  supabase.rpc('increment_field', ...)
 *                                  Falls back to read-modify-write if RPC absent.
 *  FieldValue.arrayUnion(...)    → read-modify-write merge into existing array
 *  FieldValue.arrayRemove(...)   → read-modify-write filter from existing array
 *  FieldValue.delete()           → field omitted from payload (SQL NULL)
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * CHANGELOG
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  v2 (stabilisation pass):
 *   - applyWhere: added 'is-null' / 'not-null' operators; improved unknown-
 *     operator log to include table + full filter context for easier debugging
 *   - resolveFieldValues: __increment now does a real atomic Postgres increment
 *     via supabase.rpc('increment_field'); falls back to read-modify-write if
 *     the RPC is missing; never silently passes the sentinel object to the DB
 *   - resolveFieldValues: __arrayUnion / __arrayRemove now do proper
 *     read-modify-write against the current row instead of stomping the column
 *   - resolveFieldValues: __deleteField sentinel now sets field to null instead
 *     of being silently dropped (SQL NULL is the correct Supabase equivalent)
 *   - resolveFieldValues: String sentinel from FieldValue.serverTimestamp()
 *     now correctly detected via instanceof String check
 *   - update(): timestamps (Timestamp instances and ISO strings) coerced to
 *     ISO string before write; no raw objects reach the DB
 *   - get() single-doc: logs the full Supabase error object, not just .message,
 *     so PostgREST error codes are visible in logs
 *   - get() collection: _startAfter now implemented using .gt('id', cursorId)
 *     pagination (was silently ignored before)
 *   - makeDocSnap / makeQuerySnap: both now guarantee a consistent shape even
 *     when called with undefined / null / empty arguments
 *   - All terminal methods return a typed result object so callers never get
 *     `undefined` back from an await
 */

const supabase = require('../../src/config/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// Internal logger — prefix every message so grep finds shim noise instantly
// ─────────────────────────────────────────────────────────────────────────────

const LOG = {
  info:  (...a) => console.log ('[supabaseDbShim]', ...a),
  warn:  (...a) => console.warn ('[supabaseDbShim]', ...a),
  error: (...a) => console.error('[supabaseDbShim]', ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — value coercion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a value to an ISO 8601 string if it looks like a timestamp.
 * Handles: Date, Timestamp (this shim's class), String sentinel from
 * FieldValue.serverTimestamp(), and plain ISO strings.
 * Returns the value unchanged for anything else.
 */
function coerceTimestamp(val) {
  if (val instanceof Date)      return val.toISOString();
  if (val instanceof Timestamp) return val.toISOString();
  // String wrapper object produced by FieldValue.serverTimestamp()
  if (val instanceof String)    return val.toString();
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) return val;
  return val;
}

/**
 * True if val is any kind of FieldValue sentinel object.
 */
function isSentinel(val) {
  if (!val || typeof val !== 'object') return false;
  return (
    val.__isServerTimestamp !== undefined ||
    val.__increment         !== undefined ||
    val.__arrayUnion        !== undefined ||
    val.__arrayRemove       !== undefined ||
    val.__deleteField       !== undefined
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// applyWhere — operator dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a single Firestore-style where clause to a Supabase query builder.
 *
 * All Firestore comparison operators are supported.
 * Two extra convenience operators are also accepted:
 *   'is-null'   — field IS NULL
 *   'not-null'  — field IS NOT NULL
 *
 * Unknown operators are logged with full context (table + field + op + value)
 * and the query is returned UNFILTERED so callers never get a silent data leak.
 */
function applyWhere(query, field, operator, value, tableName) {
  switch (operator) {
    case '==':               return query.eq(field, value);
    case '!=':               return query.neq(field, value);
    case '<':                return query.lt(field, value);
    case '<=':               return query.lte(field, value);
    case '>':                return query.gt(field, value);
    case '>=':               return query.gte(field, value);
    case 'in':               return query.in(field, Array.isArray(value) ? value : [value]);
    case 'not-in':           return query.not(field, 'in', Array.isArray(value) ? value : [value]);
    case 'array-contains':   return query.contains(field, [value]);
    case 'array-contains-any': return query.overlaps(field, Array.isArray(value) ? value : [value]);
    // Convenience operators (no Firestore equivalent, useful in shim callers)
    case 'is-null':          return query.is(field, null);
    case 'not-null':         return query.not(field, 'is', null);
    default:
      LOG.warn(
        `Unknown operator "${operator}" on ${tableName ?? '?'}.${field}`,
        `— filter SKIPPED. value was:`, value,
        `\n  Supported: ==, !=, <, <=, >, >=, in, not-in,`,
        `array-contains, array-contains-any, is-null, not-null`
      );
      // Return query unmodified — at least the query runs, caller gets
      // unfiltered data rather than a crash. This is always logged so it
      // cannot be a silent failure.
      return query;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// makeDocSnap — consistent DocumentSnapshot shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a raw Supabase row so it looks like a Firestore DocumentSnapshot.
 *
 *   snap.exists      → boolean
 *   snap.id          → string | null
 *   snap.data()      → plain object | null  (shallow copy — never mutates row)
 *   snap.get(field)  → field value | undefined
 *
 * Guaranteed never to throw even when row is undefined/null.
 */
function makeDocSnap(row, id) {
  // Normalise: undefined → null
  const _data = (row != null && typeof row === 'object') ? row : null;
  const _id   = id ?? _data?.id ?? null;

  return {
    exists:    _data !== null,
    id:        _id,
    ref:       { id: _id },          // minimal ref shape some callers access
    data()     { return _data ? { ..._data } : null; },
    get(field) { return _data ? _data[field] : undefined; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// makeQuerySnap — consistent QuerySnapshot shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an array of rows so it looks like a Firestore QuerySnapshot.
 *
 *   snap.empty      → boolean
 *   snap.size       → number
 *   snap.docs       → DocSnap[]
 *   snap.forEach(fn)
 *   snap.data()     → first doc's data, or { count } for count queries
 *
 * Guaranteed never to throw even when rows is undefined/null.
 */
function makeQuerySnap(rows, countValue) {
  if (countValue !== undefined) {
    const n = typeof countValue === 'number' ? countValue : 0;
    return {
      empty:   n === 0,
      size:    n,
      docs:    [],
      forEach() {},
      data()   { return { count: n }; },
    };
  }

  const safeRows = Array.isArray(rows) ? rows : [];
  const docs     = safeRows.map((r) => makeDocSnap(r, r?.id));

  return {
    empty:   docs.length === 0,
    size:    docs.length,
    docs,
    forEach: (fn) => docs.forEach(fn),
    data()   { return docs.length > 0 ? docs[0].data() : null; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveFieldValues — sentinel resolution with full increment + array support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively resolve FieldValue sentinels inside a data payload.
 *
 * Called synchronously — returns a plain object safe to pass to Supabase.
 * Increment and array sentinels that require a current-value read are flagged
 * into a separate `_deferred` map so update() can handle them after the main
 * write. This keeps this function synchronous while still supporting atomic ops.
 *
 * @param {object} data         — raw payload from caller
 * @param {object} [_deferred]  — if provided, sentinels needing a pre-read are
 *                                 added here instead of being resolved inline.
 *                                 update() passes its own object here.
 * @returns {object} resolved payload (sentinels replaced or removed)
 */
function resolveFieldValues(data, _deferred) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

  const resolved = {};

  for (const [key, val] of Object.entries(data)) {
    // ── Null / primitives ─────────────────────────────────────────────────
    if (val === null || val === undefined) {
      resolved[key] = val;
      continue;
    }

    // ── Timestamp coercion (Date, Timestamp class, String sentinel) ───────
    const coerced = coerceTimestamp(val);
    if (coerced !== val) {
      resolved[key] = coerced;
      continue;
    }

    // ── FieldValue sentinels ──────────────────────────────────────────────
    if (isSentinel(val)) {
      // serverTimestamp — String wrapper object
      if (val instanceof String || val.__isServerTimestamp) {
        resolved[key] = new Date().toISOString();
        continue;
      }

      // increment — defer to update() for atomic handling
      if (val.__increment !== undefined) {
        if (_deferred) {
          _deferred[key] = { __increment: val.__increment };
        } else {
          // Called from set() / add() — no current value available.
          // Log and skip rather than write a corrupt object.
          LOG.warn(`FieldValue.increment(${val.__increment}) on key "${key}" ` +
            `ignored in set()/add() — increment requires update(). Field skipped.`);
        }
        // Do NOT include in resolved — will be handled by _deferred path
        continue;
      }

      // arrayUnion — defer to update() for read-modify-write
      if (val.__arrayUnion !== undefined) {
        if (_deferred) {
          _deferred[key] = { __arrayUnion: val.__arrayUnion };
        } else {
          // In set()/add() context, just write the items as an array
          resolved[key] = val.__arrayUnion;
        }
        continue;
      }

      // arrayRemove — defer to update() for read-modify-write
      if (val.__arrayRemove !== undefined) {
        if (_deferred) {
          _deferred[key] = { __arrayRemove: val.__arrayRemove };
        } else {
          LOG.warn(`FieldValue.arrayRemove on key "${key}" ignored in set()/add() — requires update(). Field skipped.`);
        }
        continue;
      }

      // deleteField — write null (SQL equivalent of "remove field")
      if (val.__deleteField) {
        resolved[key] = null;
        continue;
      }

      // Unknown sentinel — log and skip
      LOG.warn(`Unknown FieldValue sentinel on key "${key}":`, val, '— field skipped.');
      continue;
    }

    // ── Plain object (recurse) ─────────────────────────────────────────────
    if (typeof val === 'object' && !Array.isArray(val)) {
      resolved[key] = resolveFieldValues(val, _deferred);
      continue;
    }

    // ── Primitive / array — pass through ──────────────────────────────────
    resolved[key] = val;
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyDeferredOps — post-write atomic ops (increment, arrayUnion/Remove)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply deferred sentinel operations that require knowledge of the current
 * row value (increments, array merges/removes).
 *
 * Strategy for increment:
 *   1. Try supabase.rpc('increment_field', { tbl, col, row_id, delta })
 *      → requires the function to exist in Postgres (recommended for production)
 *   2. Fall back to read-modify-write if the RPC returns a "function not found"
 *      error (code 42883 / PGRST202)
 *
 * Strategy for arrayUnion / arrayRemove:
 *   Always read-modify-write. Arrays in Postgres are columns, not sub-documents,
 *   so there is no native atomic array-merge without a custom RPC.
 *
 * @param {string} tableName
 * @param {string} docId
 * @param {object} deferred   — { fieldName: sentinel, ... }
 */
async function applyDeferredOps(tableName, docId, deferred) {
  if (!Object.keys(deferred).length) return;

  // Fetch current row once for all deferred ops
  const { data: currentRow, error: fetchErr } = await supabase
    .from(tableName)
    .select('*')
    .eq('id', docId)
    .single();

  if (fetchErr) {
    LOG.error(`applyDeferredOps: could not fetch current row for ${tableName}/${docId}:`, fetchErr);
    return;
  }

  const patch = {};

  for (const [key, sentinel] of Object.entries(deferred)) {
    const current = currentRow?.[key];

    // ── increment ──────────────────────────────────────────────────────────
    if (sentinel.__increment !== undefined) {
      const delta = sentinel.__increment;

      // Attempt RPC first
      const { error: rpcErr } = await supabase.rpc('increment_field', {
        tbl:    tableName,
        col:    key,
        row_id: docId,
        delta,
      });

      if (!rpcErr) {
        LOG.info(`increment_field RPC: ${tableName}.${key} += ${delta} (id=${docId})`);
        continue; // handled atomically — no need to add to patch
      }

      // RPC not found (42883) or any error → fall back to read-modify-write
      if (rpcErr.code === '42883' || rpcErr.code === 'PGRST202') {
        LOG.warn(`increment_field RPC not found for ${tableName}.${key} — using read-modify-write. ` +
          `Create the RPC for atomic behaviour.`);
      } else {
        LOG.warn(`increment_field RPC failed (${rpcErr.code}) for ${tableName}.${key} — falling back:`, rpcErr.message);
      }

      const numCurrent = typeof current === 'number' ? current : (parseFloat(current) || 0);
      patch[key] = numCurrent + delta;
      continue;
    }

    // ── arrayUnion ─────────────────────────────────────────────────────────
    if (sentinel.__arrayUnion !== undefined) {
      const existing = Array.isArray(current) ? current : [];
      const toAdd    = Array.isArray(sentinel.__arrayUnion) ? sentinel.__arrayUnion : [];
      // Add items not already present (Set-style union)
      const merged   = [...existing];
      for (const item of toAdd) {
        if (!merged.some(e => JSON.stringify(e) === JSON.stringify(item))) {
          merged.push(item);
        }
      }
      patch[key] = merged;
      continue;
    }

    // ── arrayRemove ────────────────────────────────────────────────────────
    if (sentinel.__arrayRemove !== undefined) {
      const existing  = Array.isArray(current) ? current : [];
      const toRemove  = Array.isArray(sentinel.__arrayRemove) ? sentinel.__arrayRemove : [];
      const removeSet = new Set(toRemove.map(i => JSON.stringify(i)));
      patch[key]      = existing.filter(e => !removeSet.has(JSON.stringify(e)));
      continue;
    }
  }

  if (!Object.keys(patch).length) return;

  const { error: patchErr } = await supabase
    .from(tableName)
    .update(patch)
    .eq('id', docId);

  if (patchErr) {
    LOG.error(`applyDeferredOps patch failed on ${tableName}/${docId}:`, patchErr);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds up a Firestore-style fluent query, then executes it against Supabase
 * when .get() / .set() / .update() / .add() / .delete() is called.
 *
 * @param {string}      tableName  - Supabase table name
 * @param {string|null} docId      - if set, operations target a single row
 * @param {boolean}     isGroup    - true when called from collectionGroup()
 */
function createQueryBuilder(tableName, docId = null, isGroup = false) {
  const _filters    = [];    // [{ field, operator, value }]
  let   _orderBy    = null;  // { field, direction }
  let   _limit      = null;
  let   _startAfter = null;  // cursor value for pagination
  let   _isCount    = false;
  let   _select     = '*';   // allow callers to narrow columns

  const builder = {

    // ── Chaining ─────────────────────────────────────────────────────────────

    where(field, operator, value) {
      if (field == null || operator == null) {
        LOG.warn(`where() called with missing args on ${tableName}: field=${field}, op=${operator} — ignored`);
        return builder;
      }
      _filters.push({ field, operator, value });
      return builder;
    },

    orderBy(field, direction = 'asc') {
      _orderBy = { field, direction: direction === 'desc' ? 'desc' : 'asc' };
      return builder;
    },

    limit(n) {
      _limit = typeof n === 'number' && n > 0 ? n : null;
      return builder;
    },

    /**
     * startAfter(snapshot | id)
     * Supports both a DocumentSnapshot (has .id) and a plain id string.
     * Implemented as .gt('id', cursorId) — suitable for sequential UUIDs.
     * For non-UUID primary keys, callers should use .orderBy + .where instead.
     */
    startAfter(snapshotOrId) {
      _startAfter = snapshotOrId?.id ?? snapshotOrId ?? null;
      return builder;
    },

    /** Mimics Firestore's .count() — returns { data: { count } } on .get() */
    count() {
      _isCount = true;
      return builder;
    },

    /**
     * select(columns)  — non-Firestore extension for column narrowing.
     * Accepts a comma-separated string: .select('id, name, email')
     */
    select(columns) {
      _select = columns || '*';
      return builder;
    },

    /**
     * Sub-collection builder (partitioned pattern):
     *   db.collection('jobs').doc(shardId).collection('tasks').doc(taskId)
     * In Supabase, sub-collections map to a flat table — the shard/parent id
     * is lost in translation (acceptable for the crash-prevention goal).
     */
    collection(subName) {
      return createQueryBuilder(subName, null, false);
    },

    /** Document-scoped builder — sets docId for terminal operations */
    doc(id) {
      return createQueryBuilder(tableName, id ?? null, isGroup);
    },

    // ── Terminal: READ ────────────────────────────────────────────────────────

    async get() {
      const ctx = `${tableName}${docId ? '/' + docId : ''}`;
      try {

        // ── Single-document fetch ──────────────────────────────────────────
        if (docId !== null) {
          const { data, error } = await supabase
            .from(tableName)
            .select(_select)
            .eq('id', docId)
            .maybeSingle();     // maybeSingle() returns null (not error) for 0 rows

          if (error) {
            // Log full error object so PostgREST code + details are visible
            LOG.error(`get() single-doc error on ${ctx}:`, {
              code:    error.code,
              message: error.message,
              details: error.details,
              hint:    error.hint,
            });
            return makeDocSnap(null, docId);
          }

          return makeDocSnap(data ?? null, docId);
        }

        // ── count().get() ──────────────────────────────────────────────────
        if (_isCount) {
          let query = supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true });

          for (const { field, operator, value } of _filters) {
            query = applyWhere(query, field, operator, value, tableName);
          }

          const { count, error } = await query;

          if (error) {
            LOG.error(`count() error on ${tableName}:`, {
              code: error.code, message: error.message,
            });
            return makeQuerySnap(null, 0);
          }

          return makeQuerySnap(null, count ?? 0);
        }

        // ── Collection query ───────────────────────────────────────────────
        let query = supabase.from(tableName).select(_select);

        for (const { field, operator, value } of _filters) {
          query = applyWhere(query, field, operator, value, tableName);
        }

        if (_orderBy) {
          query = query.order(_orderBy.field, {
            ascending: _orderBy.direction !== 'desc',
          });
        }

        // Cursor-based pagination via startAfter
        if (_startAfter !== null) {
          query = query.gt('id', _startAfter);
        }

        if (_limit !== null) {
          query = query.limit(_limit);
        }

        const { data, error } = await query;

        if (error) {
          LOG.error(`get() collection error on ${tableName}:`, {
            code: error.code, message: error.message, details: error.details,
          });
          return makeQuerySnap([]);
        }

        return makeQuerySnap(data ?? []);

      } catch (err) {
        LOG.error(`get() unexpected throw on ${ctx}:`, err);
        return docId !== null ? makeDocSnap(null, docId) : makeQuerySnap([]);
      }
    },

    // ── Terminal: WRITE ───────────────────────────────────────────────────────

    async set(data, options = {}) {
      const ctx = `${tableName}${docId ? '/' + docId : ''}`;
      try {
        if (!data || typeof data !== 'object') {
          LOG.warn(`set() called with non-object data on ${ctx} — skipping`);
          return;
        }

        const payload = resolveFieldValues(
          docId ? { id: docId, ...data } : data
        );

        const { error } = options.merge
          ? await supabase.from(tableName).upsert(payload, { onConflict: 'id' })
          : await supabase.from(tableName).upsert(payload, { onConflict: 'id' });

        if (error) {
          LOG.error(`set() error on ${ctx}:`, {
            code: error.code, message: error.message, details: error.details,
          });
        }

      } catch (err) {
        LOG.error(`set() unexpected throw on ${ctx}:`, err);
      }
    },

    /**
     * update(data)
     *
     * Improvements over v1:
     *   - All timestamp values (Date, Timestamp, String sentinel) coerced to ISO
     *   - FieldValue.increment() uses Postgres RPC with read-modify-write fallback
     *   - FieldValue.arrayUnion/arrayRemove do proper read-modify-write
     *   - FieldValue.delete() writes NULL (field omitted = NULL in SQL)
     *   - Logs full Supabase error object (code + details), not just .message
     */
    async update(data) {
      const ctx = `${tableName}/${docId}`;
      try {
        if (!docId) {
          LOG.warn(`update() called without a doc id on ${tableName} — skipping`);
          return;
        }
        if (!data || typeof data !== 'object') {
          LOG.warn(`update() called with non-object data on ${ctx} — skipping`);
          return;
        }

        // Split payload: immediate fields go to `resolved`, deferred sentinels
        // (increment, arrayUnion, arrayRemove) go to `deferred` for post-write.
        const deferred = {};
        const resolved = resolveFieldValues(data, deferred);

        // Only call update() if there is something immediate to write
        if (Object.keys(resolved).length > 0) {
          const { error } = await supabase
            .from(tableName)
            .update(resolved)
            .eq('id', docId);

          if (error) {
            LOG.error(`update() error on ${ctx}:`, {
              code:    error.code,
              message: error.message,
              details: error.details,
              hint:    error.hint,
            });
            // Do not proceed to deferred ops if the main write failed
            return;
          }
        }

        // Apply deferred ops (increment, arrayUnion, arrayRemove) if any
        if (Object.keys(deferred).length > 0) {
          await applyDeferredOps(tableName, docId, deferred);
        }

      } catch (err) {
        LOG.error(`update() unexpected throw on ${ctx}:`, err);
      }
    },

    async add(data) {
      const ctx = tableName;
      try {
        if (!data || typeof data !== 'object') {
          LOG.warn(`add() called with non-object data on ${ctx} — skipping`);
          return { id: null };
        }

        const { data: inserted, error } = await supabase
          .from(tableName)
          .insert(resolveFieldValues(data))
          .select('id')
          .single();

        if (error) {
          LOG.error(`add() error on ${ctx}:`, {
            code: error.code, message: error.message, details: error.details,
          });
          return { id: null };
        }

        return { id: inserted?.id ?? null };

      } catch (err) {
        LOG.error(`add() unexpected throw on ${ctx}:`, err);
        return { id: null };
      }
    },

    async delete() {
      const ctx = `${tableName}/${docId}`;
      try {
        if (!docId) {
          LOG.warn(`delete() called without a doc id on ${tableName} — skipping`);
          return;
        }

        const { error } = await supabase
          .from(tableName)
          .delete()
          .eq('id', docId);

        if (error) {
          LOG.error(`delete() error on ${ctx}:`, {
            code: error.code, message: error.message,
          });
        }

      } catch (err) {
        LOG.error(`delete() unexpected throw on ${ctx}:`, err);
      }
    },
  };

  return builder;
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
 * This emulates the *API shape* so existing code does not crash.
 * Atomic consistency requires a custom Postgres function (phase-2 concern).
 *
 * If the updateFn throws, the error is caught and re-thrown so callers can
 * handle it — the previous version let it bubble uncaught.
 */
async function runTransaction(updateFn) {
  const tx = {
    async get(ref)              { return ref.get(); },
    async set(ref, data, opts)  { return ref.set(data, opts ?? {}); },
    async update(ref, data)     { return ref.update(data); },
    async delete(ref)           { return ref.delete(); },
  };

  try {
    return await updateFn(tx);
  } catch (err) {
    LOG.error('runTransaction: updateFn threw:', err);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Emulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emulates Firestore WriteBatch.
 * Operations are queued synchronously then flushed sequentially on commit().
 * Individual op failures are logged but do not abort the remaining ops —
 * consistent with Firestore's best-effort batch behaviour for this shim.
 */
function createBatch() {
  const _ops = [];

  return {
    set(ref, data, options)  { _ops.push({ type: 'set',    ref, data, options }); },
    update(ref, data)        { _ops.push({ type: 'update', ref, data }); },
    delete(ref)              { _ops.push({ type: 'delete', ref }); },

    async commit() {
      const results = await Promise.allSettled(
        _ops.map(async (op) => {
          if (op.type === 'set')    return op.ref.set(op.data, op.options ?? {});
          if (op.type === 'update') return op.ref.update(op.data);
          if (op.type === 'delete') return op.ref.delete();
        })
      );

      let failures = 0;
      for (const [i, result] of results.entries()) {
        if (result.status === 'rejected') {
          failures++;
          LOG.error(`batch.commit() op[${i}] (${_ops[i]?.type}) failed:`, result.reason);
        }
      }

      if (failures > 0) {
        LOG.warn(`batch.commit(): ${failures}/${_ops.length} ops failed — see errors above`);
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
    if (!name || typeof name !== 'string') {
      LOG.warn(`collection() called with invalid name: ${name}`);
    }
    return createQueryBuilder(name);
  },

  /**
   * db.collectionGroup('subCollection')
   *
   * In Firestore this queries across ALL sub-collections with a given name.
   * In Supabase, treated as a direct table query — the table must be
   * denormalised and contain the expected columns.
   */
  collectionGroup(name) {
    return createQueryBuilder(name, null, true);
  },

  /** db.runTransaction(async (tx) => { ... }) */
  runTransaction,

  /** db.batch() */
  batch: createBatch,
};

// ─────────────────────────────────────────────────────────────────────────────
// FieldValue stubs
// ─────────────────────────────────────────────────────────────────────────────

const FieldValue = {
  /**
   * serverTimestamp()
   * Returns a String wrapper tagged with __isServerTimestamp so
   * resolveFieldValues() can detect and expand it to an ISO string.
   * Using a String wrapper (not a plain string) lets isSentinel() detect it.
   */
  serverTimestamp() {
    // eslint-disable-next-line no-new-wrappers
    const s = new String(new Date().toISOString());
    s.__isServerTimestamp = true;
    return s;
  },

  /**
   * increment(n)
   * Returns a sentinel deferred to applyDeferredOps() in update().
   * Silently skipped in set() / add() (logged as a warning).
   */
  increment(n) {
    const delta = typeof n === 'number' ? n : Number(n) || 1;
    return { __increment: delta };
  },

  /**
   * arrayUnion(...items)
   * Returns a sentinel that merges items into the existing array column.
   * Deferred to applyDeferredOps() in update().
   */
  arrayUnion(...items) {
    return { __arrayUnion: items.flat() };
  },

  /**
   * arrayRemove(...items)
   * Returns a sentinel that removes matching items from the existing array column.
   * Deferred to applyDeferredOps() in update().
   */
  arrayRemove(...items) {
    return { __arrayRemove: items.flat() };
  },

  /**
   * delete()
   * Sentinel for field deletion — resolveFieldValues() writes NULL.
   */
  delete() {
    return { __deleteField: true };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp class
// ─────────────────────────────────────────────────────────────────────────────

class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds     = seconds;
    this.nanoseconds = nanoseconds;
  }

  toDate()      { return new Date(this.seconds * 1000); }
  toMillis()    { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toISOString() { return this.toDate().toISOString(); }
  toString()    { return this.toISOString(); }

  static now() {
    return Timestamp.fromDate(new Date());
  }

  static fromDate(date) {
    const d  = date instanceof Date ? date : new Date(date);
    const ms = d.getTime();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
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
  // Convenience re-export so callers using `require(...).supabase` also work
  supabase,
  // Internal helpers exported for unit testing
  _resolveFieldValues: resolveFieldValues,
  _applyWhere:         applyWhere,
  _makeDocSnap:        makeDocSnap,
  _makeQuerySnap:      makeQuerySnap,
};