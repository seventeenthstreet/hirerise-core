'use strict';

/**
 * modules/knowledge-runtime/decision/decisionTypeRegistry.js
 *
 * WP-XAI2-06 — Decision Runtime Expansion.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, AND WHY IT IS THE *ONLY* NEW FILE IN THIS WP
 * ============================================================================
 * The Enterprise Implementation brief for WP-XAI2-06 asks for a "Decision
 * Runtime abstraction / execution pipeline / lifecycle orchestration /
 * executor framework / handler interface / shared execution context" etc.
 * Repository verification against the actual `decision.service.js` shows
 * that almost all of that already exists and is already type-agnostic:
 *
 *   - `decide()` -> `_decideUnimplementedType()` / `_decideImplementedType()`
 *     is already the single shared orchestration/execution path for every
 *     decision type.
 *   - `_decideImplementedType()` was already generalized in WP-XAI2-04 by
 *     parameterizing the two places that used to hardcode `'skill'` (the
 *     recommendation group key and the value threaded into
 *     `ValidationService.validateDecisionReadiness()`).
 *   - The rule chain, finalizers, telemetry (`this._logger.*` calls),
 *     confidence-band mapping, and response assembly are already 100%
 *     shared and contain no per-type branches.
 *
 * In other words, `skill` and `career` do not actually diverge in business
 * logic anywhere in this codebase today — they diverge only in *which
 * decisionType string is threaded through*. There is no repository
 * evidence (no differing candidate shape, no differing rule, no differing
 * finalizer) to justify a `DecisionHandler` interface with per-type
 * `execute()` implementations, a separate "executor" object per type, or a
 * "shared execution context" object distinct from the parameters already
 * passed around. Building those layers now would be exactly the
 * "speculative future architecture" / "unnecessary abstraction" the WP
 * brief itself says to avoid.
 *
 * The one piece of *real*, evidence-backed generalization left to do is the
 * membership check itself: `IMPLEMENTED_DECISION_TYPES` was a hardcoded,
 * frozen array literal that `decision.service.js` had to be edited to
 * extend (as WP-XAI2-04 did, going from `['skill']` to `['skill',
 * 'career']`). That is real duplicated-orchestration risk for the next
 * decision type — not because the pipeline would need to change (it
 * wouldn't), but because "is this decisionType computable" was inlined as
 * a literal instead of being an explicit, independently testable registry.
 * This file extracts exactly that, and nothing else.
 *
 * ============================================================================
 * CONTRACT
 * ============================================================================
 * - `register(decisionType)` adds a decisionType to the implemented set.
 *   Idempotent — registering an already-registered type is a no-op, not an
 *   error, so module re-require under Jest's module registry (or any future
 *   multi-entrypoint bootstrap) never throws.
 * - `isImplemented(decisionType)` — the DR-TYP-01 gate predicate.
 * - `list()` — returns a frozen array snapshot (NOT a live reference), so
 *   callers cannot mutate the registry's internal `Set` by holding onto an
 *   old array the way they could with the previous exported frozen-array
 *   constant. `decision.service.js`'s own `.includes()` usage (and the test
 *   suite's `IMPLEMENTED_DECISION_TYPES.includes(...)` usage) both still
 *   work unchanged against this snapshot.
 * - `KNOWN_DECISION_TYPES` is intentionally NOT modeled by this registry.
 *   That list (the full architectural vocabulary from
 *   DECISION_INTELLIGENCE_FRAMEWORK.md §Objective 2) is a frozen, closed
 *   set defined by `recommendation.validator.js`'s `VALID_GROUPS` and
 *   mirrored in `decision.validator.js`'s `VALID_DECISION_TYPES` — it is
 *   validation-layer input vocabulary, not a runtime capability registry,
 *   and changing what counts as a *valid* decisionType at all is outside
 *   this WP's approved scope (no new decisionType is being introduced;
 *   `skill` and `career` are still the only two).
 *
 * No dependency-injection change, no controller change, no route change,
 * and no response-contract change follow from this file — it is consumed
 * by exactly one call site (`decision.service.js`'s DR-TYP-01 gate),
 * replacing a frozen-array `.includes()` check with an equivalent
 * registry `.isImplemented()` check.
 */

class DecisionTypeRegistry {
  constructor(initialTypes = []) {
    this._types = new Set(initialTypes);
  }

  /**
   * @param {string} decisionType
   * @returns {this}
   */
  register(decisionType) {
    if (typeof decisionType !== 'string' || !decisionType.trim()) {
      throw new Error('[DecisionTypeRegistry] decisionType must be a non-empty string');
    }
    this._types.add(decisionType.trim());
    return this;
  }

  /**
   * @param {string} decisionType
   * @returns {boolean}
   */
  isImplemented(decisionType) {
    return this._types.has(decisionType);
  }

  /**
   * @returns {string[]} frozen snapshot, safe for external `.includes()` use
   */
  list() {
    return Object.freeze([...this._types]);
  }
}

// The v1 baseline registration — identical membership to the previous
// `IMPLEMENTED_DECISION_TYPES = Object.freeze(['skill', 'career'])` literal.
// `career` was added here by WP-XAI2-04; this WP changes *how* that
// membership is expressed, not what it is.
const decisionTypeRegistry = new DecisionTypeRegistry(['skill', 'career']);

module.exports = {
  DecisionTypeRegistry,
  decisionTypeRegistry,
};
