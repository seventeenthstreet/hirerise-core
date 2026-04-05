'use strict';

/**
 * @file src/services/jobFetcher.service.js
 * @description
 * Supabase-native job listings fetcher with:
 * - memory cache
 * - durable Supabase cache
 * - Adzuna live fallback
 * - TTL expiry enforcement
 * - null-safe normalization
 * - query projection optimization
 *
 * Fixes applied:
 * - TABLE_NAME corrected from 'job_listings' to 'job_listings_cache'
 * - storeJobListings row keys aligned to actual snake_case DB columns
 * - storedAt removed (column does not exist in job_listings_cache)
 * - readCachedFromSupabase select/filter fields aligned to snake_case columns
 * - readCachedFromSupabase return mapping aligned to snake_case response keys
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');
const { detectUserCountry } = require('./salary.service');

const cache = cacheManager.getClient();

const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const RESULTS_PER_PAGE = 10;
const TABLE_NAME = 'job_listings_cache'; // Fix: was 'job_listings' (table does not exist)

const ADZUNA_COUNTRY_MAP = {
  IN: 'in',
  US: 'us',
  GB: 'gb',
  CA: 'ca',
  AU: 'au',
  DE: 'de',
  AE: 'ae',
  SG: 'sg',
};

const ADZUNA_FALLBACK_COUNTRY = 'in';

async function getAdzunaCredentials() {
  const { getSecret } = require('../modules/secrets');

  try {
    const [appId, appKey] = await Promise.all([
      getSecret('ADZUNA_APP_ID'),
      getSecret('ADZUNA_APP_KEY'),
    ]);

    return { appId, appKey };
  } catch (_) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    if (appId && appKey) {
      return { appId, appKey };
    }

    return null;
  }
}

function buildCacheKey(userId, role, country) {
  const safeRole = String(role || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `jobs:${userId}:${safeRole}:${country}`;
}

function buildRowId(userId, cacheKey) {
  return `${userId}__${cacheKey.replace(/[:/]/g, '_')}`;
}

function normalizeJobs(results = [], fallbackCountry) {
  if (!Array.isArray(results)) return [];

  return results.map((job) => ({
    id: job?.id || null,
    title: job?.title || 'Untitled',
    company: job?.company?.display_name || 'Unknown Company',
    location:
      job?.location?.display_name || String(fallbackCountry || 'IN').toUpperCase(),
    description: String(job?.description || '').slice(0, 500),
    salary: {
      min: job?.salary_min ?? null,
      max: job?.salary_max ?? null,
      currency: job?.salary_currency || 'GBP',
    },
    postedAt: job?.created || new Date().toISOString(),
    redirectUrl: job?.redirect_url || null,
    category: job?.category?.label || null,
    contractType: job?.contract_type || null,
    source: 'adzuna',
  }));
}

async function fetchFromAdzuna({
  appId,
  appKey,
  role,
  skills,
  country,
  resultsPerPage = RESULTS_PER_PAGE,
}) {
  const adzunaCountry =
    ADZUNA_COUNTRY_MAP[country] || ADZUNA_FALLBACK_COUNTRY;

  const topSkills = Array.isArray(skills)
    ? skills.filter(Boolean).slice(0, 3).join(' ')
    : '';

  const query = [role, topSkills].filter(Boolean).join(' ');

  const url = new URL(`${ADZUNA_BASE_URL}/${adzunaCountry}/search/1`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('results_per_page', String(resultsPerPage));
  url.searchParams.set('what', query);
  url.searchParams.set('content-type', 'application/json');
  url.searchParams.set('sort_by', 'relevance');

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Adzuna API error ${response.status}: ${body.slice(0, 200)}`
    );
  }

  const data = await response.json();

  const jobs = normalizeJobs(data?.results, adzunaCountry);

  return {
    jobs,
    totalResults: data?.count || jobs.length,
    query,
    country: adzunaCountry,
    fetchedAt: new Date().toISOString(),
  };
}

async function storeJobListings(userId, cacheKey, result) {
  const rowId = buildRowId(userId, cacheKey);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_SECONDS * 1000);

  const row = {
    id: rowId,
    user_id: userId,           // Fix: was userId
    cache_key: cacheKey,       // Fix: was cacheKey
    jobs: result.jobs || [],
    total_count: result.totalResults || 0, // Fix: was totalResults
    query: result.query || '',
    country: result.country || ADZUNA_FALLBACK_COUNTRY,
    fetched_at: result.fetchedAt || now.toISOString(), // Fix: was fetchedAt
    expires_at: expiresAt.toISOString(),               // Fix: was expiresAt
    // removed: storedAt — column does not exist in job_listings_cache
  };

  const { error } = await supabase
    .from(TABLE_NAME)
    .upsert(row, { onConflict: 'id' });

  if (error) {
    logger.warn('[JobFetcher] Durable cache write failed', {
      userId,
      error: error.message,
    });
  }
}

async function readCachedFromSupabase(userId, cacheKey) {
  const rowId = buildRowId(userId, cacheKey);

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(
      `
      jobs,
      total_count,
      query,
      country,
      fetched_at,
      expires_at
    `
    )                                              // Fix: all fields now snake_case
    .eq('id', rowId)
    .gt('expires_at', new Date().toISOString())   // Fix: was expiresAt
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    jobs: Array.isArray(data.jobs) ? data.jobs : [],
    totalResults: data.total_count || 0,          // Fix: was data.totalResults
    query: data.query || '',
    country: data.country || ADZUNA_FALLBACK_COUNTRY,
    fetchedAt: data.fetched_at || new Date().toISOString(), // Fix: was data.fetchedAt
    source: 'supabase_cache',
  };
}

async function setMemoryCache(cacheKey, payload) {
  try {
    await cache.set(
      cacheKey,
      JSON.stringify(payload),
      CACHE_TTL_SECONDS
    );
  } catch (_) {}
}

async function getMemoryCache(cacheKey) {
  try {
    const cached = await cache.get(cacheKey);
    return cached ? JSON.parse(cached) : null;
  } catch (_) {
    return null;
  }
}

async function fetchJobsForUser({
  userId,
  parsedData,
  targetRole,
  skills,
  forceRefresh = false,
}) {
  if (!userId) {
    throw new Error('[JobFetcher] userId is required');
  }

  const country = detectUserCountry(parsedData);
  const role = targetRole || 'software engineer';
  const cacheKey = buildCacheKey(userId, role, country);

  if (!forceRefresh) {
    const memoryCached = await getMemoryCache(cacheKey);
    if (memoryCached) {
      return { ...memoryCached, source: 'memory_cache' };
    }

    const durableCached = await readCachedFromSupabase(userId, cacheKey);
    if (durableCached) {
      await setMemoryCache(cacheKey, durableCached);
      return durableCached;
    }
  }

  const credentials = await getAdzunaCredentials();

  if (!credentials) {
    logger.warn('[JobFetcher] Adzuna unavailable');
    return {
      jobs: [],
      totalResults: 0,
      fetchedAt: new Date().toISOString(),
      source: 'unavailable',
    };
  }

  try {
    const result = await fetchFromAdzuna({
      appId: credentials.appId,
      appKey: credentials.appKey,
      role,
      skills: skills || [],
      country,
    });

    const finalResult = {
      ...result,
      source: 'adzuna_live',
    };

    await Promise.allSettled([
      setMemoryCache(cacheKey, finalResult),
      storeJobListings(userId, cacheKey, finalResult),
    ]);

    logger.info('[JobFetcher] Live jobs fetched', {
      userId,
      role,
      country,
      count: finalResult.jobs.length,
    });

    return finalResult;
  } catch (error) {
    logger.error('[JobFetcher] Live fetch failed', {
      userId,
      error: error.message,
    });

    const staleFallback = await readCachedFromSupabase(userId, cacheKey);
    if (staleFallback) {
      return {
        ...staleFallback,
        source: 'supabase_stale_fallback',
      };
    }

    return {
      jobs: [],
      totalResults: 0,
      fetchedAt: new Date().toISOString(),
      source: 'error',
      reason: error.message,
    };
  }
}

async function invalidateJobCache(userId, role, country = 'IN') {
  const cacheKey = buildCacheKey(userId, role, country);

  try {
    await cache.delete(cacheKey);
  } catch (_) {}

  logger.debug('[JobFetcher] Cache invalidated', {
    userId,
    cacheKey,
  });
}

module.exports = {
  fetchJobsForUser,
  invalidateJobCache,
};