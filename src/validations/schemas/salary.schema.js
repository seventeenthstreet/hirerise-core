'use strict';

import { body } from 'express-validator';
import { SALARY_FIELDS } from '../constants/fields.js';

/**
 * Validation schema for POST /v1/salary/benchmark
 *
 * Fields:
 *   jobTitle        – required string, job title to benchmark
 *   location        – required string, location for salary data
 *   yearsExperience – required integer 0–50
 *   industry        – optional string, industry segment
 */
export const salaryBenchmarkSchema = [
  body()
    .custom((_, { req }) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Error('Invalid request body');
      }
      const extra = Object.keys(req.body).filter(
        (key) => !SALARY_FIELDS.includes(key),
      );
      if (extra.length > 0) {
        throw new Error(`Unknown fields: ${extra.join(', ')}`);
      }
      return true;
    }),

  body('jobTitle')
    .isString()
    .withMessage('jobTitle must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('jobTitle is required')
    .bail()
    .isLength({ max: 200 })
    .withMessage('jobTitle must not exceed 200 characters'),

  body('location')
    .isString()
    .withMessage('location must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('location is required')
    .bail()
    .isLength({ max: 200 })
    .withMessage('location must not exceed 200 characters'),

  body('yearsExperience')
    .isInt({ min: 0, max: 50 })
    .withMessage('yearsExperience must be an integer between 0 and 50')
    .bail()
    .toInt(),

  body('industry')
    .optional()
    .isString()
    .withMessage('industry must be a string')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('industry must not exceed 100 characters'),
];