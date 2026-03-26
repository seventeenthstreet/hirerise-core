'use strict';

/**
 * server.additions.v2.js — HireRise Career Intelligence Platform
 * Route Registration Patch (Phase 2 Upgrade)
 *
 * This file documents the EXACT lines to add/modify in src/server.js
 * to register all new Career Intelligence Data Platform modules.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 1 — Add to imports at top of server.js (after existing requireAdmin):
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * const { requireMasterAdmin } = require('./middleware/requireMasterAdmin.middleware');
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 2 — Replace the CORS block in server.js with:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * const MAIN_DOMAIN  = process.env.MAIN_DOMAIN  || 'hirerise.com';
 * const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || `admin.${MAIN_DOMAIN}`;
 * const API_DOMAIN   = process.env.API_DOMAIN   || `api.${MAIN_DOMAIN}`;
 *
 * const allowedOrigins = [
 *   // Environment-configured origins (comma-separated in ALLOWED_ORIGINS)
 *   ...(process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
 *     .split(',').map(o => o.trim()),
 *   // Domain-derived origins (always included)
 *   `https://${MAIN_DOMAIN}`,
 *   `https://${ADMIN_DOMAIN}`,
 *   `https://www.${MAIN_DOMAIN}`,
 * ].filter(Boolean);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 3 — Add these route mounts BEFORE the 404 handler in server.js:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * // ✅ Salary Data API — public aggregation (any authenticated user)
 * //    POST /api/v1/salary-data          → admin manual entry (guarded inside route)
 * //    GET  /api/v1/salary-data/:roleId  → aggregated salary intelligence
 * //    GET  /api/v1/salary-data/:roleId/records → raw records (admin only, guarded inside)
 * app.use(
 *   `${API_PREFIX}/salary-data`,
 *   authenticate,
 *   require('./modules/salary/salary.routes')
 * );
 *
 * // ✅ CSV Salary Bulk Import (Admin only)
 * //    POST /api/v1/admin/import/salaries
 * app.use(
 *   `${API_PREFIX}/admin/import/salaries`,
 *   authenticate, requireAdmin,
 *   require('./modules/salaryImport/salaryImport.routes')
 * );
 *
 * // ✅ Role Alias Management (Admin only)
 * //    POST /api/v1/admin/cms/role-aliases
 * //    GET  /api/v1/admin/cms/role-aliases/:roleId
 * app.use(
 *   `${API_PREFIX}/admin/cms/role-aliases`,
 *   authenticate, requireAdmin,
 *   require('./modules/roleAliases/roleAlias.routes')
 * );
 *
 * // ✅ Master Admin — External API Management (MASTER_ADMIN only)
 * //    POST   /api/v1/master/apis
 * //    GET    /api/v1/master/apis
 * //    PATCH  /api/v1/master/apis/:id
 * //    DELETE /api/v1/master/apis/:id
 * app.use(
 *   `${API_PREFIX}/master/apis`,
 *   authenticate, requireMasterAdmin,
 *   require('./modules/master/master.routes')
 * );
 *
 * // ✅ Master Admin — API Sync Trigger (MASTER_ADMIN only)
 * //    POST /api/v1/master/sync/trigger  → manually trigger salary API sync
 * app.use(
 *   `${API_PREFIX}/master/sync`,
 *   authenticate, requireMasterAdmin,
 *   require('./modules/master/masterSync.routes')
 * );
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 4 — Add to .env (and env.example):
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * # Domain Configuration
 * MAIN_DOMAIN=hirerise.com
 * ADMIN_DOMAIN=admin.hirerise.com
 * API_DOMAIN=api.hirerise.com
 *
 * # Salary Aggregation Cache TTL (seconds)
 * SALARY_CACHE_TTL_SECONDS=300
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 5 — Add to package.json scripts:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "worker:salary-sync":      "node src/workers/salaryApiSync.worker.js",
 * "worker:salary-sync:now":  "node src/workers/salaryApiSync.worker.js --run-now",
 * "script:set-master-admin": "node src/scripts/setMasterAdmin.js"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 6 — Add to package.json dependencies (npm install):
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "csv-parser":  "^3.0.0"   ← already used internally
 * "node-cron":   "^3.0.3"   ← for salaryApiSync.worker.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINT SUMMARY AFTER REGISTRATION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PUBLIC (any authenticated user):
 *   GET  /api/v1/salary-data/:roleId              → aggregated salary intelligence
 *
 * ADMIN:
 *   POST /api/v1/salary-data                      → manual salary entry
 *   GET  /api/v1/salary-data/:roleId/records      → raw salary records
 *   POST /api/v1/admin/import/salaries            → CSV bulk import
 *   POST /api/v1/admin/cms/role-aliases           → create role alias
 *   GET  /api/v1/admin/cms/role-aliases/:roleId   → list aliases for role
 *
 * MASTER_ADMIN:
 *   POST   /api/v1/master/apis                    → register external API
 *   GET    /api/v1/master/apis                    → list all external APIs
 *   PATCH  /api/v1/master/apis/:id               → update API config
 *   DELETE /api/v1/master/apis/:id               → soft-delete API
 *   POST   /api/v1/master/sync/trigger           → manually trigger salary sync
 */

module.exports = {}; // documentation only — not imported at runtime








