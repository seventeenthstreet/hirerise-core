'use strict';

/**
 * jobFetcher.service.js
 *
 * Place at: src/services/jobFetcher.service.js
 *
 * Fetches live job listings from Adzuna based on user role + skills.
 * The existing marketDemandService.js fetches aggregate signals (job counts,
 * salary medians, growth rates). This service fetches individual job listings
 * for the "Job Matches" dashboard card.
 *
 * Features:
 *   - 24-hour TTL cache (Redis/Memory via cacheManager)
 *   - Stores results in Supabase job_listings table (id = userId__cacheKey)
 *   - Falls back to Supabase cache if Adzuna is unavailable
 *   - Country detection from user's parsedData
 *   - Skill-filtered queries (top 5 skills from profile)
 *
 * Adzuna free tier: 250 calls/month, 10 results/page
 * Sign up: https://developer.adzuna.com/
 *
 * Secrets required (via Admin → Secret Manager):
 *   ADZUNA_APP_ID  — your Adzuna app_id
 *   ADZUNA_APP_KEY — your Adzuna app_key
 *
 * Usage:
 *   const { fetchJobsForUser } = require('./jobFetcher.service');
 *   const jobs = await fetchJobsForUser({ userId, parsedData, targetRole, skills });
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');
const { detectUserCountry } = require('./salary.service');

const cache = cacheManager.getClient();

// ── Configuration ────────────────────────────────────────────────────────────

const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const RESULTS_PER_PAGE = 10;
const COLLECTION = 'job_listings';

// Adzuna uses 2-letter country codes (ISO 3166-1 alpha-2)
// Maps our detected country codes to Adzuna-supported country routes
const ADZUNA_COUNTRY_MAP = {
  IN: 'in',  // India
  US: 'us',  // United States
  GB: 'gb',  // United Kingdom
  CA: 'ca',  // Canada
  AU: 'au',  // Australia
  DE: 'de',  // Germany
  AE: 'ae',  // UAE (limited support — falls back to us)
  SG: 'sg',  // Singapore (limited — falls back to gb)
};
const ADZUNA_FALLBACK_COUNTRY = 'in';

// ── Credential loader ─────────────────────────────────────────────────────────

async function _getAdzunaCredentials() {
  const { getSecret } = require('../modules/secrets');
  try {
    const [appId, appKey] = await Promise.all([
      getSecret('ADZUNA_APP_ID'),
      getSecret('ADZUNA_APP_KEY'),
    ]);
    return { appId, appKey };
  } catch (err) {
    // Fall back to env vars for local dev
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (appId && appKey) return { appId, appKey };
    throw Object.assign(
      new Error(
        'Adzuna credentials not configured. Set ADZUNA_APP_ID and ADZUNA_APP_KEY in Secret Manager or .env'
      ),
      { code: 'ADZUNA_NOT_CONFIGURED', statusCode: 503 }
    );
  }
}

// ── Cache key builder ─────────────────────────────────────────────────────────

function _buildCacheKey(userId, role, country) {
  // Normalise role for consistent cache hits
  const normRole = (role || 'general').toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `jobs:${userId}:${normRole}:${country}`;
}

// ── Adzuna API call ───────────────────────────────────────────────────────────

/**
 * _fetchFromAdzuna({ appId, appKey, role, skills, country, resultsPerPage })
 *
 * Calls the Adzuna search API and normalises results.
 * Docs: https://developer.adzuna.com/activedocs#!/adzuna/search
 */
async function _fetchFromAdzuna({ appId, appKey, role, skills, country, resultsPerPage = RESULTS_PER_PAGE }) {
  const adzunaCountry = ADZUNA_COUNTRY_MAP[country] || ADZUNA_FALLBACK_COUNTRY;

  // Build search query: role + top 3 skills for relevance
  const topSkills = (skills || []).slice(0, 3).join(' ');
  const query = [role, topSkills].filter(Boolean).join(' ');

  const url = new URL(`${ADZUNA_BASE_URL}/${adzunaCountry}/search/1`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('results_per_page', String(resultsPerPage));
  url.searchParams.set('what', query);
  url.searchParams.set('content-type', 'application/json');
  url.searchParams.set('sort_by', 'relevance');

  logger.debug('[JobFetcher] Calling Adzuna', { country: adzunaCountry, query, resultsPerPage });

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Adzuna API error ${res.status}: ${body.slice(0, 200)}`), {
      statusCode: res.status,
      code: 'ADZUNA_API_ERROR',
    });
  }

  const data = await res.json();

  // Normalise Adzuna results to our internal job shape
  const jobs = (data.results || []).map((job) => ({
    id: job.id || null,
    title: job.title || 'Untitled',
    company: job.company?.display_name || 'Unknown Company',
    location: job.location?.display_name || adzunaCountry.toUpperCase(),
    description: (job.description || '').slice(0, 500),
    salary: {
      min: job.salary_min || null,
      max: job.salary_max || null,
      currency: job.salary_currency || 'GBP', // Adzuna default
    },
    postedAt: job.created || new Date().toISOString(),
    redirectUrl: job.redirect_url || null,
    category: job.category?.label || null,
    contractType: job.contract_type || null,
    source: 'adzuna',
  }));

  return {
    jobs,
    totalResults: data.count || jobs.length,
    query,
    country: adzunaCountry,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Store results in Supabase ─────────────────────────────────────────────────

async function _storeJobListings(userId, cacheKey, result) {
  try {
    const docId = `${userId}__${cacheKey.replace(/[:/]/g, '_')}`;
    const now = new Date();

    const { error } = await supabase
      .from(COLLECTION)
      .upsert([{
        id: docId,
        userId,
        cacheKey,
        ...result,
        storedAt: now.toISOString(),
        expiresAt: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
      }]);

    if (error) {
      logger.warn('[JobFetcher] Failed to store job listings in Supabase (non-fatal)', {
        userId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn('[JobFetcher] Failed to store job listings in Supabase (non-fatal)', {
      userId,
      error: err.message,
    });
  }
}

// ── Read cached results from Supabase ─────────────────────────────────────────

async function _readCachedFromSupabase(userId, cacheKey) {
  try {
    const docId = `${userId}__${cacheKey.replace(/[:/]/g, '_')}`;

    const { data, error } = await supabase
      .from(COLLECTION)
      .select('*')
      .eq('id', docId)
      .maybeSingle();

    if (error || !data) return null;

    // Check if the Supabase cache is still fresh
    const expiresAt = new Date(data.expiresAt);
    if (expiresAt < new Date()) {
      logger.debug('[JobFetcher] Supabase cache expired', { userId, cacheKey });
      return null;
    }

    return {
      jobs: data.jobs,
      totalResults: data.totalResults,
      query: data.query,
      country: data.country,
      fetchedAt: data.fetchedAt,
      source: 'supabase_cache',
    };
  } catch (err) {
    logger.debug('[JobFetcher] Supabase cache read failed', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: fetchJobsForUser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fetchJobsForUser({ userId, parsedData, targetRole, skills, forceRefresh })
 *
 * Fetches live job listings relevant to the user's role and skills.
 *
 * Cache strategy (3 layers):
 *   1. Redis/Memory cache (TTL: 24h) — fastest
 *   2. Supabase (TTL: 24h) — survives server restarts
 *   3. Adzuna live API — populates both caches on miss
 *
 * @param {{ userId: string, parsedData?: object, targetRole?: string, skills?: string[], forceRefresh?: boolean }}
 * @returns {Promise<{ jobs: object[], totalResults: number, fetchedAt: string, source: string }>}
 */
async function fetchJobsForUser({ userId, parsedData, targetRole, skills, forceRefresh = false }) {
  if (!userId) throw new Error('[JobFetcher] userId is required');

  // Detect country from resume location
  const country = detectUserCountry(parsedData);
  const role = targetRole || 'software engineer'; // safe default
  const cacheKey = _buildCacheKey(userId, role, country);

  // ── Layer 1: Redis/Memory cache ───────────────────────────────────────────
  if (!forceRefresh) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debug('[JobFetcher] Cache hit (memory)', { userId, cacheKey });
        return { ...JSON.parse(cached), source: 'memory_cache' };
      }
    } catch (_) { /* cache miss is safe */ }
  }

  // ── Layer 2: Supabase cache ───────────────────────────────────────────────
  if (!forceRefresh) {
    const supabaseCached = await _readCachedFromSupabase(userId, cacheKey);
    if (supabaseCached) {
      // Warm the memory cache from Supabase
      try {
        await cache.set(cacheKey, JSON.stringify(supabaseCached), CACHE_TTL_SECONDS);
      } catch (_) {}
      return supabaseCached;
    }
  }

  // ── Layer 3: Live Adzuna API ──────────────────────────────────────────────
  let credentials;
  try {
    credentials = await _getAdzunaCredentials();
  } catch (err) {
    logger.warn('[JobFetcher] Adzuna not configured — returning empty job list', {
      userId,
      error: err.message,
    });
    // Return empty result rather than crashing the dashboard
    return {
      jobs: [],
      totalResults: 0,
      fetchedAt: new Date().toISOString(),
      source: 'unavailable',
      reason: err.message,
    };
  }

  try {
    const result = await _fetchFromAdzuna({
      appId: credentials.appId,
      appKey: credentials.appKey,
      role,
      skills: skills || [],
      country,
    });
    result.source = 'adzuna_live';

    // Populate both caches
    try {
      await cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    } catch (_) {}
    await _storeJobListings(userId, cacheKey, result);

    logger.info('[JobFetcher] Jobs fetched from Adzuna', {
      userId,
      role,
      country,
      count: result.jobs.length,
    });
    return result;
  } catch (err) {
    logger.error('[JobFetcher] Adzuna API call failed', { userId, error: err.message });

    // Return empty rather than crashing — job matches are non-critical
    return {
      jobs: [],
      totalResults: 0,
      fetchedAt: new Date().toISOString(),
      source: 'error',
      reason: err.message,
    };
  }
}

/**
 * invalidateJobCache(userId, role, country)
 * Clears the memory cache for a user's job results.
 * Call after a user updates their target role.
 */
async function invalidateJobCache(userId, role, country = 'IN') {
  const cacheKey = _buildCacheKey(userId, role, country);
  try {
    await cache.delete(cacheKey);
    logger.debug('[JobFetcher] Job cache invalidated', { userId, cacheKey });
  } catch (_) {}
}

module.exports = {
  fetchJobsForUser,
  invalidateJobCache,
};