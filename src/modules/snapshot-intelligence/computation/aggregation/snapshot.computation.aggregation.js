'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/aggregation/snapshot.computation.aggregation.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * Generic aggregation primitives, per KR-02C's "Aggregation Framework"
 * deliverable. Supports reduction, grouping, accumulation, and summary
 * generation. Remains generic — no business scoring, no interpretation
 * of what is being aggregated. Every function here operates on plain
 * arrays/values a caller supplies and a key/reducer/summarizer function
 * the caller also supplies; this module assigns no meaning to any of
 * them.
 *
 * PURE FUNCTIONS ONLY — deterministic given deterministic inputs
 * (KR-02C's "identical input → identical output" exit criterion
 * requires every caller-supplied reducer/keyFn/summarizer to itself be
 * pure and deterministic; this framework cannot enforce that of a
 * caller's function, but it introduces no non-determinism of its own —
 * no Date.now(), no Math.random(), no object-key iteration order
 * dependency beyond the input array's own order).
 */

const { SnapshotAggregationError } = require('../errors/snapshot.computation.errors');

function assertArray(items, fnName) {
  if (!Array.isArray(items)) {
    throw new SnapshotAggregationError(`${fnName} requires an array input`, { received: typeof items });
  }
}

function assertFunction(fn, fnName, argName) {
  if (typeof fn !== 'function') {
    throw new SnapshotAggregationError(`${fnName} requires ${argName} to be a function`, { received: typeof fn });
  }
}

/**
 * Reduces `items` to a single value via `reducer`, in array order,
 * starting from `seed`. A thin, error-wrapped equivalent of
 * `Array.prototype.reduce` — kept as an explicit primitive (rather than
 * asking every caller to reach for the native method directly) so every
 * reduction failure across the computation layer surfaces as a
 * SnapshotAggregationError.
 *
 * @param {Array} items
 * @param {(accumulator: *, item: *, index: number) => *} reducer
 * @param {*} seed
 * @returns {*}
 */
function reduceValues(items, reducer, seed) {
  assertArray(items, 'reduceValues');
  assertFunction(reducer, 'reduceValues', 'reducer');
  try {
    return items.reduce(reducer, seed);
  } catch (err) {
    throw new SnapshotAggregationError(`reduceValues reducer threw: ${err.message}`, { cause: err });
  }
}

/**
 * Groups `items` by the key `keyFn` returns for each item. Returns a
 * plain object (not a Map) keyed by the string form of each computed
 * key, with values as arrays preserving each item's original relative
 * order (grouping is stable).
 *
 * @param {Array} items
 * @param {(item: *, index: number) => string|number} keyFn
 * @returns {Object<string, Array>}
 */
function groupByKey(items, keyFn) {
  assertArray(items, 'groupByKey');
  assertFunction(keyFn, 'groupByKey', 'keyFn');

  const groups = {};
  items.forEach((item, index) => {
    let key;
    try {
      key = keyFn(item, index);
    } catch (err) {
      throw new SnapshotAggregationError(`groupByKey keyFn threw at index ${index}: ${err.message}`, { index, cause: err });
    }
    const stringKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(groups, stringKey)) {
      groups[stringKey] = [];
    }
    groups[stringKey].push(item);
  });
  return groups;
}

/**
 * Accumulates `items` into a running-state value via `accumulatorFn`,
 * returning both the final state and the ordered list of intermediate
 * states (one per item) — distinct from `reduceValues` in that the
 * intermediate history is itself part of the result, which callers that
 * need a per-item running total (rather than only the final aggregate)
 * can use directly instead of re-deriving it.
 *
 * @param {Array} items
 * @param {(state: *, item: *, index: number) => *} accumulatorFn
 * @param {*} seed
 * @returns {{ final: *, history: Array }}
 */
function accumulate(items, accumulatorFn, seed) {
  assertArray(items, 'accumulate');
  assertFunction(accumulatorFn, 'accumulate', 'accumulatorFn');

  const history = [];
  let state = seed;
  items.forEach((item, index) => {
    try {
      state = accumulatorFn(state, item, index);
    } catch (err) {
      throw new SnapshotAggregationError(`accumulate accumulatorFn threw at index ${index}: ${err.message}`, { index, cause: err });
    }
    history.push(state);
  });
  return { final: state, history };
}

/**
 * Generic summary generation (KR-02C Deliverable #7: "summary
 * generation"): runs every named function in `summarizers` against
 * `items` and returns a plain object of the same keys mapped to each
 * function's return value. Assigns no meaning to any summarizer name or
 * result — a caller (a future business-scoring work package, for
 * instance) supplies both.
 *
 * @param {Array} items
 * @param {Object<string, (items: Array) => *>} summarizers
 * @returns {Object}
 */
function summarize(items, summarizers) {
  assertArray(items, 'summarize');
  if (summarizers === null || typeof summarizers !== 'object' || Array.isArray(summarizers)) {
    throw new SnapshotAggregationError('summarize requires summarizers to be an object of named functions', { received: typeof summarizers });
  }

  const summary = {};
  Object.keys(summarizers).forEach((name) => {
    const fn = summarizers[name];
    assertFunction(fn, 'summarize', `summarizers.${name}`);
    try {
      summary[name] = fn(items);
    } catch (err) {
      throw new SnapshotAggregationError(`summarize summarizer "${name}" threw: ${err.message}`, { summarizer: name, cause: err });
    }
  });
  return summary;
}

module.exports = {
  reduceValues,
  groupByKey,
  accumulate,
  summarize,
};
