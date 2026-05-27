'use strict';

/**
 * src/modules/admin/import/importDependency.utils.js
 *
 * Utility re-export for import dependency validators.
 *
 * adminImport.service (a *.service.js file) cannot import
 * importDependency.service (another *.service.js) directly per governance
 * Doc 08 — Dependency Rules. This utility file acts as the boundary point.
 *
 * Governance: resolves adminImport.service → importDependency.service violation.
 */

const {
  checkDependencies,
  getNextStep,
  getImportStatus,
  IMPORT_STEPS,
  TABLES,
} = require('./importDependency.service');

module.exports = {
  checkDependencies,
  getNextStep,
  getImportStatus,
  IMPORT_STEPS,
  TABLES,
};
