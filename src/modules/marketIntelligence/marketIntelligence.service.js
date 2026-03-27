'use strict';

/**
 * modules/marketIntelligence/marketIntelligence.service.js
 *
 * Business logic for the Market Intelligence admin feature.
 *
 * Supported providers: adzuna | serpapi | custom
 *
 * Credentials are NEVER stored in plaintext — they are written to and read
 * from the Secrets Manager (modules/secrets) using AES-256-GCM encryption.
 *
 * Secret name convention:
 *   MARKET_API_PROVIDER        — e.g. "adzuna"
 *   MARKET_ADZUNA_APP_ID       — Adzuna app_id
 *   MARKET_ADZUNA_APP_KEY      — Adzuna app_key
 *   MARKET_SERPAPI_KEY         — SerpApi api_key
 *   MARKET_CUSTOM_BASE_URL     — Custom API base URL
 *   MARKET_CUSTOM_API_KEY      — Custom API key
 *   MARKET_CUSTOM_AUTH_TYPE    — bearer | apikey | basic
 *
 * Supabase tables: market_intelligence_cache, market_intelligence_sync
 */
const {
  getSecret,
  upsertSecret
} = require('../secrets/secrets.service');
const supabase = require('../../config/supabase');

const CACHE_COLLECTION = 'market_intelligence_cache';
const SYNC_COLLECTION = 'market_intelligence_sync';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getProviderOrNull() {
  try {
    return await getSecret('MARKET_API_PROVIDER');
  } catch {
    return null;
  }
}

function cacheKey(role, country) {
  return `${role.replace(/\s+/g, '_').toLowerCase()}_${country.toLowerCase()}`;
}

// ─── saveConfig ───────────────────────────────────────────────────────────────

/**
 * Persists provider credentials to the Secrets Manager.
 * Write-only — credentials are encrypted immediately, never returned.
 */
async function saveConfig(config, adminUid) {
  const { provider } = config;
  await upsertSecret('MARKET_API_PROVIDER', provider, adminUid);
  switch (provider) {
    case 'adzuna':
      await upsertSecret('MARKET_ADZUNA_APP_ID', config.appId, adminUid);
      await upsertSecret('MARKET_ADZUNA_APP_KEY', config.appKey, adminUid);
      break;
    case 'serpapi':
      await upsertSecret('MARKET_SERPAPI_KEY', config.apiKey, adminUid);
      if (config.searchEngine) {
        await upsertSecret('MARKET_SERPAPI_ENGINE', config.searchEngine, adminUid);
      }
      break;
    case 'custom':
      await upsertSecret('MARKET_CUSTOM_BASE_URL', config.baseUrl, adminUid);
      await upsertSecret('MARKET_CUSTOM_API_KEY', config.apiKey, adminUid);
      await upsertSecret('MARKET_CUSTOM_AUTH_TYPE', config.authType || 'bearer', adminUid);
      break;
    default:
      throw Object.assign(
        new Error(`Unsupported provider: ${provider}. Must be adzuna | serpapi | custom.`),
        { status: 400 }
      );
  }
  return {
    provider,
    savedAt: new Date().toISOString(),
    message: `${provider} credentials saved to Secrets Manager.`
  };
}

// ─── getStatus ────────────────────────────────────────────────────────────────

async function getStatus() {
  const provider = await getProviderOrNull();
  let lastSync = null;
  try {
    const { data } = await supabase
      .from(SYNC_COLLECTION)
      .select('syncedAt')
      .order('syncedAt', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) lastSync = data.syncedAt ?? null;
  } catch {/* no sync records yet */}
  return {
    provider: provider ?? null,
    isConfigured: !!provider,
    lastSync
  };
}

// ─── getDataSources ───────────────────────────────────────────────────────────

async function getDataSources() {
  const provider = await getProviderOrNull();
  let recordCount = 0;
  let lastSync = null;

  try {
    const { count } = await supabase
      .from(CACHE_COLLECTION)
      .select('*', { count: 'exact', head: true });
    recordCount = count ?? 0;
  } catch {/* empty */}

  try {
    const { data } = await supabase
      .from(SYNC_COLLECTION)
      .select('syncedAt')
      .order('syncedAt', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) lastSync = data.syncedAt ?? null;
  } catch {/* empty */}

  const sources = [{
    name: 'Market Intelligence API',
    provider: provider ?? null,
    isConfigured: !!provider,
    status: provider ? 'connected' : 'not_configured',
    lastSync,
    recordCount
  }];
  return { sources };
}

// ─── testConnection ───────────────────────────────────────────────────────────

async function testConnection() {
  const provider = await getProviderOrNull();
  if (!provider) {
    return {
      connected: false,
      message: 'No provider configured. Save a config first.'
    };
  }
  try {
    // Fire a minimal test query against the configured provider
    const result = await fetchDemandFromProvider('Software Engineer', 'in', provider);
    return {
      connected: true,
      provider,
      job_postings: result.job_postings,
      salary_median: result.salary_median,
      message: `Connection to ${provider} successful.`,
      testedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      connected: false,
      provider,
      message: `Connection test failed: ${err.message}`,
      error: err.message
    };
  }
}

// ─── fetchDemand ──────────────────────────────────────────────────────────────

async function fetchDemand(role, country = 'in') {
  const provider = await getProviderOrNull();
  if (!provider) {
    throw Object.assign(
      new Error('No market intelligence provider configured.'),
      { status: 503 }
    );
  }

  const result = await fetchDemandFromProvider(role, country, provider);

  // Cache result
  const key = cacheKey(role, country);
  try {
    const { error: cacheError } = await supabase
      .from(CACHE_COLLECTION)
      .upsert({
        id: key,
        ...result,
        cachedAt: new Date().toISOString()
      });

    if (cacheError) throw cacheError;

    const { error: syncError } = await supabase
      .from(SYNC_COLLECTION)
      .insert({
        role,
        country,
        provider,
        syncedAt: new Date().toISOString()
      });

    if (syncError) throw syncError;
  } catch {/* cache failure is non-fatal */}

  return result;
}

// ─── Provider adapters ────────────────────────────────────────────────────────

async function fetchDemandFromProvider(role, country, provider) {
  switch (provider) {
    case 'adzuna':
      return fetchFromAdzuna(role, country);
    case 'serpapi':
      return fetchFromSerpApi(role, country);
    case 'custom':
      return fetchFromCustom(role, country);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function fetchFromAdzuna(role, country) {
  const appId = await getSecret('MARKET_ADZUNA_APP_ID');
  const appKey = await getSecret('MARKET_ADZUNA_APP_KEY');
  const countryCode = country.toLowerCase().slice(0, 2);
  const url =
    `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/1` +
    `?app_id=${appId}&app_key=${appKey}` +
    `&results_per_page=1&what=${encodeURIComponent(role)}&content-type=application/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Adzuna API error: HTTP ${res.status}`);
  const json = await res.json();
  return {
    role,
    country,
    job_postings: json.count ?? 0,
    salary_median: json.mean ?? null,
    growth_rate: null,
    remote_ratio: 0,
    provider: 'adzuna',
    fetchedAt: new Date().toISOString()
  };
}

async function fetchFromSerpApi(role, country) {
  const apiKey = await getSecret('MARKET_SERPAPI_KEY');
  const engine = await getSecret('MARKET_SERPAPI_ENGINE').catch(() => 'google_jobs');
  const url =
    `https://serpapi.com/search.json` +
    `?engine=${engine}&q=${encodeURIComponent(role)}&location=${encodeURIComponent(country)}` +
    `&api_key=${apiKey}&num=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi error: HTTP ${res.status}`);
  const json = await res.json();
  const jobs = json.jobs_results ?? [];
  return {
    role,
    country,
    job_postings: json.search_information?.total_results ?? jobs.length,
    salary_median: null,
    growth_rate: null,
    remote_ratio: jobs.filter(j => j.detected_extensions?.work_from_home).length / Math.max(jobs.length, 1),
    provider: 'serpapi',
    fetchedAt: new Date().toISOString()
  };
}

async function fetchFromCustom(role, country) {
  const baseUrl = await getSecret('MARKET_CUSTOM_BASE_URL');
  const apiKey = await getSecret('MARKET_CUSTOM_API_KEY');
  const authType = await getSecret('MARKET_CUSTOM_AUTH_TYPE').catch(() => 'bearer');
  const headers = { 'Content-Type': 'application/json' };
  if (authType === 'bearer') headers['Authorization'] = `Bearer ${apiKey}`;
  if (authType === 'apikey') headers['X-API-Key'] = apiKey;
  if (authType === 'basic') headers['Authorization'] = `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`;
  const url = `${baseUrl}/demand?role=${encodeURIComponent(role)}&country=${encodeURIComponent(country)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Custom API error: HTTP ${res.status}`);
  const json = await res.json();
  return {
    role,
    country,
    job_postings: json.job_postings ?? json.count ?? 0,
    salary_median: json.salary_median ?? json.salary?.median ?? null,
    growth_rate: json.growth_rate ?? null,
    remote_ratio: json.remote_ratio ?? 0,
    provider: 'custom',
    fetchedAt: new Date().toISOString()
  };
}

module.exports = {
  saveConfig,
  getStatus,
  getDataSources,
  testConnection,
  fetchDemand
};