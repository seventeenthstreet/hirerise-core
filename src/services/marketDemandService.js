'use strict';

/**
 * marketDemandService.js
 *
 * Fetches labor market demand signals from configured external APIs.
 * Credentials are retrieved ONLY from Secret Manager — never from Supabase
 * or environment variables that could be logged.
 *
 * Supported providers:
 *   - Adzuna     (App ID + App Key)
 *   - SerpAPI    (API Key + search engine)
 *   - Custom API (Base URL + API Key + Auth Type)
 *
 * Output signals stored in Supabase table: role_market_demand
 *   { role, country, job_postings, salary_median, growth_rate, remote_ratio, fetchedAt, provider }
 *
 * @module services/marketDemandService
 */

const { getSecret } = require('../modules/secrets');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = 'role_market_demand';
const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';
const SERPAPI_BASE_URL = 'https://serpapi.com/search';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Retrieve credentials from Secret Manager and return provider config.
 * NEVER logs or serializes the returned credentials.
 */
async function _getProviderConfig() {
  let provider;
  try {
    provider = await getSecret('MARKET_API_PROVIDER');
  } catch {
    throw Object.assign(
      new Error('Market API provider not configured. Please set MARKET_API_PROVIDER in Secret Manager.'),
      { statusCode: 503, code: 'MARKET_API_NOT_CONFIGURED' }
    );
  }

  provider = provider.trim().toLowerCase();

  if (provider === 'adzuna') {
    const [appId, appKey, country] = await Promise.all([
      getSecret('MARKET_API_APP_ID'),
      getSecret('MARKET_API_APP_KEY'),
      getSecret('MARKET_API_COUNTRY').catch(() => 'in'), // default: India
    ]);
    return { provider: 'adzuna', appId, appKey, country: country.trim().toLowerCase() };
  }

  if (provider === 'serpapi') {
    const [apiKey, searchEngine] = await Promise.all([
      getSecret('MARKET_API_APP_KEY'),
      getSecret('MARKET_API_SEARCH_ENGINE').catch(() => 'google_jobs_listing'),
    ]);
    return { provider: 'serpapi', apiKey, searchEngine };
  }

  if (provider === 'custom') {
    const [baseUrl, apiKey, authType] = await Promise.all([
      getSecret('MARKET_API_BASE_URL'),
      getSecret('MARKET_API_APP_KEY'),
      getSecret('MARKET_API_AUTH_TYPE').catch(() => 'bearer'),
    ]);
    return { provider: 'custom', baseUrl, apiKey, authType: authType.trim().toLowerCase() };
  }

  throw Object.assign(new Error(`Unknown market API provider: ${provider}`), {
    statusCode: 400,
    code: 'INVALID_PROVIDER',
  });
}

/**
 * Fetch from Adzuna API.
 * Docs: https://developer.adzuna.com/activedocs
 */
async function _fetchFromAdzuna(config, role, country) {
  const targetCountry = country || config.country || 'in';
  const query = encodeURIComponent(role);
  const url =
    `${ADZUNA_BASE_URL}/${targetCountry}/search/1` +
    `?app_id=${encodeURIComponent(config.appId)}` +
    `&app_key=${encodeURIComponent(config.appKey)}` +
    `&results_per_page=10` +
    `&what=${query}` +
    `&content-type=application/json`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Adzuna API error: ${res.status} ${res.statusText}. ${body}`),
      { statusCode: res.status >= 500 ? 502 : 400, code: 'ADZUNA_API_ERROR' }
    );
  }

  const data = await res.json();

  // Extract signals from Adzuna response
  const jobPostings = data.count ?? data.results?.length ?? 0;
  const results = data.results ?? [];
  const salaryValues = results
    .filter((r) => r.salary_min && r.salary_max)
    .map((r) => (r.salary_min + r.salary_max) / 2);
  const salaryMedian = salaryValues.length
    ? Math.round(salaryValues.reduce((a, b) => a + b, 0) / salaryValues.length)
    : null;
  const remoteCount = results.filter(
    (r) =>
      r.description?.toLowerCase().includes('remote') ||
      r.title?.toLowerCase().includes('remote')
  ).length;
  const remoteRatio = results.length ? +(remoteCount / results.length).toFixed(2) : 0;

  return {
    job_postings: jobPostings,
    salary_median: salaryMedian,
    growth_rate: null, // Adzuna doesn't provide growth rate directly
    remote_ratio: remoteRatio,
    raw_count: jobPostings,
  };
}

/**
 * Fetch from SerpAPI Google Jobs.
 * Docs: https://serpapi.com/google-jobs-api
 */
async function _fetchFromSerpAPI(config, role, country) {
  const countryCode = country || 'in';
  const query = encodeURIComponent(`${role} ${countryCode.toUpperCase()}`);
  const url =
    `${SERPAPI_BASE_URL}` +
    `?engine=${encodeURIComponent(config.searchEngine || 'google_jobs_listing')}` +
    `&q=${query}` +
    `&api_key=${encodeURIComponent(config.apiKey)}` +
    `&hl=en` +
    `&gl=${countryCode}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`SerpAPI error: ${res.status} ${res.statusText}. ${body}`),
      { statusCode: res.status >= 500 ? 502 : 400, code: 'SERPAPI_ERROR' }
    );
  }

  const data = await res.json();
  const jobs = data.jobs_results ?? [];
  const count = jobs.length;

  // Extract salary hints from job descriptions
  const salaryPattern = /[\$₹£€]?\s*(\d[\d,]+)\s*(?:k|K|lpa|LPA)?/g;
  const salaries = [];
  jobs.forEach((j) => {
    const text = [j.title, j.description, j.salary].filter(Boolean).join(' ');
    let m;
    while ((m = salaryPattern.exec(text)) !== null) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 1000 && val < 10_000_000) salaries.push(val);
    }
  });
  const salaryMedian = salaries.length
    ? Math.round(salaries.sort((a, b) => a - b)[Math.floor(salaries.length / 2)])
    : null;
  const remoteCount = jobs.filter(
    (j) =>
      j.detected_extensions?.work_from_home ||
      j.description?.toLowerCase().includes('remote')
  ).length;

  return {
    job_postings: count,
    salary_median: salaryMedian,
    growth_rate: null,
    remote_ratio: count ? +(remoteCount / count).toFixed(2) : 0,
    raw_count: count,
  };
}

/**
 * Fetch from a Custom API.
 * Assumes the API returns JSON with job listings.
 */
async function _fetchFromCustomAPI(config, role, country) {
  const query = encodeURIComponent(role);
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}?q=${query}&country=${country || 'in'}`;

  const headers = { Accept: 'application/json' };
  if (config.authType === 'bearer') {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  } else if (config.authType === 'apikey') {
    headers['X-API-Key'] = config.apiKey;
  } else if (config.authType === 'basic') {
    headers['Authorization'] = `Basic ${Buffer.from(`:${config.apiKey}`).toString('base64')}`;
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Custom API error: ${res.status} ${res.statusText}. ${body}`),
      { statusCode: res.status >= 500 ? 502 : 400, code: 'CUSTOM_API_ERROR' }
    );
  }

  const data = await res.json();
  const count =
    data.count ?? data.total ?? data.results?.length ?? data.jobs?.length ?? 0;

  return {
    job_postings: count,
    salary_median: data.salary_median ?? null,
    growth_rate: data.growth_rate ?? null,
    remote_ratio: data.remote_ratio ?? 0,
    raw_count: count,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * fetchMarketDemand(role, country)
 *
 * Main entry point. Retrieves credentials from Secret Manager,
 * calls the configured API, and stores results in Supabase.
 *
 * @param {string} role    — e.g. "Software Engineer"
 * @param {string} country — ISO 2-letter code, e.g. "in" for India
 * @returns {Promise<MarketDemandSignal>}
 */
async function fetchMarketDemand(role, country = 'in') {
  if (!role || typeof role !== 'string') {
    throw Object.assign(new Error('role is required'), { statusCode: 400 });
  }

  const config = await _getProviderConfig();
  let signals;

  logger.info('[MarketDemand] Fetching demand signals', {
    provider: config.provider,
    role,
    country,
  });

  switch (config.provider) {
    case 'adzuna':
      signals = await _fetchFromAdzuna(config, role, country);
      break;
    case 'serpapi':
      signals = await _fetchFromSerpAPI(config, role, country);
      break;
    case 'custom':
      signals = await _fetchFromCustomAPI(config, role, country);
      break;
    default:
      throw new Error(`Unhandled provider: ${config.provider}`);
  }

  const docId = `${role.toLowerCase().replace(/\s+/g, '_')}_${country}`;

  const record = {
    id: docId,
    role,
    country,
    provider: config.provider,
    job_postings: signals.job_postings,
    salary_median: signals.salary_median,
    growth_rate: signals.growth_rate,
    remote_ratio: signals.remote_ratio,
    fetchedAt: new Date().toISOString(),
  };

  // Store in Supabase — processed signals only, never credentials
  // upsert merges on id so re-fetching a role/country updates the existing row
  const { error } = await supabase
    .from(COLLECTION)
    .upsert([record]);

  if (error) {
    logger.warn('[MarketDemand] Failed to store signals in Supabase (non-fatal)', {
      docId,
      error: error.message,
    });
  } else {
    logger.info('[MarketDemand] Signals stored', {
      docId,
      job_postings: record.job_postings,
      provider: config.provider,
    });
  }

  return record;
}

/**
 * testConnection()
 *
 * Fires a test query ("Software Engineer India") and returns
 * connection health + sample output.
 *
 * @returns {Promise<{ success: boolean, provider: string, job_postings: number, message: string }>}
 */
async function testConnection() {
  const config = await _getProviderConfig();
  const result = await fetchMarketDemand('Software Engineer', 'in');
  return {
    success: true,
    provider: config.provider,
    job_postings: result.job_postings,
    salary_median: result.salary_median,
    message: `Connection Successful. Job postings detected: ${result.job_postings.toLocaleString()}`,
  };
}

/**
 * getProviderStatus()
 *
 * Returns the configured provider name and last sync time — safe for API responses.
 * Credentials are NEVER included.
 *
 * @returns {Promise<{ provider: string|null, lastSync: string|null, isConfigured: boolean }>}
 */
async function getProviderStatus() {
  try {
    const provider = await getSecret('MARKET_API_PROVIDER');

    // Find last sync from Supabase
    const { data, error } = await supabase
      .from(COLLECTION)
      .select('fetchedAt')
      .order('fetchedAt', { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastSync = (!error && data) ? data.fetchedAt : null;

    return {
      provider: provider.trim(),
      isConfigured: true,
      lastSync,
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