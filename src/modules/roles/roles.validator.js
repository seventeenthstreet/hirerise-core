'use strict';

/**
 * src/modules/roles/roles.validator.js
 *
 * Zod validation schemas for the Roles module.
 *
 * Supabase-safe validation layer:
 *   - no Firebase terminology
 *   - strict request normalization
 *   - onboarding backward compatibility
 */

const { z } = require('zod');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const {
  MAX_PREVIOUS_ROLES,
  MAX_EXPECTED_ROLES,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_RESULTS,
  MAX_CAREER_HISTORY_ENTRIES,
  MAX_DURATION_MONTHS,
} = require('./roles.types');

/* -------------------------------------------------------------------------- */
/* Middleware factories                                                        */
/* -------------------------------------------------------------------------- */

function buildValidationError(error, message) {
  const fields = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));

  return new AppError(
    message,
    400,
    { fields },
    ErrorCodes.VALIDATION_ERROR
  );
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return next(buildValidationError(result.error, 'Request validation failed'));
    }

    req.body = result.data;
    return next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      return next(buildValidationError(result.error, 'Query parameter validation failed'));
    }

    req.query = result.data;
    return next();
  };
}

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                           */
/* -------------------------------------------------------------------------- */

const roleIdSchema = z
  .string()
  .min(1, 'roleId cannot be empty')
  .max(128, 'roleId too long')
  .trim();

/* -------------------------------------------------------------------------- */
/* GET /roles                                                                  */
/* -------------------------------------------------------------------------- */

const ListRolesQuerySchema = z.object({
  search: z.string().max(100).trim().optional(),
  category: z.string().max(100).trim().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => {
      const parsed = Number.parseInt(String(val ?? ''), 10);
      return Number.isNaN(parsed) ? DEFAULT_SEARCH_LIMIT : parsed;
    })
    .pipe(z.number().int().min(1).max(MAX_SEARCH_RESULTS)),
  cursor: z.string().max(256).optional(),
});

/* -------------------------------------------------------------------------- */
/* POST /onboarding/roles                                                      */
/* -------------------------------------------------------------------------- */

const CareerHistoryEntrySchema = z.object({
  roleId: roleIdSchema,

  durationMonths: z.coerce
    .number()
    .int('durationMonths must be a whole number')
    .min(1, 'durationMonths must be at least 1')
    .max(
      MAX_DURATION_MONTHS,
      `durationMonths cannot exceed ${MAX_DURATION_MONTHS}`
    ),

  isCurrent: z.boolean(),

  description: z
    .string()
    .max(1000, 'description must be 1000 characters or fewer')
    .trim()
    .optional(),
});

const OnboardingRolesBodySchema = z
  .object({
    careerHistory: z
      .array(CareerHistoryEntrySchema)
      .min(1, 'careerHistory cannot be empty')
      .max(
        MAX_CAREER_HISTORY_ENTRIES,
        `Maximum ${MAX_CAREER_HISTORY_ENTRIES} career history entries allowed`
      )
      .optional(),

    currentRoleId: roleIdSchema.optional(),

    previousRoleIds: z
      .array(roleIdSchema)
      .max(
        MAX_PREVIOUS_ROLES,
        `Maximum ${MAX_PREVIOUS_ROLES} previous roles allowed`
      )
      .default([]),

    expectedRoleIds: z
      .array(roleIdSchema)
      .max(
        MAX_EXPECTED_ROLES,
        `Maximum ${MAX_EXPECTED_ROLES} expected roles allowed`
      )
      .min(1, 'At least one expected role is required')
      .default([]),

    experienceYears: z.coerce
      .number()
      .int()
      .min(0, 'Experience years cannot be negative')
      .max(60, 'Experience years cannot exceed 60')
      .optional(),

    targetLevel: z.string().max(50).trim().optional(),

    careerIntent: z
      .enum([
        'promotion',
        'pivot',
        'leadership',
        'specialisation',
        'exploration',
      ])
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.careerHistory && !data.currentRoleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either careerHistory[] or currentRoleId is required.',
        path: ['careerHistory'],
      });
      return;
    }

    if (data.careerHistory?.length) {
      const currentRoles = data.careerHistory.filter((e) => e.isCurrent);

      if (currentRoles.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Only one careerHistory entry may have isCurrent = true.',
          path: ['careerHistory'],
        });
      }

      const seen = new Set();

      data.careerHistory.forEach((entry, index) => {
        if (seen.has(entry.roleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate roleId "${entry.roleId}" in careerHistory.`,
            path: ['careerHistory', index, 'roleId'],
          });
        }

        seen.add(entry.roleId);
      });
    }
  });

module.exports = {
  validateBody,
  validateQuery,
  ListRolesQuerySchema,
  OnboardingRolesBodySchema,
  CareerHistoryEntrySchema,
  roleIdSchema,
};