# ADR-002: Retain Firebase Authentication

**Status:** Accepted\
**Date:** 2026-07-11

## Context

The project previously relied on Firebase Authentication.

## Decision

Retain Firebase Authentication while migrating application data to
Supabase.

## Rationale

-   Avoid disruptive user migration
-   Preserve existing authentication flows
-   Decouple identity from application data

## Consequences

Authentication remains in Firebase while business data resides in
Supabase.
