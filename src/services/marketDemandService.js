'use strict';

/**
 * @file src/services/marketDemandService.js
 * @description
 * Supabase-native labor market demand signal service.
 *
 * Fixes applied:
 * - fetchMarketDemand row: 'role' → 'role_id', 'fetchedAt' → 'updated_at'
 * - fetchMarketDemand row: removed 'provider' (column does not exist)
 * - getProviderStatus select/order: 'fetchedAt' → 'updated_at'
 * - getProviderStatus return: 'lastSync' now reads data.updated_at
 * - buildSignalId remains unchanged (used as row id only)
 */

const { getSecret } = require('../modules/secrets');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const TABLE_NAME = 'role_market_demand';
const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';
const SERPAPI_BASE_URL = 'https://serpapi.com/search';
const FETCH_TIMEOUT_MS = 15000;

function normalizeCountry(country = 'in') {
  return String(country || 'in').trim().toLowerCase();
}

function buildSignalId(role, country) {
  const safeRole = String(role)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `${safeRole}_${normalizeCountry(country)}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(
      `API error ${response.status}: ${body.slice(0, 500)}`
    );
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }

  return response.json();
}

async function getProviderConfig() {
  const provider = (
    await getSecret('MARKET_API_PROVIDER')
  ).trim().toLowerCase();

  switch (provider) {
    case 'adzuna': {
      const [appId, appKey, country] = await Promise.all([
        getSecret('MARKET_API_APP_ID'),
        getSecret('MARKET_API_APP_KEY'),
        getSecret('MARKET_API_COUNTRY').catch(() => 'in'),
      ]);

      return {
        provider,
        appId,
        appKey,
        country: normalizeCountry(country),
      };
    }

    case 'serpapi': {
      const [apiKey, searchEngine] = await Promise.all([
        getSecret('MARKET_API_APP_KEY'),
        getSecret('MARKET_API_SEARCH_ENGINE').catch(
          () => 'google_jobs_listing'
        ),
      ]);

      return {
        provider,
        apiKey,
        searchEngine,
      };
    }

    case 'custom': {
      const [baseUrl, apiKey, authType] = await Promise.all([
        getSecret('MARKET_API_BASE_URL'),
        getSecret('MARKET_API_APP_KEY'),
        getSecret('MARKET_API_AUTH_TYPE').catch(() => 'bearer'),
      ]);

      return {
        provider,
        baseUrl: baseUrl.replace(/\/$/, ''),
        apiKey,
        authType: String(authType).trim().toLowerCase(),
      };
    }

    default:
      throw new Error(`Unknown market provider: ${provider}`);
  }
}

async function fetchFromAdzuna(config, role, country) {
  const targetCountry = normalizeCountry(country || config.country);
  const url = new URL(
    `${ADZUNA_BASE_URL}/${targetCountry}/search/1`
  );

  url.searchParams.set('app_id', config.appId);
  url.searchParams.set('app_key', config.appKey);
  url.searchParams.set('results_per_page', '10');
  url.searchParams.set('what', role);
  url.searchParams.set('content-type', 'application/json');

  const data = await fetchJson(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  const results = Array.isArray(data?.results) ? data.results : [];
  const salaryValues = results
    .filter((r) => r.salary_min && r.salary_max)
    .map((r) => (r.salary_min + r.salary_max) / 2);

  const remoteCount = results.filter(
    (r) =>
      r.description?.toLowerCase().includes('remote') ||
      r.title?.toLowerCase().includes('remote')
  ).length;

  return {
    job_postings: data?.count ?? results.length,
    growth_rate: null,
    remote_ratio: results.length
      ? +(remoteCount / results.length).toFixed(2)
      : 0,
  };
}

async function fetchFromSerpAPI(config, role, country) {
  const targetCountry = normalizeCountry(country);
  const url = new URL(SERPAPI_BASE_URL);

  url.searchParams.set(
    'engine',
    config.searchEngine || 'google_jobs_listing'
  );
  url.searchParams.set('q', `${role} ${targetCountry.toUpperCase()}`);
  url.searchParams.set('api_key', config.apiKey);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', targetCountry);

  const data = await fetchJson(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  const jobs = Array.isArray(data?.jobs_results)
    ? data.jobs_results
    : [];

  const remoteCount = jobs.filter(
    (job) =>
      job.detected_extensions?.work_from_home ||
      job.description?.toLowerCase().includes('remote')
  ).length;

  return {
    job_postings: jobs.length,
    growth_rate: null,
    remote_ratio: jobs.length
      ? +(remoteCount / jobs.length).toFixed(2)
      : 0,
  };
}

async function fetchFromCustomAPI(config, role, country) {
  const targetCountry = normalizeCountry(country);
  const url = new URL(config.baseUrl);

  url.searchParams.set('q', role);
  url.searchParams.set('country', targetCountry);

  const headers = { Accept: 'application/json' };

  if (config.authType === 'bearer') {
    headers.Authorization = `Bearer ${config.apiKey}`;
  } else if (config.authType === 'apikey') {
    headers['X-API-Key'] = config.apiKey;
  }

  const data = await fetchJson(url.toString(), { headers });

  const count =
    data?.count ??
    data?.total ??
    data?.results?.length ??
    data?.jobs?.length ??
    0;

  return {
    job_postings: count,
    growth_rate: data?.growth_rate ?? null,
    remote_ratio: data?.remote_ratio ?? 0,
  };
}

async function fetchProviderSignals(config, role, country) {
  switch (config.provider) {
    case 'adzuna':
      return fetchFromAdzuna(config, role, country);
    case 'serpapi':
      return fetchFromSerpAPI(config, role, country);
    case 'custom':
      return fetchFromCustomAPI(config, role, country);
    default:
      throw new Error(`Unhandled provider: ${config.provider}`);
  }
}

async function fetchMarketDemand(role, country = 'in') {
  if (!role || typeof role !== 'string') {
    throw new Error('role is required');
  }

  const normalizedCountry = normalizeCountry(country);
  const config = await getProviderConfig();

  logger.info('[MarketDemand] Fetching signals', {
    provider: config.provider,
    role,
    country: normalizedCountry,
  });

  const signals = await fetchProviderSignals(
    config,
    role,
    normalizedCountry
  );

  const now = new Date().toISOString();

  const row = {
    id: buildSignalId(role, normalizedCountry),
    role_id: role,              // Fix: was 'role' (column does not exist)
    country: normalizedCountry,
    // removed: provider       // Fix: column does not exist in role_market_demand
    ...signals,
    updated_at: now,            // Fix: was 'fetchedAt' (column does not exist)
    last_updated: now,          // kept: exists as text column
  };

  const { error } = await supabase
    .from(TABLE_NAME)
    .upsert(row, { onConflict: 'id' });

  if (error) {
    logger.warn('[MarketDemand] Durable write failed', {
      id: row.id,
      error: error.message,
    });
  }

  return row;
}

async function testConnection() {
  const config = await getProviderConfig();
  const result = await fetchMarketDemand(
    'Software Engineer',
    'in'
  );

  return {
    success: true,
    provider: config.provider,
    job_postings: result.job_postings,
    message: `Connection successful. Job postings: ${result.job_postings.toLocaleString()}`,
  };
}

async function getProviderStatus() {
  try {
    const provider = await getSecret('MARKET_API_PROVIDER');

    const { data } = await supabase
      .from(TABLE_NAME)
      .select('updated_at')                          // Fix: was 'fetchedAt'
      .order('updated_at', { ascending: false })     // Fix: was 'fetchedAt'
      .limit(1)
      .maybeSingle();

    return {
      provider: provider.trim(),
      isConfigured: true,
      lastSync: data?.updated_at || null,            // Fix: was data?.fetchedAt
    };
  } catch {
    return {
      provider: null,
      isConfigured: false,
      lastSync: null,
    };
  }
}

module.exports = {
  fetchMarketDemand,
  testConnection,
  getProviderStatus,
};