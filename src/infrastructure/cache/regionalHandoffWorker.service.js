'use strict';

const logger = require('../../utils/logger');
const migration = require('./crossRegionMigration.service');

const DEFAULT_INTERVAL_MS = Number(
  process.env.REGION_MIGRATION_INTERVAL_MS || 30000
);

let intervalRef = null;
let workerRunning = false;

async function executeMigrationCycle(context = 'scheduled') {
  try {
    await migration.runCrossRegionMigrationCycle();

    logger.info(
      `[Patch16] Regional migration cycle completed (${context})`
    );

    return true;
  } catch (error) {
    logger.error('[Patch16] regional migration worker failure', {
      context,
      error: error.message,
    });

    return false;
  }
}

function startRegionalMigrationWorker() {
  if (intervalRef) return;

  const interval =
    Number(process.env.REGION_MIGRATION_INTERVAL_MS) ||
    DEFAULT_INTERVAL_MS;

  workerRunning = true;

  // immediate startup warm handoff cycle
  executeMigrationCycle('startup').catch(() => {});

  intervalRef = setInterval(() => {
    executeMigrationCycle('interval').catch(() => {});
  }, interval);

  logger.info(
    `[Patch16] Regional migration worker started (${interval}ms)`
  );
}

async function stopRegionalMigrationWorker() {
  if (!workerRunning) return;

  workerRunning = false;

  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }

  try {
    await executeMigrationCycle('shutdown');
    logger.info('[Patch16] Regional handoff preserved');
  } catch (error) {
    logger.warn(
      `[Patch16] Shutdown handoff degraded: ${error.message}`
    );
  }
}

function isRegionalMigrationWorkerRunning() {
  return workerRunning;
}

module.exports = {
  startRegionalMigrationWorker,
  stopRegionalMigrationWorker,
  isRegionalMigrationWorkerRunning,
};