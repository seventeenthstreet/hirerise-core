'use strict';

/**
 * globalPolicyArbitrationMesh.service.js — STUB
 *
 * Missing file — would crash server at startup (line 5130).
 *
 * API surface used by server.js:
 *   - initializeGlobalPolicyMesh({ regions })
 *   - shutdownGlobalPolicyMesh()
 */

let _initialized = false;

function initializeGlobalPolicyMesh({ regions } = {}) {
  _initialized = true;
}

function shutdownGlobalPolicyMesh() {
  _initialized = false;
}

module.exports = {
  initializeGlobalPolicyMesh,
  shutdownGlobalPolicyMesh,
};
