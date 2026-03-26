'use strict';

/**
 * chiV2.routes.js
 *
 * Mounted: app.use(`${API_PREFIX}/chi-v2`, authenticate, require('./modules/chiV2/chiV2.routes'));
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                 │ Description                                        │
 * ├────────────────────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /calculate           │ CHI v2 score only                                  │
 * │ POST   │ /skill-gap           │ Skill gap analysis + learning path                 │
 * │ POST   │ /career-path         │ Career path BFS + timeline + next role             │
 * │ POST   │ /opportunities       │ Career opportunity ranking (market intelligence)   │
 * │ POST   │ /full-intelligence   │ All four engines combined                          │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 */

const express      = require('express');
const { body }     = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const ctrl         = require('./chiV2.controller');

const router = express.Router();

const VALID_EDUCATION = ['none', 'high_school', 'diploma', 'bachelors', 'masters', 'mba', 'phd'];
const VALID_LEVELS    = ['beginner', 'intermediate', 'advanced', 'expert'];

const profileValidators = [
  body('target_role').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  body('current_role').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  body('skills').optional().isArray({ max: 100 }),
  body('skills.*').optional().isString().trim().notEmpty().isLength({ max: 100 }),
  body('skill_levels').optional().isArray({ max: 100 }),
  body('skill_levels.*.skill').optional().isString().trim().notEmpty().isLength({ max: 100 }),
  body('skill_levels.*.level').optional().isString().isIn(VALID_LEVELS),
  body('education_level').optional({ nullable: true }).isString().isIn(VALID_EDUCATION),
  body('years_experience').optional({ nullable: true }).isFloat({ min: 0, max: 60 }).toFloat(),
  body('current_salary').optional({ nullable: true }).isFloat({ min: 0 }).toFloat(),
  body('country').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  body('top_n').optional({ nullable: true }).isInt({ min: 1, max: 10 }).toInt(),
];

router.post('/calculate',         validate(profileValidators), ctrl.calculate);
router.post('/skill-gap',         validate(profileValidators), ctrl.skillGap);
router.post('/career-path',       validate(profileValidators), ctrl.careerPath);
router.post('/opportunities',     validate(profileValidators), ctrl.opportunities);
router.post('/full-intelligence', validate(profileValidators), ctrl.fullIntelligence);

module.exports = router;








