'use strict';

require('dotenv').config();

const cron = require('node-cron');
const https = require('https');
const http = require('http');

const { supabase } = require('../config/supabase');
const externalApiRepo = require('../modules/master/externalApi.repository');
const salaryRepository = require('../modules/salary/salary.repository');
const roleAliasRepository = require('../modules/roleAliases/roleAlias.repository');
const {
  validateSalaryRecord,
  logImport,
} = require('../modules/salary/salary.service');
const { logAdminAction } = require('../utils/adminAuditLogger');
const logger = require('../utils/logger');
const BaseWorker = require('./shared/BaseWorker');

const WORKER_ID = 'salary-api-sync';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_APIS = 3;

const TABLES = Object.freeze({
  CMS_ROLES: 'cms_roles',
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 20,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
});

function fetchJSON(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const protocol = isHttps ? https : http;

    const req = protocol.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Api-Key': apiKey,
        },
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          try {
            const body = raw ? JSON.parse(raw) : null;
            resolve({
              status: res.statusCode || 500,
              body,
            });
          } catch (error) {
            reject(
              new Error(
                `[${WORKER_ID}] Invalid JSON response: ${error.message}`
              )
            );
          }
        });
      }
    );

    req.on('error', reject);

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`[${WORKER_ID}] Request timeout`));
    });

    req.end();
  });
}

async function normalizeRoleName(roleName, roleCache) {
  const normalized = String(roleName || '').trim().toLowerCase();

  if (!normalized) return null;
  if (roleCache.has(normalized)) return roleCache.get(normalized);

  try {
    const canonical =
      await roleAliasRepository.findCanonicalRole(normalized);

    if (canonical?.roleId) {
      roleCache.set(normalized, canonical.roleId);
      return canonical.roleId;
    }

    const { data, error } = await supabase
      .from(TABLES.CMS_ROLES)
      .select('id')
      .eq('normalized_name', normalized)
      .eq('soft_deleted', false)
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn(`[${WORKER_ID}] cms_roles lookup failed`, {
        normalized,
        error: error.message,
      });

      roleCache.set(normalized, null);
      return null;
    }

    const roleId = data?.id ?? null;
    roleCache.set(normalized, roleId);

    return roleId;
  } catch (error) {
    logger.warn(`[${WORKER_ID}] normalizeRoleName failed`, {
      normalized,
      error: error.message,
    });

    roleCache.set(normalized, null);
    return null;
  }
}

async function processApiResponse(body, providerName, roleCache) {
  const rawRecords = body?.data ?? body?.results ?? body ?? [];

  if (!Array.isArray(rawRecords)) {
    logger.warn(`[${WORKER_ID}] Unexpected response shape`, {
      providerName,
    });
    return [];
  }

  const valid = [];
  let skipped = 0;

  for (const raw of rawRecords) {
    const roleId = await normalizeRoleName(
      raw.role || raw.title || raw.jobTitle,
      roleCache
    );

    if (!roleId) {
      skipped++;
      continue;
    }

    const record = {
      roleId,
      location: raw.location || '',
      experienceLevel: raw.experienceLevel || raw.level || '',
      industry: raw.industry || '',
      minSalary: Number(raw.minSalary ?? raw.min_salary ?? 0),
      medianSalary: Number(
        raw.medianSalary ??
          raw.median_salary ??
          raw.avg_salary ??
          0
      ),
      maxSalary: Number(raw.maxSalary ?? raw.max_salary ?? 0),
      sourceType: 'API',
      sourceName: providerName,
      confidenceScore: 0.9,
    };

    try {
      validateSalaryRecord(record);
      valid.push(record);
    } catch (error) {
      skipped++;

      logger.warn(`[${WORKER_ID}] Invalid salary record skipped`, {
        providerName,
        roleId,
        reason: error.message,
      });
    }
  }

  if (skipped > 0) {
    logger.info(`[${WORKER_ID}] Provider skipped invalid rows`, {
      providerName,
      skipped,
    });
  }

  return valid;
}

class SalaryApiSyncWorker extends BaseWorker {
  constructor() {
    super(WORKER_ID);
  }

  async process({ dateKey }) {
    logger.info(`[${WORKER_ID}] Starting sync`, { dateKey });

    const apis = await externalApiRepo.listEnabled();

    if (!Array.isArray(apis) || apis.length === 0) {
      logger.info(`[${WORKER_ID}] No enabled APIs`);
      return {
        totalInserted: 0,
        totalDuplicates: 0,
        apiCount: 0,
      };
    }

    const roleCache = new Map();
    let totalInserted = 0;
    let totalDuplicates = 0;

    for (const api of apis.slice(0, MAX_CONCURRENT_APIS)) {
      logger.info(`[${WORKER_ID}] Syncing provider`, {
        provider: api.providerName,
      });

      try {
        const url = `${api.baseUrl}${api.salaryPath || '/salaries'}`;
        const { status, body } = await fetchJSON(url, api.apiKey);

        if (status < 200 || status >= 300) {
          logger.warn(`[${WORKER_ID}] Non-success response`, {
            provider: api.providerName,
            status,
          });
          continue;
        }

        const records = await processApiResponse(
          body,
          api.providerName,
          roleCache
        );

        if (records.length > 0) {
          const { inserted, duplicates } =
            await salaryRepository.batchInsert(
              records,
              WORKER_ID
            );

          totalInserted += inserted;
          totalDuplicates += duplicates;
        }

        await externalApiRepo.updateLastSync(api.id);
      } catch (error) {
        logger.error(`[${WORKER_ID}] Provider sync failed`, {
          provider: api.providerName,
          error: error.message,
        });
      }
    }

    await Promise.all([
      logImport({
        datasetType: 'salary-api-sync',
        processed: totalInserted + totalDuplicates,
        created: totalInserted,
        failed: 0,
      }),
      logAdminAction({
        adminId: WORKER_ID,
        action: 'SALARY_API_SYNC_COMPLETED',
        entityType: 'salary_data',
        metadata: {
          totalInserted,
          totalDuplicates,
          apiCount: apis.length,
        },
      }),
    ]);

    logger.info(`[${WORKER_ID}] Sync complete`, {
      totalInserted,
      totalDuplicates,
      apiCount: apis.length,
    });

    return {
      totalInserted,
      totalDuplicates,
      apiCount: apis.length,
    };
  }

  async runSync() {
    const dateKey = new Date().toISOString().slice(0, 10);

    const idempotencyKey =
      BaseWorker.buildIdempotencyKey('system', {
        job: WORKER_ID,
        date: dateKey,
      });

    const { result } = await this.run(
      { dateKey },
      idempotencyKey
    );

    return result;
  }
}

const salaryWorker = new SalaryApiSyncWorker();

cron.schedule(
  '0 2 * * *',
  async () => {
    try {
      await salaryWorker.runSync();
    } catch (error) {
      logger.error(`[${WORKER_ID}] Scheduled sync failed`, {
        error: error.message,
        stack: error.stack,
      });
    }
  },
  { timezone: 'UTC' }
);

logger.info(`[${WORKER_ID}] Worker started`);

if (process.argv.includes('--run-now')) {
  salaryWorker
    .runSync()
    .then(() => {
      logger.info(`[${WORKER_ID}] Manual run complete`);
      process.exit(0);
    })
    .catch((error) => {
      logger.error(`[${WORKER_ID}] Manual run failed`, {
        error: error.message,
      });
      process.exit(1);
    });
}

async function runSalarySync() {
  return salaryWorker.runSync();
}

module.exports = {
  runSalarySync,
};