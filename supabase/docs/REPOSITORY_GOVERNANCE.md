# Repository Governance

## Purpose

Define governance standards for the HireRise Core repository.

## Principles

-   Repository integrity
-   Migration traceability
-   Production-first engineering
-   Evidence-based releases
-   Security by default

## Migration Governance

-   Preserve canonical migration history.
-   Reconcile rather than rewrite production history.
-   Maintain ordering and idempotency.
-   Document exceptional reconciliations.

## Release Governance

A release requires: - Clean working tree - Verified production
deployment - Updated documentation - Security verification - Annotated
Git tag - Release notes

## Documentation Governance

Maintain: - CHANGELOG - Release Notes - Architecture - Deployment
Guides - ERP Reports - Work Package Reports

## Branch Governance

-   Production tags are immutable.
-   Develop is the integration branch.
-   Feature branches require review before merge.

## Audit Requirements

Every production release must be reproducible from Git history and
tagged baseline.
