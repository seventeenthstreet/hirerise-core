'use strict';

const axios = require('axios');
const { parse: parseCsv } = require('csv-parse/sync');
const dns = require('dns').promises;
const net = require('net');
const logger = require('../../../../shared/logger');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB safety cap

// ---------------------------------------------------------------------------
// SSRF Protection Helpers
// ---------------------------------------------------------------------------

function isPrivateIP(ip) {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.2') ||
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('169.254.')
  );
}

async function assertSafeHostname(url) {
  const parsed = new URL(url);

  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are permitted');
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true });

  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new Error('Private or internal IP addresses are not allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP fetch helper
// ---------------------------------------------------------------------------

async function fetchRaw(url) {

  await assertSafeHostname(url);

  let safeOrigin;
  try {
    safeOrigin = new URL(url).origin;
  } catch {
    safeOrigin = '[invalid URL]';
  }

  try {
    const response = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: (status) => status >= 200 && status < 300,
      maxRedirects: 5,
      maxContentLength: MAX_RESPONSE_BYTES,
    });

    return response.data;

  } catch (err) {

    if (err.code === 'ECONNABORTED') {
      throw new Error(
        `Request to ${safeOrigin} timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      );
    }

    if (err.response) {
      throw new Error(
        `Upstream ${safeOrigin} returned HTTP ${err.response.status}`
      );
    }

    throw new Error(`Network error reaching ${safeOrigin}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normaliseCsvRow(row) {

  const get = (key) => {
    const match = Object.keys(row).find(
      (k) => k.toLowerCase() === key.toLowerCase()
    );
    return match ? (row[match] ?? '').trim() : '';
  };

  const salaryMin = parseFloat(get('salaryMin'));
  const salaryMax = parseFloat(get('salaryMax'));
  const tagsRaw   = get('tags');

  return {
    jobCode:     get('jobCode').trim(),
    title:       get('title'),
    company:     get('company'),
    location:    get('location'),
    type:        get('type'),
    salary: (!isNaN(salaryMin) && !isNaN(salaryMax))
      ? { min: salaryMin, max: salaryMax, currency: get('currency') || 'USD' }
      : undefined,
    description: get('description') || undefined,
    tags:        tagsRaw ? tagsRaw.split('|').map((t) => t.trim()).filter(Boolean) : [],
    externalUrl: get('externalUrl') || undefined,
    postedAt:    get('postedAt') || undefined,
  };
}

function normaliseJsonRecord(record) {
  return {
    jobCode:     (record.jobCode ?? record.job_code ?? '').trim(),
    title:       record.title       ?? '',
    company:     record.company     ?? '',
    location:    record.location    ?? '',
    type:        record.type        ?? record.jobType ?? '',
    salary:      record.salary,
    description: record.description ?? undefined,
    tags:        Array.isArray(record.tags) ? record.tags : [],
    externalUrl: record.externalUrl ?? record.external_url ?? undefined,
    postedAt:    record.postedAt    ?? record.posted_at ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

async function fetchCsv(url, options = {}) {
  const raw  = await fetchRaw(url);

  const rows = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    delimiter: options.delimiter ?? ',',
    trim: true,
    bom: true,
  });

  logger.info(`[jobSourceFetcher] CSV rows fetched: ${rows.length}`);

  return rows.map(normaliseCsvRow);
}

async function fetchJson(url) {
  const raw = await fetchRaw(url);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Response body is not valid JSON');
  }

  let records;
  if (Array.isArray(parsed)) records = parsed;
  else if (Array.isArray(parsed?.data)) records = parsed.data;
  else if (Array.isArray(parsed?.jobs)) records = parsed.jobs;
  else if (Array.isArray(parsed?.results)) records = parsed.results;
  else throw new Error('JSON response does not contain a valid records array');

  logger.info(`[jobSourceFetcher] JSON records fetched: ${records.length}`);

  return records.map(normaliseJsonRecord);
}

// ---------------------------------------------------------------------------

async function fetchJobRecords(sourceType, sourceUrl, options = {}) {
  switch (sourceType) {
    case 'google_sheets':
    case 'csv':
      return fetchCsv(sourceUrl, options);
    case 'json':
      return fetchJson(sourceUrl);
    default:
      throw new Error(`Unsupported sourceType "${sourceType}"`);
  }
}

module.exports = { fetchJobRecords };