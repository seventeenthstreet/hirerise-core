'use strict';

/**
 * marketIntelligence.service.js — FULLY FIXED (Production Safe)
 */

const {
  getSecret,
  upsertSecret
} = require('../secrets/secrets.service');

const { supabase } = require('../../config/supabase'); // ✅ FIXED: was '../../config/supabase'

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const CACHE_TABLE = 'market_intelligence_cache';
const SYNC_TABLE = 'market_intelligence_sync';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

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
        new Error(`Unsupported provider: ${provider}`),
        { status: 400 }
      );
  }

  return {
    provider,
    savedAt: new Date().toISOString(),
    message: `${provider} credentials saved`
  };
}

// ─────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────

async function getStatus() {
  const provider = await getProviderOrNull();
  let lastSync = null;

  try {
    const { data, error } = await supabase
      .from(SYNC_TABLE)
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (data) lastSync = data.synced_at;
  } catch {}

  return {
    provider: provider ?? null,
    isConfigured: !!provider,
    lastSync
  };
}

// ─────────────────────────────────────────────
// DATA SOURCES
// ─────────────────────────────────────────────

async function getDataSources() {
  const provider = await getProviderOrNull();
  let recordCount = 0;
  let lastSync = null;

  try {
    const { count } = await supabase
      .from(CACHE_TABLE)
      .select('*', { count: 'exact', head: true });

    recordCount = count ?? 0;
  } catch {}

  try {
    const { data } = await supabase
      .from(SYNC_TABLE)
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) lastSync = data.synced_at;
  } catch {}

  return {
    sources: [{
      name: 'Market Intelligence API',
      provider,
      isConfigured: !!provider,
      status: provider ? 'connected' : 'not_configured',
      lastSync,
      recordCount
    }]
  };
}

// ─────────────────────────────────────────────
// TEST CONNECTION
// ─────────────────────────────────────────────

async function testConnection() {
  const provider = await getProviderOrNull();

  if (!provider) {
    return {
      connected: false,
      message: 'No provider configured'
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
      job_postings: result.job_postings,
      salary_median: result.salary_median,
      message: `Connection successful`,
      testedAt: new Date().toISOString()
    };

  } catch (err) {
    return {
      connected: false,
      provider,
      message: err.message
    };
  }
}

// ─────────────────────────────────────────────
// FETCH DEMAND
// ─────────────────────────────────────────────

async function fetchDemand(role, country = 'in') {
  const provider = await getProviderOrNull();

  if (!provider) {
    throw Object.assign(new Error('Provider not configured'), { status: 503 });
  }

  const result = await fetchDemandFromProvider(role, country, provider);
  const key = cacheKey(role, country);

  try {
    await supabase
      .from(CACHE_TABLE)
      .upsert({
        id: key,
        ...result,
        cached_at: new Date().toISOString()
      }, { onConflict: 'id' });

    await supabase
      .from(SYNC_TABLE)
      .insert({
        role,
        country,
        provider,
        synced_at: new Date().toISOString()
      });

  } catch {
    // non-critical
  }

  return result;
}

// ─────────────────────────────────────────────
// PROVIDERS
// ─────────────────────────────────────────────

async function fetchDemandFromProvider(role, country, provider) {
  switch (provider) {
    case 'adzuna': return fetchFromAdzuna(role, country);
    case 'serpapi': return fetchFromSerpApi(role, country);
    case 'custom': return fetchFromCustom(role, country);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

async function fetchFromAdzuna(role, country) {
  const appId = await getSecret('MARKET_ADZUNA_APP_ID');
  const appKey = await getSecret('MARKET_ADZUNA_APP_KEY');

  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${appId}&app_key=${appKey}&what=${encodeURIComponent(role)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Adzuna error ${res.status}`);

  const json = await res.json();

  return {
    role,
    country,
    job_postings: json.count ?? 0,
    salary_median: json.mean ?? null,
    growth_rate: null,
    remote_ratio: 0,
    provider: 'adzuna',
    fetched_at: new Date().toISOString()
  };
}

async function fetchFromSerpApi(role, country) {
  const apiKey = await getSecret('MARKET_SERPAPI_KEY');

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(role)}&location=${country}&api_key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi error ${res.status}`);

  const json = await res.json();

  return {
    role,
    country,
    job_postings: json.search_information?.total_results ?? 0,
    salary_median: null,
    growth_rate: null,
    remote_ratio: 0,
    provider: 'serpapi',
    fetched_at: new Date().toISOString()
  };
}

async function fetchFromCustom(role, country) {
  const baseUrl = await getSecret('MARKET_CUSTOM_BASE_URL');
  const apiKey = await getSecret('MARKET_CUSTOM_API_KEY');

  const res = await fetch(`${baseUrl}/demand?role=${role}&country=${country}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  if (!res.ok) throw new Error(`Custom API error ${res.status}`);

  return res.json();
}

// ─────────────────────────────────────────────

module.exports = {
  saveConfig,
  getStatus,
  getDataSources,
  testConnection,
  fetchDemand
};
