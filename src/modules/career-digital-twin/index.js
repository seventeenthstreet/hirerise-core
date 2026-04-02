'use strict';

/**
 * modules/career-digital-twin/index.js
 *
 * Public module barrel for Career Digital Twin.
 *
 * Exposes:
 * - router
 * - service
 * - simulation engine
 *
 * Safe for server.js mounting:
 *
 *   const { digitalTwinRouter } = require('./modules/career-digital-twin');
 *   app.use(`${API_PREFIX}/career`, authenticate, digitalTwinRouter);
 */

const digitalTwinRouter = require('./routes/digitalTwin.routes');
const digitalTwinService = require('./services/digitalTwin.service');
const careerDigitalTwinEngine = require('../../engines/career-digital-twin.engine');

module.exports = Object.freeze({
  digitalTwinRouter,
  digitalTwinService,
  engine: careerDigitalTwinEngine,
});