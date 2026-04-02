'use strict';

/**
 * jobApplications.routes.js (PRODUCTION READY)
 */

const { Router } = require('express');
const { z } = require('zod');

const {
  create,
  list,
  update,
  remove,
} = require('./controllers/jobApplications.controller');

const {
  validateBody,
  validateQuery,
  validateParams,
  dateString,
} = require('../middleware/validation.schemas');

const {
  VALID_STATUSES,
  VALID_SOURCES,
} = require('./repository/jobApplications.repository');

const router = Router();

// ─────────────────────────────────────────────
// 🔹 COMMON
// ─────────────────────────────────────────────

// UUID validation (Supabase uses uuid)
const IdParamSchema = z.object({
  id: z.string().uuid('Invalid application ID'),
});

// Cursor format: createdAt|id
const CursorSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T.*\|[a-f0-9\-]+$/,
    'Invalid cursor format'
  );

// ─────────────────────────────────────────────
// 🔹 SCHEMAS
// ─────────────────────────────────────────────

const CreateApplicationSchema = z.object({
  companyName: z.string().min(1).max(200),

  jobTitle: z.string().min(1).max(200),

  emailSentTo: z
    .string()
    .email()
    .transform((v) => v.toLowerCase())
    .optional()
    .nullable(),

  appliedDate: dateString.optional(),

  status: z.enum(VALID_STATUSES).default('applied'),

  notes: z.string().max(2000).optional().nullable(),

  followUpDate: dateString.optional().nullable(),

  source: z.enum(VALID_SOURCES).optional().nullable(),
}).strict();

const UpdateApplicationSchema = z.object({
  companyName: z.string().min(1).max(200).optional(),

  jobTitle: z.string().min(1).max(200).optional(),

  emailSentTo: z
    .string()
    .email()
    .transform((v) => v.toLowerCase())
    .optional()
    .nullable(),

  appliedDate: dateString.optional(),

  status: z.enum(VALID_STATUSES).optional(),

  notes: z.string().max(2000).optional().nullable(),

  followUpDate: dateString.optional().nullable(),

  source: z.enum(VALID_SOURCES).optional().nullable(),
})
.strict()
.refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided to update.' }
);

const ListApplicationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),

  cursor: CursorSchema.optional(),

  status: z.enum(VALID_STATUSES).optional(),
});

// ─────────────────────────────────────────────
// 🔹 ROUTES
// ─────────────────────────────────────────────

// CREATE
router.post(
  '/',
  validateBody(CreateApplicationSchema),
  create
);

// LIST
router.get(
  '/',
  validateQuery(ListApplicationsQuerySchema),
  list
);

// UPDATE
router.patch(
  '/:id',
  validateParams(IdParamSchema),
  validateBody(UpdateApplicationSchema),
  update
);

// DELETE
router.delete(
  '/:id',
  validateParams(IdParamSchema),
  remove
);

module.exports = router;