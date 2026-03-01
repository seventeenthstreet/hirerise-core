'use strict';

/**
 * src/scripts/seedQualifications.js
 *
 * Seeds the qualifications/{qualificationId} Firestore collection with
 * 40 common Indian academic qualifications.
 *
 * Usage:
 *   node src/scripts/seedQualifications.js
 *
 * IDs are slug-based (lowercase, underscores) and deterministic — re-running
 * this script is safe: set(..., { merge: true }) updates existing docs without
 * overwriting fields added after the initial seed.
 *
 * Level vocabulary:
 *   undergraduate | postgraduate | doctorate | diploma | certificate
 *
 * Category vocabulary:
 *   degree | professional | diploma | certificate
 *
 * Domain is always a non-null string. Cross-domain qualifications use 'general'.
 */

const { db } = require('../../config/firebase');

const now = new Date();

/** @type {Array<{ id: string, doc: object }>} */
const QUALIFICATIONS = [
  // ── Undergraduate — Engineering ───────────────────────────────────────────
  {
    id: 'bachelor_of_technology',
    doc: {
      name:      'Bachelor of Technology',
      shortName: 'B.Tech',
      level:     'undergraduate',
      domain:    'engineering',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bachelor_of_engineering',
    doc: {
      name:      'Bachelor of Engineering',
      shortName: 'B.E.',
      level:     'undergraduate',
      domain:    'engineering',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Science ───────────────────────────────────────────────
  {
    id: 'bachelor_of_science',
    doc: {
      name:      'Bachelor of Science',
      shortName: 'B.Sc.',
      level:     'undergraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bsc_computer_science',
    doc: {
      name:      'Bachelor of Science in Computer Science',
      shortName: 'B.Sc. CS',
      level:     'undergraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bsc_mathematics',
    doc: {
      name:      'Bachelor of Science in Mathematics',
      shortName: 'B.Sc. Maths',
      level:     'undergraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bsc_physics',
    doc: {
      name:      'Bachelor of Science in Physics',
      shortName: 'B.Sc. Physics',
      level:     'undergraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Commerce ──────────────────────────────────────────────
  {
    id: 'bachelor_of_commerce',
    doc: {
      name:      'Bachelor of Commerce',
      shortName: 'B.Com',
      level:     'undergraduate',
      domain:    'commerce',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bachelor_of_commerce_honours',
    doc: {
      name:      'Bachelor of Commerce (Honours)',
      shortName: 'B.Com (Hons)',
      level:     'undergraduate',
      domain:    'commerce',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bachelor_of_business_administration',
    doc: {
      name:      'Bachelor of Business Administration',
      shortName: 'BBA',
      level:     'undergraduate',
      domain:    'commerce',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Arts & Humanities ────────────────────────────────────
  {
    id: 'bachelor_of_arts',
    doc: {
      name:      'Bachelor of Arts',
      shortName: 'B.A.',
      level:     'undergraduate',
      domain:    'arts',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bachelor_of_arts_honours',
    doc: {
      name:      'Bachelor of Arts (Honours)',
      shortName: 'B.A. (Hons)',
      level:     'undergraduate',
      domain:    'arts',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Law ───────────────────────────────────────────────────
  {
    id: 'bachelor_of_laws',
    doc: {
      name:      'Bachelor of Laws',
      shortName: 'LL.B.',
      level:     'undergraduate',
      domain:    'law',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'ba_llb',
    doc: {
      name:      'Bachelor of Arts and Bachelor of Laws',
      shortName: 'BA LL.B.',
      level:     'undergraduate',
      domain:    'law',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Medicine & Health ─────────────────────────────────────
  {
    id: 'bachelor_of_medicine_bachelor_of_surgery',
    doc: {
      name:      'Bachelor of Medicine, Bachelor of Surgery',
      shortName: 'MBBS',
      level:     'undergraduate',
      domain:    'medicine',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bachelor_of_pharmacy',
    doc: {
      name:      'Bachelor of Pharmacy',
      shortName: 'B.Pharm',
      level:     'undergraduate',
      domain:    'medicine',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Design & Architecture ────────────────────────────────
  {
    id: 'bachelor_of_architecture',
    doc: {
      name:      'Bachelor of Architecture',
      shortName: 'B.Arch',
      level:     'undergraduate',
      domain:    'design',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'bachelor_of_design',
    doc: {
      name:      'Bachelor of Design',
      shortName: 'B.Des',
      level:     'undergraduate',
      domain:    'design',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Undergraduate — Education ─────────────────────────────────────────────
  {
    id: 'bachelor_of_education',
    doc: {
      name:      'Bachelor of Education',
      shortName: 'B.Ed',
      level:     'undergraduate',
      domain:    'education',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Postgraduate — Engineering ────────────────────────────────────────────
  {
    id: 'master_of_technology',
    doc: {
      name:      'Master of Technology',
      shortName: 'M.Tech',
      level:     'postgraduate',
      domain:    'engineering',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'mtech_computer_science',
    doc: {
      name:      'Master of Technology in Computer Science',
      shortName: 'M.Tech CS',
      level:     'postgraduate',
      domain:    'engineering',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'mtech_mechanical_engineering',
    doc: {
      name:      'Master of Technology in Mechanical Engineering',
      shortName: 'M.Tech Mech',
      level:     'postgraduate',
      domain:    'engineering',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'master_of_engineering',
    doc: {
      name:      'Master of Engineering',
      shortName: 'M.E.',
      level:     'postgraduate',
      domain:    'engineering',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Postgraduate — Business ───────────────────────────────────────────────
  {
    id: 'master_of_business_administration',
    doc: {
      name:      'Master of Business Administration',
      shortName: 'MBA',
      level:     'postgraduate',
      domain:    'commerce',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'pgdm',
    doc: {
      name:      'Post Graduate Diploma in Management',
      shortName: 'PGDM',
      // PGDM is awarded by autonomous institutes (not UGC-affiliated universities),
      // making it a professional credential rather than a statutory degree.
      level:     'postgraduate',
      domain:    'commerce',
      category:  'professional',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Postgraduate — Science & Computing ───────────────────────────────────
  {
    id: 'master_of_science',
    doc: {
      name:      'Master of Science',
      shortName: 'M.Sc.',
      level:     'postgraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'msc_computer_science',
    doc: {
      name:      'Master of Science in Computer Science',
      shortName: 'M.Sc. CS',
      level:     'postgraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'master_of_computer_applications',
    doc: {
      name:      'Master of Computer Applications',
      shortName: 'MCA',
      level:     'postgraduate',
      domain:    'science',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Postgraduate — Commerce & Finance ────────────────────────────────────
  {
    id: 'master_of_commerce',
    doc: {
      name:      'Master of Commerce',
      shortName: 'M.Com',
      level:     'postgraduate',
      domain:    'commerce',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Postgraduate — Arts & Law ─────────────────────────────────────────────
  {
    id: 'master_of_arts',
    doc: {
      name:      'Master of Arts',
      shortName: 'M.A.',
      level:     'postgraduate',
      domain:    'arts',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'master_of_laws',
    doc: {
      name:      'Master of Laws',
      shortName: 'LL.M.',
      level:     'postgraduate',
      domain:    'law',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Doctorate ────────────────────────────────────────────────────────────
  {
    id: 'doctor_of_philosophy',
    doc: {
      name:      'Doctor of Philosophy',
      shortName: 'Ph.D.',
      level:     'doctorate',
      // Ph.D. is awarded across all disciplines — 'general' avoids false domain
      // specificity and prevents incorrect role-alignment filtering.
      domain:    'general',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'doctor_of_medicine',
    doc: {
      name:      'Doctor of Medicine',
      shortName: 'MD',
      level:     'doctorate',
      domain:    'medicine',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'master_of_surgery',
    doc: {
      name:      'Master of Surgery',
      shortName: 'MS',
      level:     'doctorate',
      domain:    'medicine',
      category:  'degree',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Diploma ───────────────────────────────────────────────────────────────
  {
    id: 'diploma_in_engineering',
    doc: {
      name:      'Diploma in Engineering',
      shortName: 'Diploma (Engg.)',
      level:     'diploma',
      domain:    'engineering',
      category:  'diploma',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'diploma_in_computer_science',
    doc: {
      name:      'Diploma in Computer Science',
      shortName: 'Diploma (CS)',
      level:     'diploma',
      domain:    'science',
      category:  'diploma',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'diploma_in_business_management',
    doc: {
      name:      'Diploma in Business Management',
      shortName: 'DBM',
      level:     'diploma',
      domain:    'commerce',
      category:  'diploma',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'advanced_diploma_in_software_technology',
    doc: {
      name:      'Advanced Diploma in Software Technology',
      shortName: 'ADST',
      level:     'diploma',
      domain:    'science',
      category:  'diploma',
      country:   'IN',
      isActive:  true,
    },
  },

  // ── Certificate ───────────────────────────────────────────────────────────
  {
    id: 'certificate_in_digital_marketing',
    doc: {
      name:      'Certificate in Digital Marketing',
      shortName: null,
      level:     'certificate',
      domain:    'commerce',
      category:  'certificate',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'certificate_in_data_science',
    doc: {
      name:      'Certificate in Data Science',
      shortName: null,
      level:     'certificate',
      domain:    'science',
      category:  'certificate',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'certificate_in_cloud_computing',
    doc: {
      name:      'Certificate in Cloud Computing',
      shortName: null,
      level:     'certificate',
      domain:    'engineering',
      category:  'certificate',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'certificate_in_financial_accounting',
    doc: {
      name:      'Certificate in Financial Accounting',
      shortName: null,
      level:     'certificate',
      domain:    'commerce',
      category:  'certificate',
      country:   'IN',
      isActive:  true,
    },
  },
  {
    id: 'certificate_in_human_resource_management',
    doc: {
      name:      'Certificate in Human Resource Management',
      shortName: null,
      level:     'certificate',
      domain:    'commerce',
      category:  'certificate',
      country:   'IN',
      isActive:  true,
    },
  },
];

// ── Pre-flight integrity check ────────────────────────────────────────────────
// Catches missing or invalid fields before any Firestore writes are attempted.
// Fails fast at script startup rather than mid-way through a batch write.

const VALID_LEVELS     = new Set(['undergraduate', 'postgraduate', 'doctorate', 'diploma', 'certificate']);
const VALID_CATEGORIES = new Set(['degree', 'professional', 'diploma', 'certificate']);

for (const { id, doc } of QUALIFICATIONS) {
  if (!id || typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`[seedQualifications] Invalid ID format: "${id}"`);
  }
  if (!doc.name  || typeof doc.name  !== 'string') throw new Error(`[seedQualifications] Missing name on: ${id}`);
  if (!doc.level || !VALID_LEVELS.has(doc.level))  throw new Error(`[seedQualifications] Invalid level on: ${id} (${doc.level})`);
  if (!doc.category || !VALID_CATEGORIES.has(doc.category)) throw new Error(`[seedQualifications] Invalid category on: ${id} (${doc.category})`);
  if (!doc.domain || typeof doc.domain !== 'string') throw new Error(`[seedQualifications] domain must be a non-null string on: ${id}`);
  if (typeof doc.isActive !== 'boolean') throw new Error(`[seedQualifications] isActive must be boolean on: ${id}`);
}

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  const col   = db.collection('qualifications');
  let   count = 0;

  for (const { id, doc } of QUALIFICATIONS) {
    await col.doc(id).set(
      { ...doc, createdAt: now, updatedAt: now },
      { merge: true }
    );
    count++;
    process.stdout.write(`  ✓ ${id}\n`);
  }

  console.log(`\n[seedQualifications] Seeded ${count} qualification(s) into qualifications/.`);
}

seed().catch((err) => {
  console.error('[seedQualifications] Fatal error:', err);
  process.exit(1);
});