'use strict';

/**
 * src/modules/marketIntelligence/marketIntelligence.service.js
 *
 * Market Intelligence service layer.
 * Fully Supabase-optimized, Firebase-clean, and production hardened.
 *
 * DB Tables:
 *   - market_intelligence_cache  (PK: id text — deterministic upserts)
 *   - market_intelligence_sync   (PK: id bigint identity — append-only sync log)
 *
 * Indexes:
 *   - idx_market_sync_synced_at_desc  ON market_intelligence_sync (synced_at DESC)
 */

const {
  getSecret,
  upsertSecret,
} = require('../secrets/secrets.service');

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ───────────────────────────────────────────────────────────────────────────────
// Table References
// Hardcoded after migration confirmed both tables exist with correct schema.
// ───────────────────────────────────────────────────────────────────────────────

const CACHE_TABLE = 'market_intelligence_cache';
const SYNC_TABLE  = 'market_intelligence_sync';

const PROVIDERS = Object.freeze({
  ADZUNA:  'adzuna',
  SERPAPI: 'serpapi',
  CUSTOM:  'custom',
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function cacheKey(role, country) {
  return `${normalizeText(role)
    .replace(/\s+/g, '_')
    .toLowerCase()}_${normalizeText(country, 'in').toLowerCase()}`;
}

async function getProviderOrNull() {
  try {
    const provider = await getSecret('MARKET_API_PROVIDER');
    return provider || null;
  } catch (error) {
    logger.warn('Market provider secret unavailable', {
      error: error.message,
    });
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────

async function saveConfig(config, adminUid) {
  const provider = normalizeText(config?.provider);

  if (!Object.values(PROVIDERS).includes(provider)) {
    throw Object.assign(
      new Error(`Unsupported provider: ${provider}`),
      { status: 400 }
    );
  }

  const operations = [
    upsertSecret('MARKET_API_PROVIDER', provider, adminUid),
  ];

  switch (provider) {
    case PROVIDERS.ADZUNA:
      operations.push(
        upsertSecret('MARKET_ADZUNA_APP_ID', config.appId, adminUid),
        upsertSecret('MARKET_ADZUNA_APP_KEY', config.appKey, adminUid)
      );
      break;

    case PROVIDERS.SERPAPI:
      operations.push(
        upsertSecret('MARKET_SERPAPI_KEY', config.apiKey, adminUid)
      );

      if (config.searchEngine) {
        operations.push(
          upsertSecret(
            'MARKET_SERPAPI_ENGINE',
            config.searchEngine,
            adminUid
          )
        );
      }
      break;

    case PROVIDERS.CUSTOM:
      operations.push(
        upsertSecret('MARKET_CUSTOM_BASE_URL', config.baseUrl, adminUid),
        upsertSecret('MARKET_CUSTOM_API_KEY', config.apiKey, adminUid),
        upsertSecret(
          'MARKET_CUSTOM_AUTH_TYPE',
          config.authType || 'bearer',
          adminUid
        )
      );
      break;
  }

  await Promise.all(operations);

  return {
    provider,
    savedAt: nowIso(),
    message: `${provider} credentials saved`,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// STATUS
// ───────────────────────────────────────────────────────────────────────────────

async function getStatus() {
  const provider = await getProviderOrNull();

  const { data, error } = await supabase
    .from(SYNC_TABLE)
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('Failed to fetch market sync status', {
      table: SYNC_TABLE,
      error: error.message,
    });
  }

  return {
    provider,
    isConfigured: Boolean(provider),
    lastSync: data?.synced_at || null,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// DATA SOURCES
// ───────────────────────────────────────────────────────────────────────────────

async function getDataSources() {
  const provider = await getProviderOrNull();

  const [cacheResult, syncResult] = await Promise.allSettled([
    supabase
      .from(CACHE_TABLE)
      .select('*', { count: 'exact', head: true }),
    supabase
      .from(SYNC_TABLE)
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (cacheResult.status === 'rejected') {
    logger.warn('Failed to fetch market cache count', {
      table: CACHE_TABLE,
      error: cacheResult.reason?.message,
    });
  }

  if (syncResult.status === 'rejected') {
    logger.warn('Failed to fetch market sync record', {
      table: SYNC_TABLE,
      error: syncResult.reason?.message,
    });
  }

  const count     = cacheResult.value?.count ?? 0;
  const lastSync  = syncResult.value?.data?.synced_at || null;

  return {
    sources: [
      {
        name:        'Market Intelligence API',
        provider,
        isConfigured: Boolean(provider),
        status:       provider ? 'connected' : 'not_configured',
        lastSync,
        recordCount:  count,
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// TEST CONNECTION
// ───────────────────────────────────────────────────────────────────────────────

async function testConnection() {
  const provider = await getProviderOrNull();

  if (!provider) {
    return {
      connected: false,
      message: 'No provider configured',
    };
  }

  try {
    const result = await fetchDemandFromProvider(
      'Software Engineer',
      'in',
      provider
    );

    return {
      connected: true,
      provider,
      ...result,
      message:  'Connection successful',
      testedAt: nowIso(),
    };
  } catch (error) {
    logger.error('Market provider connection test failed', {
      provider,
      error: error.message,
    });

    return {
      connected: false,
      provider,
      message: error.message,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// FETCH DEMAND
// ───────────────────────────────────────────────────────────────────────────────

async function fetchDemand(role, country = 'in') {
  const provider = await getProviderOrNull();

  if (!provider) {
    throw Object.assign(
      new Error('Provider not configured'),
      { status: 503 }
    );
  }

  const normalizedRole    = normalizeText(role);
  const normalizedCountry = normalizeText(country, 'in').toLowerCase();
  const result            = await fetchDemandFromProvider(
    normalizedRole,
    normalizedCountry,
    provider
  );

  const timestamp = nowIso();
  const id        = cacheKey(normalizedRole, normalizedCountry);

  const [cacheWrite, syncWrite] = await Promise.allSettled([
    supabase.from(CACHE_TABLE).upsert(
      {
        id,
        ...result,
        cached_at: timestamp,
      },
      { onConflict: 'id' }
    ),
    supabase.from(SYNC_TABLE).insert({
      role:      normalizedRole,
      country:   normalizedCountry,
      provider,
      synced_at: timestamp,
    }),
  ]);

  if (cacheWrite.status === 'rejected') {
    logger.warn('Market cache upsert failed', {
      table: CACHE_TABLE,
      error: cacheWrite.reason?.message,
      role:  normalizedRole,
    });
  }

  if (syncWrite.status === 'rejected') {
    logger.warn('Market sync insert failed', {
      table: SYNC_TABLE,
      error: syncWrite.reason?.message,
      role:  normalizedRole,
    });
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// PROVIDER DISPATCH
// ───────────────────────────────────────────────────────────────────────────────

async function fetchDemandFromProvider(role, country, provider) {
  switch (provider) {
    case PROVIDERS.ADZUNA:
      return fetchFromAdzuna(role, country);
    case PROVIDERS.SERPAPI:
      return fetchFromSerpApi(role, country);
    case PROVIDERS.CUSTOM:
      return fetchFromCustom(role, country);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Provider error ${response.status}`);
  }

  return response.json();
}

async function fetchFromAdzuna(role, country) {
  const [appId, appKey] = await Promise.all([
    getSecret('MARKET_ADZUNA_APP_ID'),
    getSecret('MARKET_ADZUNA_APP_KEY'),
  ]);

  const url = new URL(
    `https://api.adzuna.com/v1/api/jobs/${country}/search/1`
  );

  url.searchParams.set('app_id',  appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('what',    role);

  const json = await fetchJson(url.toString());

  return {
    role,
    country,
    job_postings:  json.count ?? 0,
    salary_median: json.mean  ?? null,
    growth_rate:   null,
    remote_ratio:  0,
    provider:      PROVIDERS.ADZUNA,
    fetched_at:    nowIso(),
  };
}

async function fetchFromSerpApi(role, country) {
  const apiKey = await getSecret('MARKET_SERPAPI_KEY');

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q',        role);
  url.searchParams.set('location', country);
  url.searchParams.set('api_key',  apiKey);

  const json = await fetchJson(url.toString());

  return {
    role,
    country,
    job_postings:  json.search_information?.total_results ?? 0,
    salary_median: null,
    growth_rate:   null,
    remote_ratio:  0,
    provider:      PROVIDERS.SERPAPI,
    fetched_at:    nowIso(),
  };
}

async function fetchFromCustom(role, country) {
  const [baseUrl, apiKey] = await Promise.all([
    getSecret('MARKET_CUSTOM_BASE_URL'),
    getSecret('MARKET_CUSTOM_API_KEY'),
  ]);

  const url = new URL('/demand', baseUrl);
  url.searchParams.set('role',    role);
  url.searchParams.set('country', country);

  const json = await fetchJson(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  return {
    role,
    country,
    job_postings:  json.job_postings  ?? 0,
    salary_median: json.salary_median ?? null,
    growth_rate:   json.growth_rate   ?? null,
    remote_ratio:  json.remote_ratio  ?? 0,
    provider:      PROVIDERS.CUSTOM,
    fetched_at:    nowIso(),
  };
}

module.exports = {
  saveConfig,
  getStatus,
  getDataSources,
  testConnection,
  fetchDemand,
};