'use strict';

/**
 * jobSync.validator.js
 *
 * Pure JavaScript validation — zero external dependencies.
 * Returns { value, error } matching the interface the controller/service expect.
 */

const SUPPORTED_SOURCE_TYPES = ['google_sheets', 'csv', 'json'];
const VALID_JOB_TYPES        = ['full_time', 'part_time', 'contract', 'internship', 'remote'];
const SAFE_JOBCODE_REGEX     = /^[A-Z0-9_-]+$/;
const URL_REGEX              = /^https?:\/\/.+/i;
const PRIVATE_HOST_REGEX     = /(localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(key, message) {
  return { details: [{ message, context: { key } }] };
}

function errMany(issues) {
  return { details: issues.map(([key, message]) => ({ message, context: { key } })) };
}

function isString(v)  { return typeof v === 'string'; }
function isBoolean(v) { return typeof v === 'boolean'; }
function isNumber(v)  { return typeof v === 'number' && isFinite(v); }

// ---------------------------------------------------------------------------
// validateSyncRequest
// ---------------------------------------------------------------------------

function validateSyncRequest(body) {
  if (!body || typeof body !== 'object') {
    return { value: null, error: err(null, 'Request body must be an object') };
  }

  const issues = [];

  // sourceType
  if (!isString(body.sourceType) || !SUPPORTED_SOURCE_TYPES.includes(body.sourceType)) {
    issues.push(['sourceType', `sourceType must be one of: ${SUPPORTED_SOURCE_TYPES.join(', ')}`]);
  }

  // sourceUrl
  if (!isString(body.sourceUrl) || !URL_REGEX.test(body.sourceUrl)) {
    issues.push(['sourceUrl', 'sourceUrl must be a valid HTTP/HTTPS URL']);
  } else if (PRIVATE_HOST_REGEX.test(body.sourceUrl)) {
    issues.push(['sourceUrl', 'sourceUrl cannot point to localhost or private hosts']);
  }

  if (issues.length) return { value: null, error: errMany(issues) };

  // options (optional, with defaults)
  const rawOpts   = body.options && typeof body.options === 'object' ? body.options : {};
  const delimiter = isString(rawOpts.delimiter) && rawOpts.delimiter.length === 1
    ? rawOpts.delimiter : ',';
  const skipHeader = isBoolean(rawOpts.skipHeader) ? rawOpts.skipHeader : true;
  const sheetId    = isString(rawOpts.sheetId) && rawOpts.sheetId.length <= 100
    ? rawOpts.sheetId : undefined;

  return {
    value: {
      sourceType: body.sourceType,
      sourceUrl:  body.sourceUrl,
      options:    { skipHeader, delimiter, ...(sheetId ? { sheetId } : {}) },
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// validateJobRecord
// ---------------------------------------------------------------------------

function validateJobRecord(record) {
  if (!record || typeof record !== 'object') {
    return { value: null, error: err(null, 'Job record must be an object') };
  }

  const issues = [];

  // jobCode — normalise to uppercase then validate
  const rawCode    = isString(record.jobCode) ? record.jobCode.trim().toUpperCase() : '';
  if (!rawCode) {
    issues.push(['jobCode', 'jobCode is required']);
  } else if (rawCode.length > 100) {
    issues.push(['jobCode', 'jobCode must be 100 characters or fewer']);
  } else if (!SAFE_JOBCODE_REGEX.test(rawCode)) {
    issues.push(['jobCode', 'jobCode may only contain A-Z, 0-9, hyphen (-), and underscore (_)']);
  }

  // title
  const title = isString(record.title) ? record.title.trim() : '';
  if (!title)          issues.push(['title',   'title is required']);
  else if (title.length > 200) issues.push(['title', 'title must be 200 characters or fewer']);

  // company
  const company = isString(record.company) ? record.company.trim() : '';
  if (!company)        issues.push(['company', 'company is required']);
  else if (company.length > 200) issues.push(['company', 'company must be 200 characters or fewer']);

  // location
  const location = isString(record.location) ? record.location.trim() : '';
  if (!location)       issues.push(['location', 'location is required']);
  else if (location.length > 200) issues.push(['location', 'location must be 200 characters or fewer']);

  // type
  if (!isString(record.type) || !VALID_JOB_TYPES.includes(record.type)) {
    issues.push(['type', `type must be one of: ${VALID_JOB_TYPES.join(', ')}`]);
  }

  // salary (optional)
  let salary;
  if (record.salary !== undefined && record.salary !== null) {
    if (typeof record.salary !== 'object') {
      issues.push(['salary', 'salary must be an object with min and max']);
    } else {
      const { min, max, currency } = record.salary;
      if (!isNumber(min) || min < 0) issues.push(['salary.min', 'salary.min must be a non-negative number']);
      if (!isNumber(max) || max < 0) issues.push(['salary.max', 'salary.max must be a non-negative number']);
      if (isNumber(min) && isNumber(max) && max < min) issues.push(['salary.max', 'salary.max must be >= salary.min']);
      if (!issues.some(([k]) => k.startsWith('salary'))) {
        salary = {
          min,
          max,
          currency: isString(currency) && currency.length === 3
            ? currency.toUpperCase()
            : 'USD',
        };
      }
    }
  }

  // description (optional)
  const description = isString(record.description) ? record.description.trim() : undefined;
  if (description && description.length > 10_000) {
    issues.push(['description', 'description must be 10,000 characters or fewer']);
  }

  // tags (optional, default [])
  let tags = [];
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags)) {
      issues.push(['tags', 'tags must be an array']);
    } else if (record.tags.length > 20) {
      issues.push(['tags', 'tags may contain at most 20 items']);
    } else {
      tags = record.tags
        .filter(t => isString(t))
        .map(t => t.trim().toLowerCase().slice(0, 50));
    }
  }

  // externalUrl (optional)
  let externalUrl;
  if (record.externalUrl !== undefined && record.externalUrl !== null) {
    if (!isString(record.externalUrl) || !URL_REGEX.test(record.externalUrl)) {
      issues.push(['externalUrl', 'externalUrl must be a valid URL']);
    } else {
      externalUrl = record.externalUrl;
    }
  }

  // postedAt (optional — accept any non-empty string, coerce to ISO if possible)
  let postedAt;
  if (record.postedAt !== undefined && record.postedAt !== null) {
    const d = new Date(record.postedAt);
    postedAt = isNaN(d.getTime()) ? String(record.postedAt) : d.toISOString();
  }

  if (issues.length) return { value: null, error: errMany(issues) };

  return {
    value: {
      jobCode:  rawCode,
      title,
      company,
      location,
      type:        record.type,
      ...(salary      !== undefined ? { salary }      : {}),
      ...(description !== undefined ? { description } : {}),
      tags,
      ...(externalUrl !== undefined ? { externalUrl } : {}),
      ...(postedAt    !== undefined ? { postedAt }    : {}),
    },
    error: null,
  };
}

module.exports = { validateSyncRequest, validateJobRecord };








