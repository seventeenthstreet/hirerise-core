'use strict';

/**
 * jobApplications.routes.js
 *
 * Mounted at: /api/v1/applications
 * Auth:       authenticate applied by server.js at mount — do NOT add here.
 *
 * Route chain:
 *   server.js: authenticate → [validateBody|validateQuery] → controller
 *
 * COLLECTION FIELDS (from repository):
 *   companyName, jobTitle, emailSentTo, appliedDate, status,
 *   notes, followUpDate, source, deleted, createdAt, updatedAt
 *
 * VALID_STATUSES (from repository):
 *   applied, rejected, interview_scheduled, interview_completed,
 *   offer_received, offer_accepted, offer_rejected, no_response, withdrawn
 *
 * VALID_SOURCES (from repository):
 *   LinkedIn, Indeed, Referral, Company Website, Other
 */

const { Router } = require('express');
const { z }      = require('zod');

const {
  create,
  list,
  update,
  remove,
} = require('./controllers/jobApplications.controller');

const {
  validateBody,
  validateQuery,
  dateString,
} = require('../middleware/validation.schemas');

const {
  VALID_STATUSES,
  VALID_SOURCES,
} = require('./repository/jobApplications.repository');

const router = Router();

// ─────────────────────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────────────────────

/**
 * CreateApplicationSchema
 * Validates POST /applications body.
 * companyName + jobTitle are required; everything else is optional.
 */
const CreateApplicationSchema = z.object({
  companyName:  z.string().min(1, 'companyName is required').max(200),
  jobTitle:     z.string().min(1, 'jobTitle is required').max(200),
  emailSentTo:  z.string().email('Must be a valid email').optional().nullable(),
  appliedDate:  dateString.optional(),                           // YYYY-MM-DD
  status:       z.enum(VALID_STATUSES).default('applied'),
  notes:        z.string().max(2000).optional().nullable(),
  followUpDate: dateString.optional().nullable(),                // YYYY-MM-DD
  source:       z.enum(VALID_SOURCES).optional().nullable(),
}).strict();

/**
 * UpdateApplicationSchema
 * Validates PATCH /applications/:id body.
 * All fields optional — only send what you want to change.
 */
const UpdateApplicationSchema = z.object({
  companyName:  z.string().min(1).max(200).optional(),
  jobTitle:     z.string().min(1).max(200).optional(),
  emailSentTo:  z.string().email().optional().nullable(),
  appliedDate:  dateString.optional(),
  status:       z.enum(VALID_STATUSES).optional(),
  notes:        z.string().max(2000).optional().nullable(),
  followUpDate: dateString.optional().nullable(),
  source:       z.enum(VALID_SOURCES).optional().nullable(),
}).strict().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided to update.' }
);

/**
 * ListApplicationsQuerySchema
 * Validates GET /applications query params.
 */
const ListApplicationsQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
  status: z.enum(VALID_STATUSES).optional(),
});

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// POST /api/v1/applications
// Create a new tracked job application.
// Free tier: max 8 applications (enforced in service layer).
router.post(
  '/',
  validateBody(CreateApplicationSchema),
  create,
);

// GET /api/v1/applications
// List all applications for the authenticated user.
// Supports cursor-based pagination and optional status filter.
router.get(
  '/',
  validateQuery(ListApplicationsQuerySchema),
  list,
);

// PATCH /api/v1/applications/:id
// Update one or more fields of an existing application.
// Ownership enforced in repository (IDOR guard).
// Blocked on soft-deleted documents.
router.patch(
  '/:id',
  validateBody(UpdateApplicationSchema),
  update,
);

// DELETE /api/v1/applications/:id
// Soft-delete an application (sets deleted:true + deletedAt).
// Ownership enforced in repository.
// Restores free-tier slot (countByUser excludes soft-deleted).
router.delete(
  '/:id',
  remove,
);

module.exports = router;








