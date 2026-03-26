'use strict';

/**
 * jobSourceFetcher.util.js
 *
 * Fetches job records from CSV or JSON sources using Node.js built-in
 * modules only (https/http + dns) — no axios or csv-parse dependency.
 */

const https  = require('https');
const http   = require('http');
const dns    = require('dns').promises;
const logger = require('../../../../utils/logger');

const FETCH_TIMEOUT_MS    = 15_000;
const MAX_RESPONSE_BYTES  = 5 * 1024 * 1024; // 5 MB safety cap
const MAX_REDIRECTS       = 5;

// ---------------------------------------------------------------------------
// SSRF Protection
// ---------------------------------------------------------------------------

function isPrivateIP(ip) {
  return (
    ip.startsWith('10.')        ||
    ip.startsWith('192.168.')   ||
    ip.startsWith('172.16.')    ||
    ip.startsWith('172.17.')    ||
    ip.startsWith('172.18.')    ||
    ip.startsWith('172.19.')    ||
    ip.startsWith('172.2')      ||
    ip === '127.0.0.1'          ||
    ip === '::1'                ||
    ip.startsWith('169.254.')
  );
}

async function assertSafeHostname(url) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are permitted');
  }
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new Error('Private or internal IP addresses are not allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP fetch — built-in https/http only, no axios
// ---------------------------------------------------------------------------

function fetchRaw(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise(async (resolve, reject) => {
    try {
      await assertSafeHostname(url);
    } catch (err) {
      return reject(err);
    }

    let safeOrigin;
    try { safeOrigin = new URL(url).origin; } catch { safeOrigin = '[invalid URL]'; }

    const parsed   = new URL(url);
    const lib      = parsed.protocol === 'https:' ? https : http;
    let totalBytes = 0;
    let timedOut   = false;

    const req = lib.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(fetchRaw(next, redirectsLeft - 1));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Upstream ${safeOrigin} returned HTTP ${res.statusCode}`));
      }

      const chunks = [];

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          return reject(new Error(`Response from ${safeOrigin} exceeds size limit`));
        }
        chunks.push(chunk);
      });

      res.on('end',   () => { if (!timedOut) resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      reject(new Error(`Request to ${safeOrigin} timed out after ${FETCH_TIMEOUT_MS / 1000}s`));
    });

    req.on('error', (err) => {
      if (!timedOut) reject(new Error(`Network error reaching ${safeOrigin}: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Minimal CSV parser — no external dependency
// Handles quoted fields, escaped quotes, BOM, and configurable delimiter
// ---------------------------------------------------------------------------

function parseCsvText(text, delimiter = ',') {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Strip UTF-8 BOM
  if (lines[0] && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);

  const headers = splitCsvLine(lines[0], delimiter).map(h => h.trim());
  const result  = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line, delimiter);
    const row    = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').trim(); });
    result.push(row);
  }
  return result;
}

function splitCsvLine(line, delimiter) {
  const cells = [];
  let cur      = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"')                    { inQuotes = false; }
      else                                    { cur += ch; }
    } else {
      if      (ch === '"')      { inQuotes = true; }
      else if (ch === delimiter){ cells.push(cur); cur = ''; }
      else                      { cur += ch; }
    }
  }
  cells.push(cur);
  return cells;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normaliseCsvRow(row) {
  const get = (key) => {
    const match = Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase());
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
    tags:        tagsRaw ? tagsRaw.split('|').map(t => t.trim()).filter(Boolean) : [],
    externalUrl: get('externalUrl') || undefined,
    postedAt:    get('postedAt')    || undefined,
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
    postedAt:    record.postedAt    ?? record.posted_at    ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function fetchCsv(url, options = {}) {
  const raw  = await fetchRaw(url);
  const rows = parseCsvText(raw, options.delimiter ?? ',');
  logger.info(`[jobSourceFetcher] CSV rows fetched: ${rows.length}`);
  return rows.map(normaliseCsvRow);
}

async function fetchJson(url) {
  const raw = await fetchRaw(url);

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Response body is not valid JSON'); }

  let records;
  if      (Array.isArray(parsed))          records = parsed;
  else if (Array.isArray(parsed?.data))    records = parsed.data;
  else if (Array.isArray(parsed?.jobs))    records = parsed.jobs;
  else if (Array.isArray(parsed?.results)) records = parsed.results;
  else throw new Error('JSON response does not contain a valid records array');

  logger.info(`[jobSourceFetcher] JSON records fetched: ${records.length}`);
  return records.map(normaliseJsonRecord);
}

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








