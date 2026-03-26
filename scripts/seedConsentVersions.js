'use strict';

/**
 * seedConsentVersions.js
 *
 * Seeds the `consentVersions` Firestore collection with the current and
 * any historical versions of the HireRise Terms of Service and Privacy Policy.
 *
 * USAGE:
 *   node scripts/seedConsentVersions.js
 *
 * RUN WHEN:
 *   - First deployment (creates the initial "1.0" record)
 *   - T&C / Privacy Policy is updated (add new version, optionally deprecate old)
 *
 * COLLECTION SCHEMA: consentVersions/{version}
 *   version        {string}   — document ID, e.g. "1.0", "1.1", "2.0"
 *   label          {string}   — human-readable label for ops dashboard
 *   effectiveDate  {string}   — ISO date string when this version went live
 *   deprecated     {boolean}  — true = saveConsent() will reject this version
 *   tosUrl         {string}   — URL to the T&C document for this version
 *   privacyUrl     {string}   — URL to the Privacy Policy document
 *   createdAt      {Timestamp}
 *
 * IDEMPOTENT: Safe to run multiple times. Uses set(merge:true) so existing
 * records are not overwritten — only missing fields are filled.
 */

require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { db } = require('../src/core/supabaseDbShim');

// ── Firebase init ─────────────────────────────────────────────────────────────
const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? require(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : null;

if (!serviceAccount && !process.env.FIREBASE_PROJECT_ID) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_PROJECT_ID env vars before running this script.');
  process.exit(1);
}

initializeApp(serviceAccount
  ? { credential: cert(serviceAccount) }
  : { projectId: process.env.FIREBASE_PROJECT_ID }
);



// ── Consent version records ───────────────────────────────────────────────────

const CONSENT_VERSIONS = [
  {
    version:       '1.0',
    label:         'Initial release — March 2026',
    effectiveDate: '2026-03-01',
    deprecated:    false,
    tosUrl:        'https://hirerise.app/legal/terms/1.0',
    privacyUrl:    'https://hirerise.app/legal/privacy/1.0',
  },
  // Add future versions here, e.g.:
  // {
  //   version:       '1.1',
  //   label:         'Updated data retention policy — Q2 2026',
  //   effectiveDate: '2026-06-01',
  //   deprecated:    false,
  //   tosUrl:        'https://hirerise.app/legal/terms/1.1',
  //   privacyUrl:    'https://hirerise.app/legal/privacy/1.1',
  // },
];

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`Seeding ${CONSENT_VERSIONS.length} consent version(s) into Firestore...`);

  const batch = db.batch();

  for (const v of CONSENT_VERSIONS) {
    const ref = db.collection('consentVersions').doc(v.version);
    batch.set(ref, {
      ...v,
      createdAt: new Date(),
    }, { merge: true });
    console.log(`  • Version ${v.version} — deprecated: ${v.deprecated}`);
  }

  await batch.commit();
  console.log('Done. consentVersions collection is ready.');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});