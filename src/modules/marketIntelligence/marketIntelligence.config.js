'use strict';

/**
 * @file src/modules/marketIntelligence/marketIntelligence.config.js
 *
 * Config gateway for the marketIntelligence module.
 * Owns all secrets access on behalf of marketIntelligence.service.
 *
 * Introduced in Phase D (Group A fix #5) to break the
 * marketIntelligence.service → secrets.service coupling.
 *
 * marketIntelligence.service is domain logic; it should receive
 * resolved credentials, not pull them at call time. This module
 * encapsulates secrets I/O so the service layer stays clean.
 *
 * Design: no caching layer here — secrets.service is already
 * Supabase-backed and AES-encrypted; call semantics are unchanged.
 */

const {
  getSecret,
  upsertSecret,
} = require('../secrets/secrets.service');

// ─────────────────────────────────────────────────────────────
// Readers
// ─────────────────────────────────────────────────────────────

async function getMarketProvider() {
  return getSecret('MARKET_API_PROVIDER');
}

async function getAdzunaCredentials() {
  const [appId, appKey] = await Promise.all([
    getSecret('MARKET_ADZUNA_APP_ID'),
    getSecret('MARKET_ADZUNA_APP_KEY'),
  ]);
  return { appId, appKey };
}

async function getSerpApiKey() {
  return getSecret('MARKET_SERPAPI_KEY');
}

async function getSerpApiEngine() {
  return getSecret('MARKET_SERPAPI_ENGINE');
}

async function getCustomProviderCredentials() {
  const [baseUrl, apiKey] = await Promise.all([
    getSecret('MARKET_CUSTOM_BASE_URL'),
    getSecret('MARKET_CUSTOM_API_KEY'),
  ]);
  return { baseUrl, apiKey };
}

// ─────────────────────────────────────────────────────────────
// Writers (admin config save)
// ─────────────────────────────────────────────────────────────

async function saveAdzunaCredentials(appId, appKey, adminUid) {
  await Promise.all([
    upsertSecret('MARKET_ADZUNA_APP_ID', appId, adminUid),
    upsertSecret('MARKET_ADZUNA_APP_KEY', appKey, adminUid),
  ]);
}

async function saveSerpApiCredentials(apiKey, searchEngine, adminUid) {
  const ops = [upsertSecret('MARKET_SERPAPI_KEY', apiKey, adminUid)];
  if (searchEngine) {
    ops.push(upsertSecret('MARKET_SERPAPI_ENGINE', searchEngine, adminUid));
  }
  await Promise.all(ops);
}

async function saveCustomCredentials(baseUrl, apiKey, authType, adminUid) {
  await Promise.all([
    upsertSecret('MARKET_CUSTOM_BASE_URL', baseUrl, adminUid),
    upsertSecret('MARKET_CUSTOM_API_KEY', apiKey, adminUid),
    upsertSecret('MARKET_CUSTOM_AUTH_TYPE', authType || 'bearer', adminUid),
  ]);
}

async function saveMarketProvider(provider, adminUid) {
  return upsertSecret('MARKET_API_PROVIDER', provider, adminUid);
}

module.exports = {
  getMarketProvider,
  getAdzunaCredentials,
  getSerpApiKey,
  getSerpApiEngine,
  getCustomProviderCredentials,
  saveMarketProvider,
  saveAdzunaCredentials,
  saveSerpApiCredentials,
  saveCustomCredentials,
};