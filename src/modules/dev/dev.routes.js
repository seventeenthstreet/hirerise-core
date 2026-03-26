'use strict';

const express = require('express');
const router = express.Router();

const devController = require('./dev.controller');

router.post('/login', devController.generateDevToken);

module.exports = router;








