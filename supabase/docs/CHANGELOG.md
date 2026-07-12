# CHANGELOG

All notable changes to the HireRise Core repository are documented in
this file.

The format is inspired by **Keep a Changelog** and follows Semantic
Versioning where practical.

------------------------------------------------------------------------

## \[v2.1.0-production-certified\] - 2026-07-11

### Release

**Phase 2.1 --- Repository Finalization**

This release establishes the first production-certified engineering
baseline for the HireRise Core repository following completion of the
Enterprise Engineering Program.

### Added

#### Enterprise Documentation

-   Archived ERP-01 Enterprise Repository Certification artifacts.
-   Archived ERP-01A Baseline Certification artifacts.
-   Archived ERP-02 Enterprise Engineering Execution artifacts.
-   Archived ERP-02A Enterprise Execution Certification artifacts.
-   Archived ERP-03 Enterprise Engineering Program Closure Report.
-   Added WP-ARCH architecture documentation suite.
-   Added production deployment certification documentation.
-   Added WP-0002 implementation records.

#### Database

-   Added `20260710000001_wp_0002_t102_sim_sources_rls.sql`.
-   Added canonical migration
    `20260410024100_chi_weekly_rollups_mv.sql`.

### Changed

#### Migration Repository

-   Reconciled canonical migration history.
-   Improved PostgreSQL compatibility for governance migrations.
-   Added reconciliation annotations and migration documentation.
-   Improved idempotent constraint creation patterns.

#### Repository

-   Standardized repository documentation layout.
-   Finalized engineering evidence archive.
-   Established production-certified baseline.

### Security

-   SIM Row Level Security deployment completed and committed.
-   Repository passed secret scanning during commit.
-   Production security verification completed.

### Verification

-   Production deployment verified.
-   Migration lineage verified.
-   Repository integrity verified.
-   Git history synchronized.
-   Working tree confirmed clean.
-   Release tag created:
    -   `v2.1.0-production-certified`

### Certification Status

  Area                   Status
  ---------------------- -----------
  Repository             Certified
  Production             Certified
  Security               Certified
  Documentation          Certified
  Migration Repository   Certified
  Engineering Program    Closed

------------------------------------------------------------------------

## Previous Engineering Milestones

-   ERP-01 --- Enterprise Repository Certification
-   ERP-01A --- Repository Quality Assurance & Baseline Certification
-   ERP-02 --- Enterprise Engineering Execution Program
-   ERP-02A --- Enterprise Execution Certification
-   WP-0002 --- Enterprise Security Hardening
-   WP-P2-00B --- Production Migration History Reconciliation
-   WP-P2-01 --- Enterprise Source Intelligence Management Foundation
-   WP-0002 T-102 --- SIM Row Level Security Deployment
-   ERP-03 --- Enterprise Engineering Program Closure

------------------------------------------------------------------------

## Next Planned Release

### Phase 3 --- Enterprise Platform Expansion

Planned work packages include:

-   Distributed Governance Foundation
-   Intelligence Foundation Layer
-   Enterprise Feature Development
-   Additional production work packages following the certified
    baseline.

------------------------------------------------------------------------

Maintained by the HireRise Enterprise Engineering Program.
