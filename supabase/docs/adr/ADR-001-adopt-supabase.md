# ADR-001: Adopt Supabase as Primary Data Platform

**Status:** Accepted\
**Date:** 2026-07-11

## Context

The platform required a scalable managed PostgreSQL database with
authentication, Row Level Security (RLS), SQL migrations, RPC support,
and operational tooling.

## Decision

Adopt Supabase as the primary application data platform.

## Rationale

-   PostgreSQL foundation
-   First-class RLS
-   Managed backups and operations
-   Migration-based schema management
-   Strong support for analytics and AI workloads

## Consequences

Positive: - Unified relational data model - Enterprise-grade security -
Simplified deployment

Trade-offs: - Requires disciplined migration governance.
