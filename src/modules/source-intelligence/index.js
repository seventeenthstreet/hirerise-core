'use strict';

/**
 * src/modules/source-intelligence/index.js
 *
 * Public surface of the SIM module (WP-P2-01). Other modules / the server
 * bootstrap should import from here rather than reaching into internal
 * files, so SIM's internals can evolve without breaking callers — the
 * same convention already used by modules/secrets, modules/skillDemand,
 * modules/daily-engagement, etc.
 */

const routes = require('./routes/source.routes');
const sourceRegistryService = require('./services/sourceRegistry.service');
const sourceHealthService = require('./services/sourceHealth.service');
const sourceGovernanceService = require('./services/sourceGovernance.service');
const sourceTrustService = require('./services/sourceTrust.service');
const sourceRelationshipService = require('./services/sourceRelationship.service');
const simEvents = require('./events/sim.events');
const simModel = require('./models/source.model');

module.exports = {
  routes,
  sourceRegistryService,
  sourceHealthService,
  sourceGovernanceService,
  sourceTrustService,
  sourceRelationshipService,
  simEvents,
  simModel,
};
