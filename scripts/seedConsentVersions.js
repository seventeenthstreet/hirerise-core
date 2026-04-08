'use strict';

/**
 * seedConsentVersions.js — PRODUCTION HARDENED (SUPABASE RPC)
 */

require('dotenv').config();

const { supabase } = require('../src/config/supabase');

const CONSENT_VERSIONS = Object.freeze([
  {
    version: '1.0',
    label: 'Initial release — March 2026',
    effective_date: '2026-03-01',
    deprecated: false,
    tos_url: 'https://hirerise.app/legal/terms/1.0',
    privacy_url: 'https://hirerise.app/legal/privacy/1.0',
  },
]);

function validateVersion(v) {
  if (!v.version) throw new Error('Missing version');
  if (!v.label) throw new Error(`Missing label for ${v.version}`);
  if (!v.effective_date) {
    throw new Error(`Missing effective_date for ${v.version}`);
  }
  if (!v.tos_url || !v.privacy_url) {
    throw new Error(`Missing URLs for ${v.version}`);
  }
}

async function seed() {
  console.info(
    `Seeding ${CONSENT_VERSIONS.length} consent version(s)...`,
  );

  if (!CONSENT_VERSIONS.length) {
    throw new Error('No consent versions defined');
  }

  for (const version of CONSENT_VERSIONS) {
    validateVersion(version);
  }

  const { error } = await supabase.rpc(
    'seed_consent_versions',
    {
      versions: CONSENT_VERSIONS,
    },
  );

  if (error) {
    throw error;
  }

  console.info('✅ consent_versions seeded successfully');
}

seed()
  .catch((err) => {
    console.error('[Seed] Fatal error:', {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });

    process.exitCode = 1;
  });