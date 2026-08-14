'use strict';

/**
 * @file jobSync.validator.test.js
 * @description WP-ADMIN-COMP-06-R2 regression tests.
 *
 * Covers validateCsvUploadOptions — normalises the optional multipart
 * form fields (delimiter, skipHeader) accompanying a CSV file upload,
 * mirroring validateSyncRequest's options defaults so uploaded and
 * URL-fetched CSVs normalise identically.
 */

const { validateCsvUploadOptions } = require('../jobSync.validator');

describe('jobSync.validator — validateCsvUploadOptions', () => {
  it('defaults to comma delimiter and skipHeader=true when no fields are given', () => {
    const { value } = validateCsvUploadOptions();
    expect(value).toEqual({ delimiter: ',', skipHeader: true });
  });

  it('accepts a single-character custom delimiter', () => {
    const { value } = validateCsvUploadOptions({ delimiter: ';' });
    expect(value.delimiter).toBe(';');
  });

  it('falls back to comma when delimiter is not exactly one character', () => {
    const { value } = validateCsvUploadOptions({ delimiter: '::' });
    expect(value.delimiter).toBe(',');
  });

  it('parses skipHeader="false" (multipart string form) as boolean false', () => {
    const { value } = validateCsvUploadOptions({ skipHeader: 'false' });
    expect(value.skipHeader).toBe(false);
  });

  it('treats any other skipHeader value as true (matches validateSyncRequest default)', () => {
    expect(validateCsvUploadOptions({ skipHeader: 'true' }).value.skipHeader).toBe(true);
    expect(validateCsvUploadOptions({ skipHeader: 'yes' }).value.skipHeader).toBe(true);
  });

  it('never returns an error — CSV upload options are always optional', () => {
    expect(validateCsvUploadOptions({}).error).toBeNull();
  });
});
