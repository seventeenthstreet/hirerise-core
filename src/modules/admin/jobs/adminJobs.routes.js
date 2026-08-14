'use strict';

const { Router }       = require('express');
const multer            = require('multer');
const rateLimit        = require('express-rate-limit');
const { query, param } = require('express-validator');
const { validate }     = require('../../../middleware/requestValidator');
const { syncJobs, uploadJobsCsv } = require('./controllers/jobSync.controller');
const {
  listJobs,
  getJob,
  getSyncStatus,
  listSyncLogs,
} = require('./controllers/job.controller');
const { authenticate, requireAdmin } = require('../../../middleware/auth.middleware');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

const router = Router();

/**
 * IMPORTANT:
 * Ensure in main app:
 *   app.set('trust proxy', 1);
 * when running behind load balancers (Cloud Run / Nginx / etc).
 *
 * Mounted in server.js as:
 *   app.use(`${API_PREFIX}/admin/jobs`, authenticate, requireAdmin,
 *            requireElevatedSession, require('./modules/admin/jobs/adminJobs.routes'))
 * All routes below inherit that chain. The inline authenticate/requireAdmin
 * on POST /sync (pre-existing) is redundant with the mount-point chain but
 * left as-is — not part of WP-ADMIN-COMP-06's scope.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                     │ Description                    │
 * ├────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/jobs              │ List jobs (search/source/page) │
 * │ GET    │ /admin/jobs/sync/status  │ Current sync lock state        │
 * │ GET    │ /admin/jobs/sync/logs    │ Recent sync history            │
 * │ GET    │ /admin/jobs/:id          │ Job detail                     │
 * │ POST   │ /admin/jobs/sync         │ Trigger a manual job sync (URL)│
 * │ POST   │ /admin/jobs/sync/upload  │ Trigger a manual job sync (CSV │
 * │        │                          │ file upload)                   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * WP-ADMIN-COMP-06: added GET / , GET /:id, GET /sync/status,
 * GET /sync/logs. GET /sync/status and GET /sync/logs are registered
 * before GET /:id so the wildcard param route doesn't swallow them; GET
 * /:id is registered after the /sync method-block so a non-POST request
 * to exactly "/sync" still gets that block's 405, not a 400 from the
 * :id UUID validator matching the literal string "sync" (see the comment
 * directly above the GET /:id route below).
 *
 * WP-ADMIN-COMP-06-R2: added POST /sync/upload — a second Trigger-Sync
 * entry point (CSV file upload instead of a source URL) feeding the
 * *same* jobSync.service pipeline as POST /sync. It is registered
 * BEFORE the router.all('/sync', ...) 405 catch-all below, and before
 * GET /:id, for the same wildcard-swallowing reasons already documented
 * above for /sync/status and /sync/logs — "/sync/upload" would otherwise
 * either 405 from the /sync catch-all or fail :id UUID validation as
 * `:id = "sync/upload"`.
 */

/**
 * Multer config for POST /admin/jobs/sync/upload — memory storage only
 * (uploaded CSV is parsed in-process and never touches disk or an object
 * store), single field "file", 10MB cap, CSV MIME/extension allowlist.
 * Mirrors the established salaryImport.routes.js CSV-upload convention
 * (src/modules/salaryImport/salaryImport.routes.js) so admin CSV uploads
 * behave consistently across modules.
 */
const MAX_CSV_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

const CSV_UPLOAD_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

function csvUploadFileFilter(req, file, cb) {
  const fileName = String(file?.originalname || '').toLowerCase();
  const mimeType = String(file?.mimetype || '').toLowerCase();

  const isCsv = CSV_UPLOAD_MIME_TYPES.has(mimeType) && fileName.endsWith('.csv');

  if (!isCsv) {
    return cb(
      new AppError(
        'Only CSV files are accepted',
        400,
        { mimeType, fileName },
        ErrorCodes.VALIDATION_ERROR
      )
    );
  }

  return cb(null, true);
}

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CSV_UPLOAD_BYTES,
    files: 1,
  },
  fileFilter: csvUploadFileFilter,
});

/**
 * Multer-specific error normalization — same pattern as
 * salaryImport.routes.js.
 */
function normalizeCsvUploadError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new AppError(
        'CSV file exceeds maximum allowed size of 10MB',
        400,
        { maxSizeBytes: MAX_CSV_UPLOAD_BYTES },
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  return error;
}

const syncRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,

  // Let express-rate-limit handle IP detection correctly via trust proxy.
  handler: (req, res) => {
    logger.warn('[AdminJobSyncRateLimit] limit exceeded', {
      ip: req.ip,
      path: req.originalUrl,
    });

    // Phase 2B.2 — normalized to V2 canonical envelope.
    // Previous shape { success: false, message: string } was missing error object.
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many sync requests. Maximum 5 per 15 minutes per IP. Please try again later.',
      },
      meta: {
        retryAfter: 15 * 60,
        timestamp: new Date().toISOString(),
      },
    });
  },

  // Optional skip logic (safe for internal probes)
  skip: (req) => req.headers['x-internal-health-check'] === 'true',
});

/**
 * GET /admin/jobs
 */
router.get(
  '/',
  validate([
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1-100'),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be >= 0'),
    query('search').optional().isString().trim().isLength({ max: 150 }).withMessage('search must be at most 150 characters'),
    query('source').optional().isString().trim().isLength({ max: 100 }).withMessage('source must be at most 100 characters'),
  ]),
  listJobs
);

/**
 * GET /admin/jobs/sync/status
 * Must be registered before GET /:id so it is not swallowed by the
 * wildcard param route below.
 */
router.get('/sync/status', getSyncStatus);

/**
 * GET /admin/jobs/sync/logs
 * Same ordering requirement as /sync/status above.
 */
router.get(
  '/sync/logs',
  validate([
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1-100'),
  ]),
  listSyncLogs
);

/**
 * POST /admin/jobs/sync
 */
router.post(
  '/sync',
  syncRateLimiter,
  authenticate,
  requireAdmin,
  syncJobs
);

/**
 * POST /admin/jobs/sync/upload
 *
 * Registered before the /sync method-block's catch-all router.all('/sync', ...)
 * below — Express matches routes in registration order, and '/sync/upload'
 * does not literally match the '/sync' path pattern, but is placed here
 * regardless to keep both Trigger-Sync entry points visually and
 * structurally adjacent.
 */
router.post(
  '/sync/upload',
  syncRateLimiter,
  authenticate,
  requireAdmin,
  (req, res, next) => {
    csvUpload.single('file')(req, res, (error) => {
      if (error) {
        return next(normalizeCsvUploadError(error));
      }
      return next();
    });
  },
  uploadJobsCsv
);

/**
 * Explicitly block other methods on /sync
 */
router.all('/sync', (req, res) => {
  return res.status(405).json({
    success: false,
    message: 'Method Not Allowed',
  });
});

/**
 * GET /admin/jobs/:id
 *
 * Registered AFTER the /sync method-block above (not before, despite the
 * table order at the top of this file): if this wildcard route were
 * registered first, a non-POST request to exactly "/sync" (e.g. a
 * malformed GET /admin/jobs/sync) would match `:id = "sync"` here, fail
 * isUUID() validation, and return 400 — instead of the intended 405
 * Method Not Allowed from router.all('/sync', ...) above. Registering
 * this last preserves that existing 405 behavior for /sync.
 */
router.get(
  '/:id',
  validate([
    param('id').isUUID().withMessage('id must be a valid UUID'),
  ]),
  getJob
);

module.exports = router;