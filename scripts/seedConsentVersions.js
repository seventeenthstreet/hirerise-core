'use strict';

/**
 * seedConsentVersions.js — PRODUCTION HARDENED (SUPABASE)
 */

require('dotenv').config();

const { supabase } = require('../src/config/supabase');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const CONSENT_VERSIONS = [
  {
    version:       '1.0',
    label:         'Initial release — March 2026',
    effective_date:'2026-03-01',
    deprecated:    false,
    tos_url:       'https://hirerise.app/legal/terms/1.0',
    privacy_url:   'https://hirerise.app/legal/privacy/1.0',
  },
];

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

function validateVersion(v) {
  if (!v.version) throw new Error('Missing version');
  if (!v.label) throw new Error(`Missing label for ${v.version}`);
  if (!v.effective_date) throw new Error(`Missing effective_date for ${v.version}`);
  if (!v.tos_url || !v.privacy_url) {
    throw new Error(`Missing URLs for ${v.version}`);
  }
}

// ─────────────────────────────────────────────
// SEED FUNCTION
// ─────────────────────────────────────────────

async function seed() {
  console.log(`Seeding ${CONSENT_VERSIONS.length} consent version(s)...`);

  if (!CONSENT_VERSIONS.length) {
    throw new Error('No consent versions defined');
  }

  const now = new Date().toISOString();

  const payload = CONSENT_VERSIONS.map(v => {
    validateVersion(v);

    return {
      version: v.version,
      label: v.label,
      effective_date: v.effective_date,
      deprecated: v.deprecated ?? false,
      tos_url: v.tos_url,
      privacy_url: v.privacy_url,
      created_at: now,
    };
  });

  try {
    // ── UPSERT (IDEMPOTENT) ──
    const { error: upsertError } = await supabase
      .from('consent_versions')
      .upsert(payload, {
        onConflict: 'version',
      });

    if (upsertError) {
      throw upsertError;
    }

    // ── Deprecate old versions safely ──
    const activeVersions = CONSENT_VERSIONS.map(v => `'${v.version}'`);

    const { error: updateError } = await supabase
      .from('consent_versions')
      .update({ deprecated: true })
      .not('version', 'in', `(${activeVersions.join(',')})`);

    if (updateError) {
      console.warn('[Seed] Warning: failed to deprecate old versions', {
        message: updateError.message,
      });
    }

    console.log('✅ consent_versions seeded successfully');

  } catch (err) {
    console.error('[Seed] Failed:', {
      message: err?.message,
      stack: err?.stack,
    });
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// EXECUTE
// ─────────────────────────────────────────────

seed().catch(err => {
  console.error('[Seed] Fatal error:', {
    message: err?.message,
    stack: err?.stack,
  });
  process.exit(1);
});