# Contributing Guide

## Branch Strategy

-   `main` -- stable production mirror
-   `develop` -- active integration branch
-   `feature/*` -- new functionality
-   `fix/*` -- bug fixes
-   `hotfix/*` -- emergency production fixes

## Workflow

1.  Create a feature branch from `develop`.
2.  Keep commits focused and descriptive.
3.  Verify build/tests.
4.  Review migration impact.
5.  Open pull request.
6.  Merge into `develop`.
7.  Release only from certified baselines.

## Database Standards

-   Never modify an applied production migration without documented
    reconciliation.
-   One logical change per migration.
-   Include rollback when applicable.
-   Validate locally before deployment.

## Documentation

Update relevant architecture, deployment, and release documentation for
material changes.

## Security

-   Never commit secrets.
-   Ensure secret scanning passes before merge.
