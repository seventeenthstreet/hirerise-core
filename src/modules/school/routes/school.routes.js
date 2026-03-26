'use strict';

/**
 * routes/school.routes.js
 *
 * Mount in server.js BEFORE the 404 handler:
 *
 *   app.use(
 *     `${API_PREFIX}/school`,
 *     authenticate,
 *     require('./modules/school/routes/school.routes')
 *   );
 *
 * ── Endpoint Map ───────────────────────────────────────────────────────────────
 *
 *   POST   /api/v1/school                                      → create school (any auth user)
 *   GET    /api/v1/school/my                                   → schools I belong to
 *   GET    /api/v1/school/:schoolId                            → school detail (member only)
 *   POST   /api/v1/school/:schoolId/counselors                 → add counselor (admin only)
 *   GET    /api/v1/school/:schoolId/counselors                 → list counselors (member)
 *   GET    /api/v1/school/:schoolId/students                   → list students (member)
 *   POST   /api/v1/school/:schoolId/students/import            → CSV bulk import (admin)
 *   POST   /api/v1/school/:schoolId/run-assessment/:studentId  → trigger AI pipeline (member)
 *   GET    /api/v1/school/:schoolId/student-report/:studentId  → full student report (member)
 *   GET    /api/v1/school/:schoolId/analytics                  → school analytics (member)
 */

const { Router } = require('express');
const multer     = require('multer');

const controller = require('../controllers/school.controller');
const { requireSchoolMember, requireSchoolAdmin } = require('../middleware/school.middleware');

const router = Router();

// Multer — memory storage, 5MB limit, CSV only
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted.'), false);
    }
  },
});

// ── Public (any authenticated user) ──────────────────────────────────────────

/**
 * POST /api/v1/school
 * Create a new school. Caller becomes the school_admin.
 * Body: { school_name: string, location?: string }
 */
router.post('/', controller.createSchool);

/**
 * GET /api/v1/school/my
 * Returns all schools the caller is admin/counselor of.
 */
router.get('/my', controller.getMySchools);

// ── School-scoped routes (requireSchoolMember or requireSchoolAdmin) ──────────

/**
 * GET /api/v1/school/:schoolId
 * Returns school details. Members only.
 */
router.get('/:schoolId', requireSchoolMember, controller.getSchool);

/**
 * POST /api/v1/school/:schoolId/counselors
 * Add a counselor by email. School admin only.
 * Body: { email: string }
 */
router.post('/:schoolId/counselors', requireSchoolAdmin, controller.addCounselor);

/**
 * GET /api/v1/school/:schoolId/counselors
 * List all counselors. Members.
 */
router.get('/:schoolId/counselors', requireSchoolMember, controller.getCounselors);

/**
 * GET /api/v1/school/:schoolId/students
 * List all students with assessment status. Members.
 */
router.get('/:schoolId/students', requireSchoolMember, controller.listStudents);

/**
 * POST /api/v1/school/:schoolId/students/import
 * Bulk CSV import. School admin only.
 * Body: multipart/form-data with field "file" (CSV)
 * CSV columns: name, email, class, section
 */
router.post(
  '/:schoolId/students/import',
  requireSchoolAdmin,
  upload.single('file'),
  controller.importStudents
);

/**
 * POST /api/v1/school/:schoolId/run-assessment/:studentId
 * Trigger full AI pipeline for a student. Members.
 */
router.post('/:schoolId/run-assessment/:studentId', requireSchoolMember, controller.runAssessment);

/**
 * GET /api/v1/school/:schoolId/student-report/:studentId
 * Full aggregated career report for a student. Members.
 */
router.get('/:schoolId/student-report/:studentId', requireSchoolMember, controller.getStudentReport);

/**
 * GET /api/v1/school/:schoolId/analytics
 * School-level analytics. Members.
 */
router.get('/:schoolId/analytics', requireSchoolMember, controller.getAnalytics);

module.exports = router;









