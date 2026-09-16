'use strict';

/**
 * @file phase3b6e3CareerAreaGovernedVocabulary.test.js
 * @description
 * Phase 3B.6E.3 — Career Area Governed Vocabulary Implementation.
 * Focused regression coverage per the Phase 3B.6E.3 spec §19:
 *   - Vocabulary: exactly 8 approved canonical keys/labels, no duplicates.
 *   - Canonical key: valid keys accepted, unknown keys rejected, ordinary
 *     Admin CRUD cannot mutate canonical_key, editing name never changes it.
 *   - normalized_name: existing normalization behavior unchanged.
 *   - Ontology: all active career-area ontology targets resolve to an
 *     approved canonical key (explicit reconciliation, no FK).
 *   - Admin: canonical_key is read-only.
 *   - Migration: structural checks (additive, idempotent, no destructive SQL).
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const MIGRATION_PATH = path.join(
  __dirname,
  '../../../../../../supabase/migrations/20260904010000_phase3b6e3_career_area_governed_vocabulary.sql'
);

const ONTOLOGY_SEED_PATH = path.join(
  __dirname,
  '../../../../../../supabase/migrations/20260608000001_intelligence_foundation_layer.sql'
);

const APPROVED_VOCABULARY = [
  ['technology', 'Technology'],
  ['engineering', 'Engineering'],
  ['natural_sciences', 'Natural Sciences'],
  ['business', 'Business'],
  ['creative_industries', 'Creative Industries'],
  ['social_sciences', 'Social Sciences'],
  ['health_sciences', 'Health Sciences'],
  ['education', 'Education'],
];
const APPROVED_KEYS = APPROVED_VOCABULARY.map(([key]) => key);

describe('Phase 3B.6E.3 — Vocabulary', () => {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  test('exactly eight approved canonical keys are seeded', () => {
    for (const key of APPROVED_KEYS) {
      const occurrences = migrationSql.split(`'${key}'`).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(1);
    }
    // No unapproved key-shaped literal introduced as a canonical_key value
    // in the CHECK constraint allowlist.
    const allowlistMatch = migrationSql.match(
      /chk_cms_career_domains_canonical_key_allowlist[\s\S]*?CHECK \(([\s\S]*?)\);/
    );
    expect(allowlistMatch).not.toBeNull();
    const allowlistBody = allowlistMatch[1];
    const literalKeys = [...allowlistBody.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(literalKeys.sort()).toEqual([...APPROVED_KEYS].sort());
  });

  test('exact display labels match the approved eight', () => {
    for (const [key, label] of APPROVED_VOCABULARY) {
      const rowPattern = new RegExp(
        `\\('${label}',\\s*'[^']*',\\s*'${key}'`
      );
      expect(migrationSql).toMatch(rowPattern);
    }
  });

  test('no duplicate canonical keys within the seed INSERT', () => {
    const insertMatch = migrationSql.match(/INSERT INTO public\.cms_career_domains[\s\S]*?VALUES([\s\S]*?);/);
    expect(insertMatch).not.toBeNull();
    const valuesBlock = insertMatch[1];
    const rowKeys = [...valuesBlock.matchAll(/'([a-z_]+)',\s*''/g)].map((m) => m[1]);
    expect(rowKeys.length).toBe(8);
    expect(new Set(rowKeys).size).toBe(8);
  });

  test("all seeded rows are marked active and not soft-deleted", () => {
    const insertMatch = migrationSql.match(/INSERT INTO public\.cms_career_domains[\s\S]*?VALUES([\s\S]*?);/);
    const valuesBlock = insertMatch[1];
    const rows = valuesBlock.split('\n').filter((l) => l.trim().startsWith('('));
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row).toMatch(/'active'/);
      expect(row).toMatch(/false\)/);
    }
  });
});

describe('Phase 3B.6E.3 — Canonical key validation (migration-level)', () => {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  test('CHECK constraint rejects any key outside the approved allowlist', () => {
    const allowlistMatch = migrationSql.match(
      /CHECK \(\s*canonical_key IS NULL OR canonical_key IN \(([\s\S]*?)\)\s*\)/
    );
    expect(allowlistMatch).not.toBeNull();
    const literalKeys = [...allowlistMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(literalKeys.sort()).toEqual([...APPROVED_KEYS].sort());
    // Not a generic "any slug" rule — every literal is one of the 8.
    expect(literalKeys.every((k) => APPROVED_KEYS.includes(k))).toBe(true);
  });

  test('canonical_key is set NOT NULL only after the seed + verification step', () => {
    const notNullIdx = migrationSql.indexOf('ALTER COLUMN canonical_key SET NOT NULL');
    const insertIdx = migrationSql.indexOf('INSERT INTO public.cms_career_domains');
    const verifyIdx = migrationSql.indexOf('expected exactly 8 active governed Career Area rows');
    expect(notNullIdx).toBeGreaterThan(insertIdx);
    expect(notNullIdx).toBeGreaterThan(verifyIdx);
  });

  test('canonical_key receives its own UNIQUE constraint, independent of normalized_name', () => {
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT cms_career_domains_canonical_key_key UNIQUE \(canonical_key\)/
    );
  });
});

describe('Phase 3B.6E.3 — normalized_name preserved', () => {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  test('migration does not touch normalized_name semantics or constraints', () => {
    expect(migrationSql).not.toMatch(/DROP CONSTRAINT.*normalized_name/i);
    expect(migrationSql).not.toMatch(/idx_domains_normalized_name/); // never dropped/recreated
    expect(migrationSql).not.toMatch(/ALTER COLUMN normalized_name/i);
  });

  test('multiword approved labels retain space-preserving normalized_name values', () => {
    const multiword = [
      ['Natural Sciences', 'natural sciences'],
      ['Creative Industries', 'creative industries'],
      ['Social Sciences', 'social sciences'],
      ['Health Sciences', 'health sciences'],
    ];
    for (const [name, normalized] of multiword) {
      expect(migrationSql).toMatch(
        new RegExp(`\\('${name}',\\s*'${normalized}',`)
      );
      // Explicitly not converted to an underscore slug for normalized_name.
      expect(migrationSql).not.toMatch(
        new RegExp(`\\('${name}',\\s*'${normalized.replace(/ /g, '_')}',`)
      );
    }
  });

  test('normalizeName() helper (dedicated Admin module) is unchanged: trim + lowercase, space-preserving', () => {
    // eslint-disable-next-line global-require
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    expect(careerDomainsModule._normalizeName('  Natural Sciences  ')).toBe('natural sciences');
    expect(careerDomainsModule._normalizeName('Technology')).toBe('technology');
  });
});

describe('Phase 3B.6E.3 — Migration safety / additivity', () => {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  test('migration is additive: no destructive statements in the executed transaction body', () => {
    // Restrict to the actual executed BEGIN;...COMMIT; body — the trailing
    // comment block documents a manual rollback (including a scoped DELETE)
    // and is never executed by this migration.
    const bodyStart = migrationSql.indexOf('\nBEGIN;');
    const bodyEnd = migrationSql.indexOf('\nCOMMIT;') + '\nCOMMIT;'.length;
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const executedBody = migrationSql.slice(bodyStart, bodyEnd);

    expect(executedBody).not.toMatch(/DROP TABLE/i);
    expect(executedBody).not.toMatch(/TRUNCATE/i);
    expect(executedBody).not.toMatch(/DELETE FROM/i);
  });

  test('column/constraint changes use idempotency-safe DDL', () => {
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS canonical_key/);
    expect(migrationSql).toMatch(/DROP CONSTRAINT IF EXISTS chk_cms_career_domains_canonical_key_allowlist/);
    expect(migrationSql).toMatch(/DROP CONSTRAINT IF EXISTS cms_career_domains_canonical_key_key/);
  });

  test('seed INSERT is idempotency-safe via ON CONFLICT DO UPDATE guarded by canonical_key IS NULL', () => {
    expect(migrationSql).toMatch(
      /ON CONFLICT \(normalized_name\)\s*\nDO UPDATE SET\s*\n\s*canonical_key = EXCLUDED\.canonical_key\s*\nWHERE public\.cms_career_domains\.canonical_key IS NULL/
    );
  });

  test('migration is wrapped in a single explicit transaction', () => {
    expect(migrationSql.trim().startsWith('-- ')).toBe(true);
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
  });

  test('includes a runtime safety guard for unexpected pre-existing rows', () => {
    expect(migrationSql).toMatch(/STOP CONDITION/);
    expect(migrationSql).toMatch(/RAISE EXCEPTION/);
  });
});

describe('Phase 3B.6E.3 — Ontology reconciliation', () => {
  const ontologySql = fs.readFileSync(ONTOLOGY_SEED_PATH, 'utf8');

  test('all active signal → career_area ontology edge target keys resolve to an approved canonical key', () => {
    // Extract the seed INSERT's VALUES rows shaped:
    // ('signal','<source_key>','career_area','<target_key>', ...)
    const targetKeys = [...ontologySql.matchAll(/'career_area',\s*'([a-z_]+)'/g)]
      .map((m) => m[1])
      // Exclude CHECK-constraint vocabulary occurrences (e.g. 'career_area','role')
      // which are type-list literals, not data rows.
      .filter((key) => key !== 'role' && key !== 'signal' && key !== 'category' && key !== 'skill' && key !== 'programme');

    expect(targetKeys.length).toBeGreaterThan(0);
    for (const key of targetKeys) {
      expect(APPROVED_KEYS).toContain(key);
    }
  });

  test('exactly 34 active signal → career_area edges exist, matching the documented pre-flight count', () => {
    const targetKeys = [...ontologySql.matchAll(/'career_area',\s*'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((key) => APPROVED_KEYS.includes(key));
    expect(targetKeys.length).toBe(34);
  });

  test('no unexpected career-area target key exists outside the approved eight', () => {
    const targetKeys = [...ontologySql.matchAll(/'career_area',\s*'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((key) => key !== 'role' && key !== 'signal' && key !== 'category' && key !== 'skill' && key !== 'programme');
    const unexpected = targetKeys.filter((key) => !APPROVED_KEYS.includes(key));
    expect(unexpected).toEqual([]);
  });
});

describe('Phase 3B.6E.3 — Admin canonical_key governance (HTTP layer)', () => {
  function mockSupabaseModule(overrides = {}) {
    const builder = {
      select: jest.fn(() => builder),
      insert: jest.fn(() => builder),
      update: jest.fn(() => builder),
      eq: jest.fn(() => builder),
      order: jest.fn(() => builder),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
      single: jest.fn(() =>
        Promise.resolve({
          data: { id: 'cd-1', name: 'Technology', canonical_key: 'technology' },
          error: null,
        })
      ),
      ...overrides,
    };
    const from = jest.fn(() => builder);
    return { supabase: { from } };
  }

  beforeEach(() => {
    jest.resetModules();
  });

  test('CREATE is rejected for ordinary Admin CRUD (vocabulary is closed)', async () => {
    jest.doMock('../../../../../config/supabase', () => mockSupabaseModule());
    const express = require('express');
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { id: 'admin-1' }; next(); });
    app.use('/', careerDomainsModule.router);

    const res = await request(app).post('/').send({ name: 'Robotics', description: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CAREER_AREA_VOCABULARY_CLOSED');
  });

  test('CREATE with an explicit canonical_key is rejected with a governance error before the vocabulary-closed check', async () => {
    jest.doMock('../../../../../config/supabase', () => mockSupabaseModule());
    const express = require('express');
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { id: 'admin-1' }; next(); });
    app.use('/', careerDomainsModule.router);

    const res = await request(app)
      .post('/')
      .send({ name: 'Technology', canonical_key: 'technology' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANONICAL_KEY_GOVERNANCE_RESTRICTED');
  });

  test('UPDATE rejects an attempt to mutate canonical_key', async () => {
    jest.doMock('../../../../../config/supabase', () => mockSupabaseModule());
    const express = require('express');
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { id: 'admin-1' }; next(); });
    app.use('/', careerDomainsModule.router);

    // name is required by the existing shared validators (unchanged
    // pre-existing behavior for this route) — included so the request
    // reaches the handler and the canonical_key rejection is what's tested.
    const res = await request(app)
      .put('/cd-1')
      .send({ name: 'Engineering Updated', canonical_key: 'engineering' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANONICAL_KEY_GOVERNANCE_RESTRICTED');
  });

  test('UPDATE of name alone succeeds and does not touch canonical_key', async () => {
    const updateSpy = jest.fn();
    jest.doMock('../../../../../config/supabase', () =>
      mockSupabaseModule({
        update: (payload) => {
          updateSpy(payload);
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: 'cd-1', name: 'Technology', canonical_key: 'technology' },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        },
      })
    );
    const express = require('express');
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { id: 'admin-1' }; next(); });
    app.use('/', careerDomainsModule.router);

    const res = await request(app).put('/cd-1').send({ name: 'Technology Updated' });

    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ canonical_key: expect.anything() })
    );
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('canonical_key');
  });

  test('LIST returns canonical_key as part of the row (read-only visibility)', async () => {
    jest.doMock('../../../../../config/supabase', () =>
      mockSupabaseModule({
        order: () =>
          Promise.resolve({
            data: [{ id: 'cd-1', name: 'Technology', canonical_key: 'technology' }],
            error: null,
          }),
      })
    );
    const express = require('express');
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const app = express();
    app.use(express.json());
    app.use('/', careerDomainsModule.router);

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toHaveProperty('canonical_key', 'technology');
  });

  test('_rejectCanonicalKeyMutation() helper: no-op when canonical_key is absent from payload', () => {
    // eslint-disable-next-line global-require
    const careerDomainsModule = require('../adminCmsCareerDomains.module');
    const res = { status: jest.fn(() => res), json: jest.fn() };
    const handled = careerDomainsModule._rejectCanonicalKeyMutation({ body: { name: 'x' } }, res);
    expect(handled).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('Phase 3B.6E.3 — Generic factory regression protection (dormant TABLE_MAP.careerDomains path)', () => {
  test('GOVERNANCE_RESTRICTED_FIELDS denylist excludes canonical_key / canonicalKey from any allowedFields config', () => {
    // eslint-disable-next-line global-require
    const source = fs.readFileSync(
      path.join(__dirname, '../../adminCmsGeneric.factory.js'),
      'utf8'
    );
    expect(source).toMatch(/GOVERNANCE_RESTRICTED_FIELDS\s*=\s*new Set\(\['canonical_key',\s*'canonicalKey'\]\)/);
    expect(source).toMatch(/GOVERNANCE_RESTRICTED_FIELDS\.has\(field\)/);
  });

  test('no live careerDomains generic factory instance is created (route uses the dedicated module)', () => {
    // eslint-disable-next-line global-require
    const source = fs.readFileSync(
      path.join(__dirname, '../../adminCmsGeneric.factory.js'),
      'utf8'
    );
    expect(source).not.toMatch(/createCmsDatasetModule\(\{\s*collection:\s*'cms_career_domains'/);
  });
});
