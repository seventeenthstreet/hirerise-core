'use strict';

/**
 * quorumReplication.service.js — STUB
 *
 * This file was missing from the repository, causing the server to crash at startup
 * with: "Cannot find module './services/cache/quorumReplication.service'"
 *
 * This stub exposes the exact API surface that server.js calls:
 *   - startQuorumReplicationWorker(getMeshFn)
 *   - stopQuorumReplicationWorker()
 */

let _worker = null;

function startQuorumReplicationWorker(getMeshFn) {
  if (_worker) return _worker;
  _worker = { getMeshFn, running: true };
  return _worker;
}

function stopQuorumReplicationWorker() {
  if (_worker) {
    _worker.running = false;
    _worker = null;
  }
}

module.exports = {
  startQuorumReplicationWorker,
  stopQuorumReplicationWorker,
};
