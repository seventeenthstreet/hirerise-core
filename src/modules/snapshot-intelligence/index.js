'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/index.js
 *
 * KR-02A — Snapshot Domain Foundation
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Module entry point, following the same top-level module-file
 * convention already used by core-work/src/modules/knowledge-runtime's
 * knowledge-runtime.module.js. KR-02A exported nothing but the domain
 * layer. KR-02B-01 added the repository layer alongside it. KR-02C now
 * adds the computation layer per the same instruction this file's own
 * header already carries — nothing either prior layer exports has been
 * removed or redefined. Later work packages (KR-02D–KR-02J) continue
 * extending this file's exports as their own layers are implemented.
 */

const domain = require('./domain');
const repository = require('./repository');
const computation = require('./computation');

module.exports = {
  domain,
  repository,
  computation,
};
