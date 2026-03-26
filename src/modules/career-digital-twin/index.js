'use strict';

/**
 * modules/career-digital-twin/index.js
 *
 * Barrel export for the Career Digital Twin module.
 * Import this file to access the public-facing service and router.
 *
 * Usage in server.js:
 *
 *   const { digitalTwinRouter } = require('./modules/career-digital-twin');
 *   app.use(`${API_PREFIX}/career`, authenticate, digitalTwinRouter);
 */

const digitalTwinRouter  = require('./routes/digitalTwin.routes');
const digitalTwinService = require('./services/digitalTwin.service');
const engine             = require('../../engines/career-digital-twin.engine');

module.exports = {
  digitalTwinRouter,
  digitalTwinService,
  engine,
};









