'use strict';

/**
 * @file jobSourceFetcher.util.test.js
 * @description WP-ADMIN-COMP-06-R2 regression tests.
 *
 * Covers parseJobRecordsFromCsvText — the new export that lets an
 * uploaded CSV buffer reuse the exact same parser/normaliser
 * (parseCsvText + normaliseCsvRow) that URL-based CSV/Google Sheets
 * sync already uses via fetchCsv(). No new parsing logic should exist
 * here; these tests assert the uploaded-text path produces the same
 * shape of output as the URL-fetched path.
 */

jest.mock('../../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { parseJobRecordsFromCsvText } = require('../jobSourceFetcher.util');

describe('jobSourceFetcher.util — parseJobRecordsFromCsvText', () => {
  it('parses CSV text into normalised job records, same shape as URL-fetched CSV', () => {
    const csv = [
      'jobCode,title,company,location,type,salaryMin,salaryMax,currency,tags',
      'ENG-1,Backend Engineer,Acme Corp,Bangalore,full_time,800000,1200000,INR,node|typescript',
    ].join('\n');

    const records = parseJobRecordsFromCsvText(csv);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      jobCode: 'ENG-1',
      title: 'Backend Engineer',
      company: 'Acme Corp',
      location: 'Bangalore',
      type: 'full_time',
      salary: { min: 800000, max: 1200000, currency: 'INR' },
      tags: ['node', 'typescript'],
    });
  });

  it('respects a custom delimiter option, matching fetchCsv() behavior', () => {
    const csv = [
      'jobCode;title;company;location;type',
      'ENG-2;Frontend Engineer;Acme Corp;Remote;full_time',
    ].join('\n');

    const records = parseJobRecordsFromCsvText(csv, { delimiter: ';' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobCode: 'ENG-2', title: 'Frontend Engineer' });
  });

  it('returns an empty array for header-only CSV text', () => {
    const csv = 'jobCode,title,company,location,type';
    expect(parseJobRecordsFromCsvText(csv)).toEqual([]);
  });

  it('strips a UTF-8 BOM, matching parseCsvText()’s existing behavior', () => {
    const csv = '\uFEFFjobCode,title,company,location,type\nENG-3,QA Engineer,Acme,Pune,contract';
    const records = parseJobRecordsFromCsvText(csv);

    expect(records).toHaveLength(1);
    expect(records[0].jobCode).toBe('ENG-3');
  });
});
