/**
 * requestValidator.js — Reusable Validation Middleware Factory
 *
 * Built on express-validator. Routes define validation chains; this
 * middleware runs them and either passes to the next handler or throws
 * a structured AppError that the central error handler formats consistently.
 *
 * Usage in a route file:
 *   const { validate } = require('../middleware/requestValidator');
 *   const { body, param, query } = require('express-validator');
 *
 *   router.post('/salary/benchmark',
 *     validate([
 *       body('roleId').isString().notEmpty().trim(),
 *       body('experienceYears').isInt({ min: 0, max: 60 }),
 *     ]),
 *     salaryController.getBenchmark
 *   );
 */

'use strict';

const { validationResult } = require('express-validator');
const { AppError, ErrorCodes } = require('./errorHandler');

const validate = (chains) => {
  return [
    ...chains,

    (req, res, next) => {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        const formattedErrors = errors.array().map(err => ({
          field: err.path,
          message: err.msg,
          value: err.value,
          location: err.location,
        }));

        return next(
          new AppError(
            'Request validation failed',
            400,
            { fields: formattedErrors },
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      next();
    },
  ];
};

module.exports = { validate };
