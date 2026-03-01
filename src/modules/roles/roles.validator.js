'use strict';

/**
 * roles.validator.js — Zod validation schemas for the Roles module.
 *
 * Follows the project pattern established in validation.schemas (middleware/):
 *   - validateBody / validateQuery factories wrap schemas into Express middleware.
 *   - Schemas are exported so they can be imported directly in tests.
 *   - Unknown fields are stripped (.strict() or .strip()) before data reaches services.
 *
 * All validation happens HERE. Services receive already-validated, already-typed data.
 */

const { z }                    = require('zod');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const {
  MAX_PREVIOUS_ROLES,
  MAX_EXPECTED_ROLES,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_RESULTS,
  MAX_CAREER_HISTORY_ENTRIES,
  MAX_DURATION_MONTHS,
} = require('./roles.types');

// ─── Middleware factories (mirrors validation.schemas pattern) ────────────────

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields = result.error.issues.map(issue => ({
        field:   issue.path.join('.'),
        message: issue.message,
      }));
      return next(new AppError(
        'Request validation failed',
        400,
        { fields },
        ErrorCodes.VALIDATION_ERROR
      ));
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const fields = result.error.issues.map(issue => ({
        field:   issue.path.join('.'),
        message: issue.message,
      }));
      return next(new AppError(
        'Query parameter validation failed',
        400,
        { fields },
        ErrorCodes.VALIDATION_ERROR
      ));
    }
    req.query = result.data;
    next();
  };
}

// ─── Shared primitives ────────────────────────────────────────────────────────

// roleId: Firestore doc IDs are lowercase slugs, e.g. "software-engineer-ii"
const roleIdSchema = z
  .string()
  .min(1, 'roleId cannot be empty')
  .max(128, 'roleId too long')
  .trim();

// ─── GET /roles — query params ────────────────────────────────────────────────

const ListRolesQuerySchema = z.object({
  search:   z.string().max(100).trim().optional(),
  category: z.string().max(100).trim().optional(),
  limit: z
    .string()
    .optional()
    .transform(val => (val ? parseInt(val, 10) : DEFAULT_SEARCH_LIMIT))
    .pipe(z.number().int().min(1).max(MAX_SEARCH_RESULTS)),
  cursor: z.string().max(256).optional(), // for future pagination
});

// ─── GET /roles/:roleId — param ───────────────────────────────────────────────
// Validated in controller via manual check (params are not Zod-wrapped here
// because they are a single field — keeping it simple and consistent with
// how existing route params are handled in the codebase).

// ─── POST /onboarding/roles ───────────────────────────────────────────────────

/**
 * CareerHistoryEntrySchema
 *
 * Validates a single entry in the careerHistory[] array.
 *
 *   roleId         — required; references roles/{id}
 *   durationMonths — required; positive integer (> 0)
 *   isCurrent      — required; only one entry may be true across the array
 *   description    — optional; free-text summary of the role
 */
const CareerHistoryEntrySchema = z.object({
  roleId: roleIdSchema,

  durationMonths: z.coerce
    .number()
    .int('durationMonths must be a whole number')
    .min(1, 'durationMonths must be at least 1')
    .max(MAX_DURATION_MONTHS, `durationMonths cannot exceed ${MAX_DURATION_MONTHS}`),

  isCurrent: z.boolean(),

  description: z
    .string()
    .max(1000, 'description must be 1000 characters or fewer')
    .trim()
    .optional(),
});

const OnboardingRolesBodySchema = z
  .object({
    // ── NEW: structured career history (replaces currentRoleId + previousRoleIds) ──
    careerHistory: z
      .array(CareerHistoryEntrySchema)
      .max(
        MAX_CAREER_HISTORY_ENTRIES,
        `Maximum ${MAX_CAREER_HISTORY_ENTRIES} career history entries allowed`
      )
      .optional(),

    // ── LEGACY: kept for backward compatibility ───────────────────────────────
    // Accepted if careerHistory is not provided. Services handle the fallback.
    currentRoleId: roleIdSchema.optional(),

    previousRoleIds: z
      .array(roleIdSchema)
      .max(MAX_PREVIOUS_ROLES, `Maximum ${MAX_PREVIOUS_ROLES} previous roles allowed`)
      .default([]),

    // ── UNCHANGED: expected/target roles remain flat array ───────────────────
    expectedRoleIds: z
      .array(roleIdSchema)
      .max(MAX_EXPECTED_ROLES, `Maximum ${MAX_EXPECTED_ROLES} expected roles allowed`)
      .min(1, 'At least one expected role is required')
      .default([]),

    // Optional profile fields stored alongside role IDs
    experienceYears: z.coerce
      .number()
      .int()
      .min(0, 'Experience years cannot be negative')
      .max(60, 'Experience years cannot exceed 60')
      .optional(),

    targetLevel: z
      .string()
      .max(50)
      .trim()
      .optional(),

    careerIntent: z
      .enum(['promotion', 'pivot', 'leadership', 'specialisation', 'exploration'], {
        errorMap: () => ({
          message: 'careerIntent must be one of: promotion, pivot, leadership, specialisation, exploration',
        }),
      })
      .optional(),
  })
  .strict()
  // ── Cross-field rules ──────────────────────────────────────────────────────
  .superRefine((data, ctx) => {
    // Must have careerHistory OR currentRoleId — not neither
    if (!data.careerHistory && !data.currentRoleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either careerHistory[] or currentRoleId is required.',
        path: ['careerHistory'],
      });
      return;
    }

    // careerHistory-specific rules
    if (data.careerHistory && data.careerHistory.length > 0) {
      // Only one role may have isCurrent = true
      const currentRoles = data.careerHistory.filter(e => e.isCurrent === true);
      if (currentRoles.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Only one careerHistory entry may have isCurrent = true.',
          path: ['careerHistory'],
        });
      }

      // No duplicate roleIds within careerHistory
      const seen = new Set();
      data.careerHistory.forEach((entry, idx) => {
        if (seen.has(entry.roleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate roleId "${entry.roleId}" in careerHistory.`,
            path: ['careerHistory', idx, 'roleId'],
          });
        }
        seen.add(entry.roleId);
      });
    }
  });

module.exports = {
  // Middleware factories
  validateBody,
  validateQuery,

  // Schemas (exported for testing)
  ListRolesQuerySchema,
  OnboardingRolesBodySchema,
  CareerHistoryEntrySchema,
  roleIdSchema,
};