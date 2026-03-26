'use strict';

const express    = require('express');
const { authenticate } = require('../../middleware/auth.middleware');
const { getSummary, logUserEvent } = require('./userActivity.controller');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/user-activity/summary
router.get('/summary', getSummary);

// POST /api/v1/user-activity/log
router.post('/log', logUserEvent);

module.exports = router;








