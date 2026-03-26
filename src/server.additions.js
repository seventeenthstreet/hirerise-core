'use strict';

/**
 * server.additions.js — Admin CMS Route Registration Patch
 *
 * This file contains the EXACT lines to add to src/server.js
 * to register all new Admin CMS duplicate-prevention endpoints.
 *
 * INSTRUCTIONS:
 *   In src/server.js, find the block:
 *
 *     // ✅ Admin Routes (authenticate + requireAdmin)
 *     app.use(`${API_PREFIX}/admin/metrics`, ...
 *     app.use(`${API_PREFIX}/admin/ai`, ...
 *     app.use(`${API_PREFIX}/admin/jobs`, ...
 *     app.use(`${API_PREFIX}/admin/adaptive-weights`, ...
 *
 *   Append the following lines AFTER that block, BEFORE the 404 handler:
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PASTE THIS INTO server.js:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * // ✅ Admin CMS Dataset Ingestion (authenticate + requireAdmin)
 * // Duplicate prevention enforced in service layer + Firestore index constraints.
 * // No admin identity accepted from request body — all from req.user.uid (JWT).
 *
 * app.use(`${API_PREFIX}/admin/cms/skills`,
 *   authenticate, requireAdmin,
 *   require('./modules/admin/cms/skills/adminCmsSkills.routes'));
 *
 * app.use(`${API_PREFIX}/admin/cms/roles`,
 *   authenticate, requireAdmin,
 *   require('./modules/admin/cms/roles/adminCmsRoles.routes'));
 *
 * app.use(`${API_PREFIX}/admin/cms/job-families`,
 *   authenticate, requireAdmin,
 *   (req, res, next) => {
 *     require('./modules/admin/cms/adminCmsGeneric.factory').jobFamiliesModule.router(req, res, next);
 *   });
 *
 * app.use(`${API_PREFIX}/admin/cms/education-levels`,
 *   authenticate, requireAdmin,
 *   (req, res, next) => {
 *     require('./modules/admin/cms/adminCmsGeneric.factory').educationLevelsModule.router(req, res, next);
 *   });
 *
 * app.use(`${API_PREFIX}/admin/cms/salary-benchmarks`,
 *   authenticate, requireAdmin,
 *   (req, res, next) => {
 *     require('./modules/admin/cms/adminCmsGeneric.factory').salaryBenchmarksModule.router(req, res, next);
 *   });
 *
 * app.use(`${API_PREFIX}/admin/cms/import`,
 *   authenticate, requireAdmin,
 *   require('./modules/admin/cms/import/adminCmsImport.routes'));
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Endpoint summary after registration:
 *
 *   POST   /api/v1/admin/cms/skills                → Create skill (dedup)
 *   PATCH  /api/v1/admin/cms/skills/:skillId       → Update skill (dedup on rename)
 *   GET    /api/v1/admin/cms/skills                → List skills
 *
 *   POST   /api/v1/admin/cms/roles                 → Create role (composite dedup)
 *   PATCH  /api/v1/admin/cms/roles/:roleId         → Update role
 *   GET    /api/v1/admin/cms/roles                 → List roles
 *
 *   POST   /api/v1/admin/cms/job-families          → Create job family (dedup)
 *   PATCH  /api/v1/admin/cms/job-families/:id      → Update
 *   GET    /api/v1/admin/cms/job-families          → List
 *
 *   POST   /api/v1/admin/cms/education-levels      → Create education level (dedup)
 *   PATCH  /api/v1/admin/cms/education-levels/:id  → Update
 *   GET    /api/v1/admin/cms/education-levels      → List
 *
 *   POST   /api/v1/admin/cms/salary-benchmarks     → Create benchmark (dedup)
 *   PATCH  /api/v1/admin/cms/salary-benchmarks/:id → Update
 *   GET    /api/v1/admin/cms/salary-benchmarks     → List
 *
 *   POST   /api/v1/admin/cms/import                → Bulk CSV import (dedup pipeline)
 *
 * All routes inherit:
 *   - authenticate  (auth token verification)
 *   - requireAdmin  (admin === true || role === 'admin'|'super_admin')
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALSO ADD to ErrorCodes in src/middleware/errorHandler.js:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   // CMS Dataset errors
 *   DUPLICATE_RECORD: 'DUPLICATE_RECORD',
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// This file is documentation only — it is not imported at runtime.
module.exports = {};








