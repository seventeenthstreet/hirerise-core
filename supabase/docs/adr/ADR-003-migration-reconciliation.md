# ADR-003: Canonical Migration Reconciliation Strategy

**Status:** Accepted\
**Date:** 2026-07-11

## Context

Repository and production migration histories diverged during
engineering.

## Decision

Reconcile migrations without rewriting applied production history.

## Rationale

-   Preserve auditability
-   Maintain production integrity
-   Ensure deterministic deployments

## Consequences

Canonical migration history is retained and future releases build on the
reconciled baseline.
