'use strict';

/**
 * @file src/modules/admin/cms/curriculum/adminCmsCurriculum.routes.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.2
 * Admin Configuration Layer — routes.
 *
 * Mounted in server.js as (matching the existing admin/cms/* convention,
 * e.g. adminCmsSkills.routes.js):
 *
 *   app.use(
 *     `${API_PREFIX}/admin/cms/curriculum`,
 *     authenticate, requireAdmin, requireElevatedSession,
 *     require('./modules/admin/cms/curriculum/adminCmsCurriculum.routes')
 *   );
 *
 * All routes inherit authenticate + requireAdmin + requireElevatedSession
 * from that mount point — same as every other /admin/cms/* mount
 * (career-domains, skill-clusters, job-families, education-levels,
 * salary-benchmarks). No admin identity is ever accepted from the request
 * body (adminId always comes from req.user.id in the controller).
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                                                          │ Purpose     │
 * ├────────────────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /versions                                                     │ list (A)    │
 * │ GET    │ /versions/:versionId                                         │ read        │
 * │ POST   │ /versions                                                    │ create (B)  │
 * │ PATCH  │ /versions/:versionId                                         │ edit (C)    │
 * │ POST   │ /versions/:versionId/validate                                │ validate (H)│
 * │ POST   │ /versions/:versionId/publish                                 │ publish (I) │
 * │ POST   │ /versions/:versionId/archive                                 │ archive (J) │
 * │ POST   │ /versions/:versionId/streams                                 │ streams (D) │
 * │ PATCH  │ /versions/:versionId/streams/:streamId                       │ streams (D) │
 * │ POST   │ /versions/:versionId/pathways                                │ pathways (E)│
 * │ PATCH  │ /versions/:versionId/pathways/:pathwayId                     │ pathways (E)│
 * │ POST   │ /versions/:versionId/subject-mappings                       │ mappings (F)│
 * │ PATCH  │ /versions/:versionId/subject-mappings/:mappingId            │ mappings (F)│
 * │ POST   │ /versions/:versionId/subject-groups                         │ groups (G)  │
 * │ PATCH  │ /versions/:versionId/subject-groups/:groupId                │ groups (G)  │
 * │ POST   │ /versions/:versionId/subject-groups/:groupId/members        │ groups (G)  │
 * │ DELETE │ /versions/:versionId/subject-groups/:groupId/members/:subjectId │ groups (G)│
 * └────────────────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../../../../middleware/requestValidator');
const ctrl = require('./adminCmsCurriculum.controller');
const { NCERT_RELATIONSHIP_VALUES } = require('./adminCmsCurriculum.service');

const router = express.Router();

const idParam = (name) => param(name).isString().trim().notEmpty();

const blockIdentityInjection = [
  body('adminId').not().exists().withMessage('adminId must not be provided in the request body'),
  body('createdBy').not().exists().withMessage('createdBy must not be provided in the request body'),
];

// ── Versions ────────────────────────────────────────────────────────────────

router.get(
  '/versions',
  validate([
    query('boardId').optional().isString().trim().notEmpty(),
    query('status').optional().isIn(['draft', 'published', 'archived']),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ]),
  ctrl.listVersions,
);

router.get('/versions/:versionId', validate([idParam('versionId')]), ctrl.getVersion);

router.post(
  '/versions',
  validate([
    body('boardId').isString().trim().notEmpty(),
    body('regionId').optional({ nullable: true }).isString().trim().notEmpty(),
    body('versionLabel').isString().trim().notEmpty().isLength({ max: 200 }),
    body('effectiveFrom').isISO8601(),
    body('effectiveTo').optional({ nullable: true }).isISO8601(),
    body('ncertRelationship').optional({ nullable: true }).isIn(NCERT_RELATIONSHIP_VALUES),
    body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
    ...blockIdentityInjection,
  ]),
  ctrl.createVersion,
);

router.patch(
  '/versions/:versionId',
  validate([
    idParam('versionId'),
    body('regionId').optional({ nullable: true }).isString().trim().notEmpty(),
    body('versionLabel').optional().isString().trim().notEmpty().isLength({ max: 200 }),
    body('effectiveFrom').optional().isISO8601(),
    body('effectiveTo').optional({ nullable: true }).isISO8601(),
    body('ncertRelationship').optional({ nullable: true }).isIn(NCERT_RELATIONSHIP_VALUES),
    body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
    ...blockIdentityInjection,
  ]),
  ctrl.updateVersion,
);

router.post('/versions/:versionId/validate', validate([idParam('versionId')]), ctrl.validateVersion);
router.post('/versions/:versionId/publish', validate([idParam('versionId')]), ctrl.publishVersion);
router.post('/versions/:versionId/archive', validate([idParam('versionId')]), ctrl.archiveVersion);

// ── Streams ─────────────────────────────────────────────────────────────────

router.post(
  '/versions/:versionId/streams',
  validate([
    idParam('versionId'),
    body('streamCode').isString().trim().notEmpty(),
    body('streamName').isString().trim().notEmpty(),
    body('applicableFromClass').optional({ nullable: true }).isInt({ min: 1 }),
    body('applicableToClass').optional({ nullable: true }).isInt({ min: 1 }),
  ]),
  ctrl.createStream,
);

router.patch(
  '/versions/:versionId/streams/:streamId',
  validate([
    idParam('versionId'), idParam('streamId'),
    body('streamName').optional().isString().trim().notEmpty(),
    body('applicableFromClass').optional({ nullable: true }).isInt({ min: 1 }),
    body('applicableToClass').optional({ nullable: true }).isInt({ min: 1 }),
    body('isActive').optional().isBoolean(),
  ]),
  ctrl.updateStream,
);

// ── Pathways ────────────────────────────────────────────────────────────────

router.post(
  '/versions/:versionId/pathways',
  validate([
    idParam('versionId'),
    body('streamId').isString().trim().notEmpty(),
    body('pathwayCode').isString().trim().notEmpty(),
    body('pathwayName').isString().trim().notEmpty(),
    body('externalReference').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  ]),
  ctrl.createPathway,
);

router.patch(
  '/versions/:versionId/pathways/:pathwayId',
  validate([
    idParam('versionId'), idParam('pathwayId'),
    body('pathwayName').optional().isString().trim().notEmpty(),
    body('externalReference').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body('isActive').optional().isBoolean(),
  ]),
  ctrl.updatePathway,
);

// ── Subject mappings ──────────────────────────────────────────────────────

router.post(
  '/versions/:versionId/subject-mappings',
  validate([
    idParam('versionId'),
    body('subjectId').isString().trim().notEmpty(),
    body('streamId').optional({ nullable: true }).isString().trim().notEmpty(),
    body('pathwayId').optional({ nullable: true }).isString().trim().notEmpty(),
    body('isMandatory').optional().isBoolean(),
  ]),
  ctrl.createSubjectMapping,
);

router.patch(
  '/versions/:versionId/subject-mappings/:mappingId',
  validate([
    idParam('versionId'), idParam('mappingId'),
    body('isMandatory').optional().isBoolean(),
    body('isActive').optional().isBoolean(),
  ]),
  ctrl.updateSubjectMapping,
);

// ── Subject groups ────────────────────────────────────────────────────────

router.post(
  '/versions/:versionId/subject-groups',
  validate([
    idParam('versionId'),
    body('streamId').optional({ nullable: true }).isString().trim().notEmpty(),
    body('pathwayId').optional({ nullable: true }).isString().trim().notEmpty(),
    body('groupCode').isString().trim().notEmpty(),
    body('groupLabel').isString().trim().notEmpty(),
    body('minSelect').isInt({ min: 0 }),
    body('maxSelect').isInt({ min: 0 }),
  ]),
  ctrl.createSubjectGroup,
);

router.patch(
  '/versions/:versionId/subject-groups/:groupId',
  validate([
    idParam('versionId'), idParam('groupId'),
    body('groupLabel').optional().isString().trim().notEmpty(),
    body('minSelect').optional().isInt({ min: 0 }),
    body('maxSelect').optional().isInt({ min: 0 }),
    body('isActive').optional().isBoolean(),
  ]),
  ctrl.updateSubjectGroup,
);

router.post(
  '/versions/:versionId/subject-groups/:groupId/members',
  validate([
    idParam('versionId'), idParam('groupId'),
    body('subjectId').isString().trim().notEmpty(),
  ]),
  ctrl.addGroupMember,
);

router.delete(
  '/versions/:versionId/subject-groups/:groupId/members/:subjectId',
  validate([idParam('versionId'), idParam('groupId'), idParam('subjectId')]),
  ctrl.removeGroupMember,
);

module.exports = router;
