'use strict';

/**
 * careerHealthIndex.routes.js — UPDATED
 *
 * Removed duplicate authenticate calls (already applied at server.js mount point).
 * Added GET /provisional to expose the latest CHI regardless of analysisSource.
 */

const { Router } = require('express');
const { calculateChi, getLatestChi, getChiHistory, getProvisionalChi } = require('./controllers/careerHealthIndex.controller');

const router = Router();

router.post('/calculate',   calculateChi);
router.get('/latest',       getLatestChi);
router.get('/history',      getChiHistory);
router.get('/provisional',  getProvisionalChi);

module.exports = router;
