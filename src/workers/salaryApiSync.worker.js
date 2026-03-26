'use strict';

/**
 * salaryApiSync.worker.js
 *
 * MIGRATION: Removed both require('../config/supabase') calls (the side-effect
 * import at the top and the destructured { db } import). All DB access now goes
 * through the direct Supabase client.
 *
 * Query change in normalizeRoleName():
 *   OLD: db.collection('cms_roles')
 *          .where('normalizedName', '==', normalized)
 *          .where('softDeleted', '==', false)
 *          .limit(1)
 *          .get()
 *        → snap.docs[0].id
 *
 *   NEW: supabase.from('cms_roles')
 *          .select('id')
 *          .eq('normalized_name', normalized)
 *          .eq('soft_deleted', false)
 *          .limit(1)
 *          .maybeSingle()
 *        → data?.id
 */

require('dotenv').config();

const cron                = require('node-cron');
const https               = require('https');
const http                = require('http');
const supabase            = require('../config/supabase');
const externalApiRepo     = require('../modules/master/externalApi.repository');
const salaryRepository    = require('../modules/salary/salary.repository');
const roleAliasRepository = require('../modules/roleAliases/roleAlias.repository');
const { validateSalaryRecord, logImport } = require('../modules/salary/salary.service');
const { logAdminAction }  = require('../utils/adminAuditLogger');
const logger              = require('../utils/logger');
const BaseWorker          = require('./shared/BaseWorker');

const WORKER_ID = 'salary-api-sync';

// ─── HTTP Fetch helper ────────────────────────────────────────────────────────

function fetchJSON(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'Accept':        'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Api-Key':     apiKey,
      },
      timeout: 15000,
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ─── Role normalization ───────────────────────────────────────────────────────

async function normalizeRoleName(roleName, roleCache) {
  const normalized = (roleName || '').toLowerCase().trim();
  if (!normalized) return null;
  if (roleCache.has(normalized)) return roleCache.get(normalized);

  // Check role alias table first
  const canonical = await roleAliasRepository.findCanonicalRole(normalized);
  if (canonical) {
    roleCache.set(normalized, canonical.roleId);
    return canonical.roleId;
  }

  // Fall back to cms_roles lookup
  const { data, error } = await supabase
    .from('cms_roles')
    .select('id')
    .eq('normalized_name', normalized)
    .eq('soft_deleted', false)
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn(`[SalarySyncWorker] cms_roles lookup failed for "${normalized}"`, { error: error.message });
    roleCache.set(normalized, null);
    return null;
  }

  const roleId = data?.id ?? null;
  roleCache.set(normalized, roleId);
  return roleId;
}

// ─── Process API response ─────────────────────────────────────────────────────

async function processApiResponse(body, providerName, roleCache) {
  const rawRecords = body?.data ?? body?.results ?? body ?? [];
  if (!Array.isArray(rawRecords)) {
    logger.warn(`[SalarySyncWorker] Unexpected response shape from ${providerName}`);
    return [];
  }

  const valid   = [];
  let   skipped = 0;

  for (const raw of rawRecords) {
    const roleId = await normalizeRoleName(raw.role || raw.title || raw.jobTitle, roleCache);
    if (!roleId) {
      skipped++;
      continue;
    }

    const record = {
      roleId,
      location:        raw.location        || '',
      experienceLevel: raw.experienceLevel || raw.level || '',
      industry:        raw.industry        || '',
      minSalary:       Number(raw.minSalary    || raw.min_salary),
      medianSalary:    Number(raw.medianSalary || raw.median_salary || raw.avg_salary),
      maxSalary:       Number(raw.maxSalary    || raw.max_salary),
      sourceType:      'API',
      sourceName:      providerName,
      confidenceScore: 0.9,
    };

    try {
      validateSalaryRecord(record);
      valid.push(record);
    } catch (err) {
      skipped++;
      logger.warn(`[SalarySyncWorker] Skipping invalid record from ${providerName}`, {
        reason: err.message,
        roleId,
        minSalary:    record.minSalary,
        medianSalary: record.medianSalary,
        maxSalary:    record.maxSalary,
      });
    }
  }

  if (skipped > 0) {
    logger.info(`[SalarySyncWorker] ${providerName} — skipped ${skipped} invalid records`);
  }

  return valid;
}

// ─── Worker class ─────────────────────────────────────────────────────────────

class SalaryApiSyncWorker extends BaseWorker {
  constructor() {
    super('salary-api-sync');
  }

  /**
   * @param {{ dateKey: string }} payload
   */
  async process({ dateKey }) {
    logger.info(`[${WORKER_ID}] Starting salary API sync for ${dateKey}`);

    const apis = await externalApiRepo.listEnabled();

    if (apis.length === 0) {
      logger.info(`[${WORKER_ID}] No enabled APIs. Sync skipped.`);
      return { totalInserted: 0, totalDuplicates: 0, apiCount: 0 };
    }

    logger.info(`[${WORKER_ID}] Found ${apis.length} enabled API(s)`);

    const roleCache     = new Map();
    let totalInserted   = 0;
    let totalDuplicates = 0;

    for (const api of apis) {
      logger.info(`[${WORKER_ID}] Syncing from ${api.providerName}`);

      try {
        const url = `${api.baseUrl}${api.salaryPath || '/salaries'}`;
        const { status, body } = await fetchJSON(url, api.apiKey);

        if (status < 200 || status >= 300) {
          logger.warn(`[${WORKER_ID}] ${api.providerName} returned HTTP ${status}`);
          continue;
        }

        const records = await processApiResponse(body, api.providerName, roleCache);

        if (records.length > 0) {
          const { inserted, duplicates } = await salaryRepository.batchInsert(records, WORKER_ID);
          totalInserted   += inserted;
          totalDuplicates += duplicates;
          logger.info(`[${WORKER_ID}] ${api.providerName} — inserted: ${inserted}, dupes: ${duplicates}`);
        }

        await externalApiRepo.updateLastSync(api.id);

      } catch (err) {
        logger.error(`[${WORKER_ID}] Failed to sync from ${api.providerName}`, { error: err.message });
      }
    }

    await logImport({
      datasetType: 'salary-api-sync',
      processed:   totalInserted + totalDuplicates,
      created:     totalInserted,
      failed:      0,
    });

    await logAdminAction({
      adminId:    WORKER_ID,
      action:     'SALARY_API_SYNC_COMPLETED',
      entityType: 'salary_data',
      metadata:   { totalInserted, totalDuplicates, apiCount: apis.length },
    });

    logger.info(`[${WORKER_ID}] Sync complete`, { totalInserted, totalDuplicates, apiCount: apis.length });
    return { totalInserted, totalDuplicates, apiCount: apis.length };
  }

  async runSync() {
    const dateKey = new Date().toISOString().split('T')[0];

    const idempotencyKey = BaseWorker.buildIdempotencyKey('system', {
      job:  'salary-api-sync',
      date: dateKey,
    });

    const { result } = await this.run({ dateKey }, idempotencyKey);
    return result;
  }
}

const salaryWorker = new SalaryApiSyncWorker();

// ─── Cron Schedule: 02:00 UTC daily ──────────────────────────────────────────

cron.schedule('0 2 * * *', async () => {
  try {
    await salaryWorker.runSync();
  } catch (err) {
    logger.error(`[${WORKER_ID}] Unhandled sync error`, { error: err.message, stack: err.stack });
  }
}, { timezone: 'UTC' });

logger.info(`[${WORKER_ID}] Worker started. Next run: 02:00 UTC daily.`);

if (process.argv.includes('--run-now')) {
  salaryWorker.runSync().then(() => {
    logger.info(`[${WORKER_ID}] Manual run complete. Exiting.`);
    process.exit(0);
  }).catch(err => {
    logger.error(`[${WORKER_ID}] Manual run failed`, err);
    process.exit(1);
  });
}

async function runSalarySync() {
  return salaryWorker.runSync();
}

module.exports = { runSalarySync };








