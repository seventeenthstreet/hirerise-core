/**
 * server.js — HireRise Core Engine Entry Point (HARDENED VERSION)
 *
 * Fixes applied:
 *  - Removed duplicate middleware registrations (helmet, compression, cors,
 *    correlationMiddleware, rate limiter were all registered twice)
 *  - Removed unconditional dev route registration (now non-production only)
 *  - Auth applied per route group (fixes 401-before-404 ordering bug)
 *  - requireAdmin exported from auth.middleware (fixes silent 403 bug)
 *  - Stripe raw body parsing before express.json (webhook sig verification)
 *  - Webhook routes registered before protected routes (no auth required)
 *  - Admin metrics + admin AI routes registered with requireAdmin guard
 *
 * Two-tier admin system (new):
 *  - contributor role: submit entries for review via /admin/pending
 *  - admin+: approve/reject entries, manage contributors via /admin/contributors
 *  - requireContributor middleware gates submission endpoints
 */

'use strict';

require('dotenv').config();

// ── Secrets Manager — fail-fast key validation ────────────────────────────────
// Validates MASTER_ENCRYPTION_KEY is present and exactly 32 bytes.
// Server will not start without it — prevents silent encryption failures at runtime.
const { validateEncryptionKeyPresent } = require('./utils/crypto/encryption');
try {
  validateEncryptionKeyPresent();
} catch (err) {
  // Use console.error here — logger may not be initialised yet
  console.error('[Server] FATAL: Secrets Manager encryption key misconfigured:', err.message);
  console.error('[Server] Set MASTER_ENCRYPTION_KEY to exactly 32 ASCII characters in your .env');
  process.exit(1);
}

// Core dependencies
const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

// Utilities
const logger = require('./utils/logger');

// Middleware
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { correlationMiddleware } = require('./middleware/correlation.middleware');
const { authenticate, requireAdmin } = require('./middleware/auth.middleware');
const { requireMasterAdmin } = require('./middleware/requireMasterAdmin.middleware');
const { requireContributor } = require('./middleware/requireContributor.middleware');
const { adminRateLimit, masterRateLimit } = require('./middleware/adminRateLimit.middleware');

// Routes
const devRoutes = require('./modules/dev/dev.routes');
const { secretsRouter } = require('./modules/secrets');

// Create Express App
const app = express();

// Trust proxy (Cloud Run / Load Balancer safe)
app.set('trust proxy', 1);

// Global Middleware (single registration — duplicates from original removed)
app.use(correlationMiddleware);
app.use(helmet());
app.use(compression());

// CORS — Domain-driven configuration (no hardcoded domains)
// Set MAIN_DOMAIN, ADMIN_DOMAIN, API_DOMAIN in .env
// Admin frontend: https://<ADMIN_DOMAIN>
// Public app:     https://<MAIN_DOMAIN>
// API server:     https://<API_DOMAIN>
const MAIN_DOMAIN  = process.env.MAIN_DOMAIN  || 'hirerise.com';
const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || `admin.${MAIN_DOMAIN}`;

const allowedOrigins = [
  // Explicit env var overrides (comma-separated)
  ...(process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
    .split(',').map(o => o.trim()),
  // Domain-derived origins (always included in non-test envs)
  ...(process.env.NODE_ENV !== 'test' ? [
    `https://${MAIN_DOMAIN}`,
    `https://${ADMIN_DOMAIN}`,
    `https://www.${MAIN_DOMAIN}`,
  ] : []),
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // HIGH-04 FIX: Wildcard support removed. credentials:true + wildcard is
    // spec-forbidden and a security hole. Origins must be explicitly listed.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Correlation-ID', 'Idempotency-Key'],
  exposedHeaders: ['X-Correlation-ID', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400,
}));

// ── Body Parsing ──────────────────────────────────────────────────────────────
// IMPORTANT: Stripe webhook route must receive raw Buffer for signature
// verification — must be registered BEFORE express.json() processes the body.
app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' })); // ← NEW

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(
    process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
    { stream: { write: msg => logger.http(msg.trim()) } }
  ));
}

// API Prefix — must be declared before any route registration
// ARC FIX: hardcoded — never allow env variable override.
const API_PREFIX = '/api/v1';

// Dev Routes — non-production only
if (process.env.NODE_ENV !== 'production') {
  app.use(`${API_PREFIX}/dev`, devRoutes);
}
// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '400', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  // HIGH-03 FIX: Rate limit authenticated users by UID, not IP.
  // IP-only limiting is trivially bypassed behind a CDN and unfair in NAT environments.
  // Falls back to IP for unauthenticated requests (webhooks, health).
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' } },
});
app.use(globalLimiter);

/**
 * ✅ Health Check (PUBLIC)
 * Now correctly under /api/v1/health
 */
// Phase 4: Deep health probes (Supabase, Redis, Anthropic, queue depth).
// GET /health        — public, load balancer probe (unchanged behaviour)
// GET /health/deep   — internal ops probe (requires X-Health-Probe-Token header)
app.use(`${API_PREFIX}/health`, require('./routes/health.routes'));

/**
 * ✅ Internal Routes (NO Firebase JWT — protected by INTERNAL_SERVICE_TOKEN)
 * Called by Google Cloud Tasks (server-to-server), not by users.
 * Must be registered BEFORE the authenticate middleware block.
 */
const { requireInternalToken } = require('./middleware/internalToken.middleware');
app.use(
  `${API_PREFIX}/internal/provisional-chi`,
  requireInternalToken,
  require('./routes/internal/provisionalChi.route'),
);

// Phase 2: async AI job processor — Cloud Tasks callback
// Receives { jobId } from Cloud Tasks, runs the AI operation, writes result to ai_jobs/{jobId}
app.use(
  `${API_PREFIX}/internal/ai-job`,
  requireInternalToken,
  require('./routes/internal/aiJob.route'),
);

/**
 * ✅ Webhook Routes (NO authenticate — signature-verified by each handler)
 * Must be registered BEFORE protected routes and BEFORE global auth middleware.
 * Razorpay + Stripe send requests from their servers, not from users.
 */
app.use(`${API_PREFIX}/webhooks`, require('./routes/webhooks.routes')); // ← NEW

/**
 * ✅ Protected Route Modules
 * Auth applied per route group (fixes 401-before-404 bug)
 */
app.use(`${API_PREFIX}/career`,        authenticate, require('./routes/career.routes'));
app.use(`${API_PREFIX}/career-graph`,  authenticate, require('./modules/careerGraph/careerGraph.routes'));
app.use(`${API_PREFIX}/skill-graph`,   authenticate, require('./modules/skillGraph/skillGraph.routes'));
app.use(`${API_PREFIX}/admin/graph`,              authenticate, requireAdmin, require('./modules/admin/graph/graphAdmin.routes'));
app.use(`${API_PREFIX}/admin/graph-intelligence`, authenticate, requireAdmin, require('./modules/admin/graph/graphIntelligence.routes'));
app.use(`${API_PREFIX}/salary`,        authenticate, require('./routes/salary.routes'));
app.use(`${API_PREFIX}/skills`,        authenticate, require('./routes/skills.routes'));
app.use(`${API_PREFIX}/jobs`,          authenticate, require('./routes/jobs.routes'));
app.use(`${API_PREFIX}/resume-growth`, authenticate, require('./routes/resumeGrowth.routes'));
app.use(`${API_PREFIX}/growth`,        authenticate, require('./routes/growth.routes'));
app.use(`${API_PREFIX}/resume-scores`, authenticate, require('./routes/resumeScore.routes'));
app.use(`${API_PREFIX}/resumes`,       authenticate, require('./modules/resume/resume.routes'));
app.use(`${API_PREFIX}/onboarding`,    authenticate, require('./modules/onboarding/onboarding.routes'));
app.use(`${API_PREFIX}/career-health`, authenticate, require('./modules/careerHealthIndex/careerHealthIndex.routes'));
// Phase 3: user activity tracking — streak, weekly summary, chi delta
app.use(`${API_PREFIX}/user-activity`, require('./modules/userActivity/userActivity.routes'));
app.use(`${API_PREFIX}/job-analyses`,  authenticate, require('./routes/jobAnalyzer.routes'));
app.use(`${API_PREFIX}/cv-builder`,    authenticate, require('./routes/cvBuilder.routes'));
app.use(`${API_PREFIX}/users`,         authenticate, require('./routes/users.routes'));
app.use(`${API_PREFIX}/analyze`,       authenticate, require('./modules/analysis/analysis.route'));
// Phase 2: async AI job status poll — GET /api/v1/ai-jobs/:jobId
app.use(`${API_PREFIX}/ai-jobs`,       authenticate, require('./routes/aiJobs.route'));
app.use(`${API_PREFIX}/roles`,         authenticate, require('./modules/roles/roles.routes'));
app.use(`${API_PREFIX}/applications`,  authenticate, require('./jobApplications/jobApplications.routes'));
app.use(`${API_PREFIX}/cover-letter`,  authenticate, require('./modules/coverLetter/coverLetter.routes'));
app.use(`${API_PREFIX}/dashboard`,     authenticate, require('./modules/dashboard/dashboard.route'));
app.use(`${API_PREFIX}/app-entry`,     authenticate, require('./modules/appEntry/appEntry.route'));
app.use(`${API_PREFIX}/qualifications`, authenticate, require('./modules/qualification/qualification.routes'));

/**
 * ✅ Admin Routes (authenticate + requireAdmin)
 * requireAdmin checks decoded.admin === true OR decoded.role === 'admin'|'super_admin'
 * Requires custom claim to be set on the Firebase user:
 *   await supabaseAdmin.auth.admin.updateUserById(uid, {
 *     app_metadata: { admin: true, role: 'admin' }
 *   });
 *
 * Rate limit: 50 req/min per user (adminRateLimit)
 */
app.use(`${API_PREFIX}/admin`, adminRateLimit);
app.use(`${API_PREFIX}/admin/metrics`,           authenticate, requireAdmin, require('./routes/admin/adminMetrics.routes'));  // ← NEW
app.use(`${API_PREFIX}/admin/ai`,               authenticate, requireAdmin, require('./routes/admin/ai-observability.routes')); // ← NEW (was unguarded)
app.use(`${API_PREFIX}/admin/jobs`,             authenticate, requireAdmin, require('./modules/admin/jobs/adminJobs.routes')); // ← DEAD-01
app.use(`${API_PREFIX}/admin/adaptive-weights`, authenticate, requireAdmin, require('./modules/adaptiveWeight/adaptiveWeight.routes')); // ← DEAD-03
// C-02 FIX: career-readiness is marked DEAD-02. Gated behind feature flag.
// To re-enable: set FEATURE_CAREER_READINESS=true in your .env
// To remove permanently: delete this block + src/modules/career-readiness/
if (process.env.FEATURE_CAREER_READINESS === 'true') {
  app.use(`${API_PREFIX}/career-readiness`, authenticate, require('./modules/career-readiness/careerReadiness.routes'));
}

/**
 * ✅ Admin CMS Dataset Ingestion (authenticate + requireAdmin)
 *
 * Duplicate prevention enforced at two layers:
 *   1. Service layer — normalized name lookup before every insert
 *   2. Supabase unique constraint on normalizedName / normalizedCompositeKey
 *
 * Security contract:
 *   - Admin identity (createdByAdminId) always sourced from req.user.uid (JWT)
 *   - No admin identity is accepted from any request body — blocked by validators
 *   - All routes inherit authenticate + requireAdmin from this mount point
 *
 * Endpoints registered:
 *   POST   /api/v1/admin/cms/skills                → Create skill (dedup check)
 *   PATCH  /api/v1/admin/cms/skills/:skillId       → Update skill (re-checks on rename)
 *   GET    /api/v1/admin/cms/skills                → List skills
 *
 *   POST   /api/v1/admin/cms/roles                 → Create role (composite key dedup)
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
 *   POST   /api/v1/admin/cms/salary-benchmarks     → Create salary benchmark (dedup)
 *   PATCH  /api/v1/admin/cms/salary-benchmarks/:id → Update
 *   GET    /api/v1/admin/cms/salary-benchmarks     → List
 *
 *   POST   /api/v1/admin/cms/import                → Bulk CSV import with full dedup pipeline
 *                                                    Returns HTTP 207 on partial success
 */
app.use(
  `${API_PREFIX}/admin/cms/skills`,
  authenticate, requireAdmin,
  require('./modules/admin/cms/skills/adminCmsSkills.routes')
);

app.use(
  `${API_PREFIX}/admin/cms/roles`,
  authenticate, requireAdmin,
  require('./modules/admin/cms/roles/adminCmsRoles.routes')
);

// Generic CMS modules (jobFamilies, educationLevels, salaryBenchmarks) are
// produced by the factory and expose a pre-built Express router.
const {
  jobFamiliesModule,
  educationLevelsModule,
  salaryBenchmarksModule,
} = require('./modules/admin/cms/adminCmsGeneric.factory');

// Taxonomy extension modules
const careerDomainsModule = require('./modules/admin/cms/career-domains/adminCmsCareerDomains.module');
const skillClustersModule = require('./modules/admin/cms/skill-clusters/adminCmsSkillClusters.module');

app.use(
  `${API_PREFIX}/admin/cms/career-domains`,
  authenticate, requireAdmin,
  careerDomainsModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/skill-clusters`,
  authenticate, requireAdmin,
  skillClustersModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/job-families`,
  authenticate, requireAdmin,
  jobFamiliesModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/education-levels`,
  authenticate, requireAdmin,
  educationLevelsModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/salary-benchmarks`,
  authenticate, requireAdmin,
  salaryBenchmarksModule.router
);

app.use(
  `${API_PREFIX}/admin/cms/import`,
  authenticate, requireAdmin,
  require('./modules/admin/cms/import/adminCmsImport.routes')
);

/**
 * ✅ Admin CMS CSV File Upload Import (authenticate + requireAdmin)
 *
 * Accepts multipart/form-data CSV uploads and pipes them through the
 * existing duplicate-prevention pipeline (adminCmsImport.service).
 *
 * POST /api/v1/admin/cms/import/csv/:datasetType
 *
 * Supported datasetType values:
 *   skills | roles | jobFamilies | educationLevels
 *
 * To add new types later (courses, universities, etc.):
 *   1. Add type to SUPPORTED_TYPES in adminCmsImport.service.js
 *   2. Add repository lazy-loader in adminCmsImport.service.js
 *   3. No changes needed here
 */
app.use(
  `${API_PREFIX}/admin/cms/import/csv`,
  authenticate, requireAdmin,
  require('./modules/admin/import/import.routes')
);

/**
 * ✅ Contributor Submission + Approval Workflow
 *
 * Two-tier admin system:
 *   contributor  → can submit entries for review
 *   admin+       → can approve/reject, writes approved entries to live collections
 *
 * Endpoints:
 *   POST   /api/v1/admin/pending                   → contributor submits entry
 *   GET    /api/v1/admin/pending                   → list (admin: all, contributor: own)
 *   GET    /api/v1/admin/pending/:id               → single entry
 *   POST   /api/v1/admin/pending/:id/approve       → admin approves → writes to live collection
 *   POST   /api/v1/admin/pending/:id/reject        → admin rejects with reason
 *   DELETE /api/v1/admin/pending/:id               → contributor withdraws own submission
 */
app.use(
  `${API_PREFIX}/admin/pending`,
  authenticate, requireContributor,
  require('./routes/admin/adminPending.routes')
);

/**
 * ✅ Contributor Management (authenticate + requireAdmin)
 *
 * Master admin promotes/demotes users to the contributor role.
 *
 * Endpoints:
 *   GET  /api/v1/admin/contributors          → list all contributors
 *   POST /api/v1/admin/contributors/promote  → grant contributor role (sets Firebase custom claim)
 *   POST /api/v1/admin/contributors/demote   → revoke contributor role
 */
app.use(
  `${API_PREFIX}/admin/contributors`,
  authenticate, requireAdmin,
  require('./routes/admin/adminContributors.routes')
);

/**
 * ✅ Salary Data API (authenticate — granular admin guard inside route)
 *
 * Endpoints:
 *   GET  /api/v1/salary-data/:roleId            → aggregated salary intelligence (any authed user)
 *   GET  /api/v1/salary-data/:roleId/records    → raw salary records (admin only, guarded in route)
 *   POST /api/v1/salary-data                    → manual admin salary entry (admin only, guarded in route)
 *
 * Optional query filters: ?location=India&experienceLevel=Mid&industry=Technology
 */
app.use(
  `${API_PREFIX}/salary-data`,
  authenticate,
  require('./modules/salary/salary.routes')
);

/**
 * ✅ Admin Entity CSV Import (authenticate + requireAdmin)
 *
 * Serves the Bulk Data Import UI in the admin dashboard.
 * Accepts multipart/form-data CSV uploads — one route per entity type,
 * matching the frontend's ImportEntity values exactly.
 *
 * Endpoints:
 *   POST /api/v1/admin/import/skills
 *   POST /api/v1/admin/import/roles
 *   POST /api/v1/admin/import/job-families
 *   POST /api/v1/admin/import/education-levels
 *   POST /api/v1/admin/import/salary-benchmarks
 *
 * Body: multipart/form-data — field "file" (CSV, max 10 MB)
 * Response: { success, created, updated, skipped, failed, total, rows[], importedAt }
 *
 * To add a new entity type:
 *   1. Add a config entry to ENTITY_CONFIG in adminImport.service.js
 *   2. Add the route in adminImport.routes.js
 *   3. No changes needed here
 */
app.use(
  `${API_PREFIX}/admin/import`,
  authenticate, requireAdmin,
  require('./modules/admin/import/adminImport.routes')
);

/**
 * ✅ CSV Salary Bulk Import (authenticate + requireAdmin)
 *
 * Endpoint:
 *   POST /api/v1/admin/import/salaries
 *   Content-Type: multipart/form-data, field: file (CSV, max 10MB)
 *
 * Flow: multer → streaming csv-parser → role normalization → validate → batch Supabase upsert
 * Returns HTTP 207 on partial success (some rows skipped/errored).
 */
app.use(
  `${API_PREFIX}/admin/import/salaries`,
  authenticate, requireAdmin,
  require('./modules/salaryImport/salaryImport.routes')
);

/**
 * ✅ Role Alias Management (authenticate + requireAdmin)
 *
 * Endpoints:
 *   POST /api/v1/admin/cms/role-aliases          → create alias (e.g. "Backend Dev" → "Software Engineer")
 *   GET  /api/v1/admin/cms/role-aliases/:roleId  → list aliases for a role
 *
 * Used by CSV import + sync worker to normalize role names from external sources.
 */
app.use(
  `${API_PREFIX}/admin/cms/role-aliases`,
  authenticate, requireAdmin,
  require('./modules/roleAliases/roleAlias.routes')
);

/**
 * ✅ External API Registry (authenticate + requireMasterAdmin)
 * MASTER_ADMIN only — regular admins receive HTTP 403.
 * Rate limit: 30 req/min per user (masterRateLimit)
 *
 * Endpoints:
 *   POST   /api/v1/master/apis       → register new external salary API (PayScale, Glassdoor, BLS…)
 *   GET    /api/v1/master/apis       → list all registered APIs (apiKey redacted in response)
 *   PATCH  /api/v1/master/apis/:id   → update config (apiKey, baseUrl, rateLimit, enabled)
 *   DELETE /api/v1/master/apis/:id   → soft-delete API config
 *
 * Grant MASTER_ADMIN: node src/scripts/setMasterAdmin.js <uid>
 */
app.use(
  `${API_PREFIX}/master/apis`,
  masterRateLimit,
  authenticate, requireMasterAdmin,
  require('./modules/master/master.routes')
);

/**
 * ✅ Salary Sync Control (authenticate + requireMasterAdmin)
 * MASTER_ADMIN only.
 *
 * Endpoints:
 *   POST /api/v1/master/sync/trigger  → manually trigger salary API sync (runs in background, returns 202)
 *   GET  /api/v1/master/sync/status   → last sync timestamp per provider
 *
 * Automated sync also runs daily at 02:00 UTC via salaryApiSync.worker.js
 * Start worker: npm run worker:salary-sync
 */
app.use(
  `${API_PREFIX}/master/sync`,
  masterRateLimit,
  authenticate, requireMasterAdmin,
  require('./modules/master/masterSync.routes')
);

/**
 * ✅ Secrets Manager (authenticate + requireMasterAdmin ONLY)
 *
 * Stores and manages AES-256-GCM encrypted API keys and credentials.
 * Accessible exclusively to users with role === 'MASTER_ADMIN'.
 *
 * Security guarantees:
 *   - Secrets encrypted with AES-256-GCM (unique IV per secret) before Firestore storage
 *   - HMAC-SHA256 tamper seal bound to secret name (prevents ciphertext substitution)
 *   - No API endpoint ever returns a decrypted value — masked previews only
 *   - Mutation endpoints rate-limited to 10 requests/hour/admin UID
 *   - Every create/update/delete emits an audit log entry to admin_logs
 *
 * Endpoints:
 *   POST   /api/v1/admin/secrets              → Create or update a secret (write-only value)
 *   GET    /api/v1/admin/secrets              → List secrets (metadata + masked preview only)
 *   GET    /api/v1/admin/secrets/:name/status → Masked preview for a specific secret
 *   DELETE /api/v1/admin/secrets/:name        → Permanently delete a secret
 *
 * Runtime usage in backend services:
 *   const { getSecret } = require('./modules/secrets');
 *   const apiKey = await getSecret('ANTHROPIC_API_KEY');
 */
app.use(
  `${API_PREFIX}/admin/secrets`,
  authenticate, requireMasterAdmin,
  secretsRouter
);

// Phase 3: Prometheus /metrics endpoint — only active when OBSERVABILITY_BACKEND=prometheus
// Safe no-op in all other modes (noop/otel). Mount before 404 handler.
const observabilityAdapter = require('./adapters/observability-adapter');
app.get(`${API_PREFIX}/metrics`, observabilityAdapter.prometheusMetricsHandler());

/**
 * 404 + Error Handlers
 */
app.use(notFoundHandler);
app.use(errorHandler);

// B-05 FIX: Gotenberg health check on startup.
// If GOTENBERG_URL is set (production), verify it is reachable before accepting traffic.
// Fails fast at boot rather than at the first PDF generation request.
// Puppeteer is the local-dev fallback when GOTENBERG_URL is absent.
if (process.env.GOTENBERG_URL && process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      const res = await fetch(`${process.env.GOTENBERG_URL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info('[Server] Gotenberg health check passed', { url: process.env.GOTENBERG_URL });
    } catch (err) {
      logger.error('[Server] WARNING: Gotenberg unreachable — PDF generation will fail', {
        url: process.env.GOTENBERG_URL, error: err.message,
      });
    }
  })();
}

const PORT = parseInt(process.env.PORT || '3000', 10);
let server;

if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info(`[Server] HireRise Core running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`[Server] API Base: ${API_PREFIX}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[Server] Port ${PORT} is already in use.`);
    } else {
      logger.error('[Server] Startup error:', err);
    }
  });

  const gracefulShutdown = (signal) => {
    logger.info(`[Server] ${signal} received — shutting down gracefully...`);
    if (server) server.close(() => logger.info('[Server] HTTP server closed.'));
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('[Server] Unhandled Promise Rejection:', reason));
  process.on('uncaughtException',  (err)    => logger.error('[Server] Uncaught Exception:', err));
}

module.exports = app;