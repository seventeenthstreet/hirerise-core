# ADR-005: Production Certified Baseline v2.1.0

**Status:** Accepted\
**Date:** 2026-07-11

## Context

Following completion of ERP-03 and Phase 2.1, a stable engineering
baseline was required.

## Decision

Establish Git tag `v2.1.0-production-certified` as the canonical
production-certified baseline.

## Rationale

-   Immutable release reference
-   Reliable rollback point
-   Foundation for Phase 3

## Consequences

All future engineering work should branch from this certified baseline
or its descendants.
