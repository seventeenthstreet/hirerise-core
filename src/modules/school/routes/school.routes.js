'use strict';

/**
 * src/modules/school/routes/school.routes.js
 *
 * School module HTTP routes.
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/school`, authenticate, schoolRoutes);
 *
 * Notes:
 * - Fully DB agnostic
 * - Optimized middleware ordering
 * - Hardened CSV upload validation
 * - Route grouping improves maintainability
 */

const { Router } = require('express');
const multer = require('multer');

const controller = require('../controllers/school.controller');
const {
  requireSchoolMember,
  requireSchoolAdmin,
} = require('../middleware/school.middleware');

const router = Router();

/* ──────────────────────────────────────────────────────────────
 * Upload middleware
 * ────────────────────────────────────────────────────────────── */
const MAX_CSV_SIZE_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CSV_SIZE_BYTES,
  },
  fileFilter: (req, file, cb) => {
    const isCsvMime =
      file?.mimetype === 'text/csv' ||
      file?.mimetype === 'application/vnd.ms-excel';

    const isCsvExt =
      typeof file?.originalname === 'string' &&
      file.originalname.toLowerCase().endsWith('.csv');

    if (isCsvMime || isCsvExt) {
      return cb(null, true);
    }

    return cb(new Error('Only CSV files are accepted.'), false);
  },
});

/* ──────────────────────────────────────────────────────────────
 * Public authenticated routes
 * ────────────────────────────────────────────────────────────── */
router.post('/', controller.createSchool);
router.get('/my', controller.getMySchools);

/* ──────────────────────────────────────────────────────────────
 * School member routes
 * ────────────────────────────────────────────────────────────── */
router.get('/:schoolId', requireSchoolMember, controller.getSchool);
router.get('/:schoolId/counselors', requireSchoolMember, controller.getCounselors);
router.get('/:schoolId/students', requireSchoolMember, controller.listStudents);
router.post(
  '/:schoolId/run-assessment/:studentId',
  requireSchoolMember,
  controller.runAssessment
);
router.get(
  '/:schoolId/student-report/:studentId',
  requireSchoolMember,
  controller.getStudentReport
);
router.get('/:schoolId/analytics', requireSchoolMember, controller.getAnalytics);

/* ──────────────────────────────────────────────────────────────
 * School admin routes
 * ────────────────────────────────────────────────────────────── */
router.post(
  '/:schoolId/counselors',
  requireSchoolAdmin,
  controller.addCounselor
);

router.post(
  '/:schoolId/students/import',
  requireSchoolAdmin,
  upload.single('file'),
  controller.importStudents
);

module.exports = router;