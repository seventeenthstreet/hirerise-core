const NodeCache = require("node-cache");

// Default TTL: 10 minutes
// Check period: 2 minutes
const cache = new NodeCache({
  stdTTL: 600,
  checkperiod: 120,
  useClones: false, // Better performance for backend services
});

module.exports = cache;
