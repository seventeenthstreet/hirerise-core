'use strict';

/**
 * seed-firestore.js
 *
 * Seeds production Firestore with roles, salaryBands, and roleSkills data.
 * Mirrors the TEST_DATA shape in firebase.js exactly so dev/prod stay in sync.
 *
 * Usage:
 *   node scripts/seed-firestore.js              # dry-run (prints what would be written)
 *   node scripts/seed-firestore.js --write      # writes to Firestore
 *   node scripts/seed-firestore.js --write --merge  # merges (won't overwrite extra fields)
 *
 * Prerequisites:
 *   Set one of:
 *     FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/serviceAccount.json
 *   or:
 *     FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 */

require('dotenv').config();

const path  = require('path');
const admin = require('firebase-admin');

// ─────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const WRITE = args.includes('--write');
const MERGE = args.includes('--merge');

// ─────────────────────────────────────────────────────────────
// SEED DATA
// All amounts are in smallest currency unit (e.g. paise for INR,
// cents for USD). Adjust to your currency / locale as needed.
// ─────────────────────────────────────────────────────────────

/** @type {Record<string, object>} */
const ROLES = {
  se_1: {
    id:          'se_1',
    title:       'Software Engineer I',
    jobFamilyId: 'software_engineering',
    level:       'junior',
    track:       'individual_contributor',
    softDeleted: false,
  },
  se_2: {
    id:          'se_2',
    title:       'Software Engineer II',
    jobFamilyId: 'software_engineering',
    level:       'mid',
    track:       'individual_contributor',
    softDeleted: false,
  },
  se_3: {
    id:          'se_3',
    title:       'Software Engineer III',
    jobFamilyId: 'software_engineering',
    level:       'senior',
    track:       'individual_contributor',
    softDeleted: false,
  },
  tech_lead: {
    id:          'tech_lead',
    title:       'Tech Lead',
    jobFamilyId: 'software_engineering',
    level:       'lead',
    track:       'individual_contributor',
    softDeleted: false,
  },
  engineering_manager: {
    id:          'engineering_manager',
    title:       'Engineering Manager',
    jobFamilyId: 'software_engineering',
    level:       'manager',
    track:       'management',
    softDeleted: false,
  },
  product_manager_1: {
    id:          'product_manager_1',
    title:       'Product Manager I',
    jobFamilyId: 'product_management',
    level:       'junior',
    track:       'individual_contributor',
    softDeleted: false,
  },
  product_manager_2: {
    id:          'product_manager_2',
    title:       'Product Manager II',
    jobFamilyId: 'product_management',
    level:       'mid',
    track:       'individual_contributor',
    softDeleted: false,
  },
  senior_product_manager: {
    id:          'senior_product_manager',
    title:       'Senior Product Manager',
    jobFamilyId: 'product_management',
    level:       'senior',
    track:       'individual_contributor',
    softDeleted: false,
  },
  data_analyst: {
    id:          'data_analyst',
    title:       'Data Analyst',
    jobFamilyId: 'data',
    level:       'mid',
    track:       'individual_contributor',
    softDeleted: false,
  },
  data_scientist: {
    id:          'data_scientist',
    title:       'Data Scientist',
    jobFamilyId: 'data',
    level:       'senior',
    track:       'individual_contributor',
    softDeleted: false,
  },
  devops_engineer: {
    id:          'devops_engineer',
    title:       'DevOps Engineer',
    jobFamilyId: 'infrastructure',
    level:       'mid',
    track:       'individual_contributor',
    softDeleted: false,
  },
  ux_designer: {
    id:          'ux_designer',
    title:       'UX Designer',
    jobFamilyId: 'design',
    level:       'mid',
    track:       'individual_contributor',
    softDeleted: false,
  },
};

/** @type {Record<string, object>} */
const SALARY_BANDS = {
  se_1: {
    roleId:      'se_1',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L1: { min: 400000,  max: 600000,  median: 500000  },
      L2: { min: 600000,  max: 900000,  median: 750000  },
      L3: { min: 900000,  max: 1200000, median: 1050000 },
    },
  },
  se_2: {
    roleId:      'se_2',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L1: { min: 600000,  max: 900000,  median: 750000  },
      L2: { min: 900000,  max: 1200000, median: 1050000 },
      L3: { min: 1200000, max: 1800000, median: 1500000 },
      L4: { min: 1800000, max: 2500000, median: 2100000 },
      L5: { min: 2500000, max: 3500000, median: 3000000 },
      L6: { min: 3500000, max: 5000000, median: 4200000 },
    },
  },
  se_3: {
    roleId:      'se_3',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L3: { min: 1500000, max: 2200000, median: 1800000 },
      L4: { min: 2200000, max: 3200000, median: 2700000 },
      L5: { min: 3200000, max: 4500000, median: 3800000 },
    },
  },
  tech_lead: {
    roleId:      'tech_lead',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L5: { min: 4000000, max: 6000000, median: 5000000 },
      L6: { min: 6000000, max: 9000000, median: 7500000 },
    },
  },
  engineering_manager: {
    roleId:      'engineering_manager',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L5: { min: 5000000,  max: 8000000,  median: 6500000  },
      L6: { min: 8000000,  max: 12000000, median: 10000000 },
      L7: { min: 12000000, max: 20000000, median: 16000000 },
    },
  },
  product_manager_1: {
    roleId:      'product_manager_1',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L2: { min: 700000,  max: 1100000, median: 900000  },
      L3: { min: 1100000, max: 1700000, median: 1400000 },
    },
  },
  product_manager_2: {
    roleId:      'product_manager_2',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L3: { min: 1500000, max: 2500000, median: 2000000 },
      L4: { min: 2500000, max: 4000000, median: 3200000 },
    },
  },
  senior_product_manager: {
    roleId:      'senior_product_manager',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L5: { min: 4000000, max: 7000000, median: 5500000 },
      L6: { min: 7000000, max: 12000000, median: 9500000 },
    },
  },
  data_analyst: {
    roleId:      'data_analyst',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L2: { min: 500000,  max: 900000,  median: 700000  },
      L3: { min: 900000,  max: 1500000, median: 1200000 },
      L4: { min: 1500000, max: 2500000, median: 2000000 },
    },
  },
  data_scientist: {
    roleId:      'data_scientist',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L4: { min: 2000000, max: 3500000, median: 2800000 },
      L5: { min: 3500000, max: 6000000, median: 4800000 },
      L6: { min: 6000000, max: 10000000, median: 8000000 },
    },
  },
  devops_engineer: {
    roleId:      'devops_engineer',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L2: { min: 700000,  max: 1200000, median: 950000  },
      L3: { min: 1200000, max: 2000000, median: 1600000 },
      L4: { min: 2000000, max: 3500000, median: 2800000 },
    },
  },
  ux_designer: {
    roleId:      'ux_designer',
    softDeleted: false,
    currency:    'INR',
    levels: {
      L2: { min: 600000,  max: 1000000, median: 800000  },
      L3: { min: 1000000, max: 1800000, median: 1400000 },
      L4: { min: 1800000, max: 3000000, median: 2400000 },
    },
  },
};

/** @type {Record<string, object>} */
const ROLE_SKILLS = {
  se_1: {
    roleId:      'se_1',
    softDeleted: false,
    skills: [
      { name: 'JavaScript',     category: 'technical', minimumProficiency: 'beginner',     criticality: 4 },
      { name: 'HTML',           category: 'technical', minimumProficiency: 'intermediate', criticality: 3 },
      { name: 'CSS',            category: 'technical', minimumProficiency: 'intermediate', criticality: 3 },
      { name: 'Git',            category: 'technical', minimumProficiency: 'beginner',     criticality: 3 },
      { name: 'Communication',  category: 'soft',      minimumProficiency: 'beginner',     criticality: 3 },
      { name: 'Problem Solving',category: 'soft',      minimumProficiency: 'beginner',     criticality: 4 },
    ],
  },
  se_2: {
    roleId:      'se_2',
    softDeleted: false,
    skills: [
      { name: 'JavaScript',     category: 'technical', minimumProficiency: 'intermediate', criticality: 5 },
      { name: 'Node.js',        category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'SQL',            category: 'technical', minimumProficiency: 'beginner',     criticality: 3 },
      { name: 'Git',            category: 'technical', minimumProficiency: 'beginner',     criticality: 3 },
      { name: 'REST APIs',      category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Testing',        category: 'technical', minimumProficiency: 'beginner',     criticality: 3 },
      { name: 'Communication',  category: 'soft',      minimumProficiency: 'intermediate', criticality: 3 },
      { name: 'Problem Solving',category: 'soft',      minimumProficiency: 'intermediate', criticality: 4 },
    ],
  },
  se_3: {
    roleId:      'se_3',
    softDeleted: false,
    skills: [
      { name: 'System Design',  category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'JavaScript',     category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Node.js',        category: 'technical', minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'SQL',            category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Cloud (AWS/GCP)',category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Mentoring',      category: 'soft',      minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Code Review',    category: 'soft',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Technical Leadership', category: 'soft',minimumProficiency: 'beginner',     criticality: 3 },
    ],
  },
  tech_lead: {
    roleId:      'tech_lead',
    softDeleted: false,
    skills: [
      { name: 'System Design',       category: 'technical', minimumProficiency: 'expert',       criticality: 5 },
      { name: 'Architecture',        category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Technical Leadership',category: 'soft',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Mentoring',           category: 'soft',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Cross-team Collaboration', category: 'soft', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Cloud (AWS/GCP)',     category: 'technical', minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'Performance Optimization', category: 'technical', minimumProficiency: 'advanced', criticality: 4 },
    ],
  },
  engineering_manager: {
    roleId:      'engineering_manager',
    softDeleted: false,
    skills: [
      { name: 'People Management',   category: 'soft',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Technical Leadership',category: 'soft',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Hiring',              category: 'soft',      minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Roadmap Planning',    category: 'soft',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Stakeholder Management', category: 'soft',   minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'System Design',       category: 'technical', minimumProficiency: 'intermediate', criticality: 3 },
      { name: 'Agile / Scrum',       category: 'process',   minimumProficiency: 'advanced',     criticality: 4 },
    ],
  },
  product_manager_1: {
    roleId:      'product_manager_1',
    softDeleted: false,
    skills: [
      { name: 'Product Discovery',   category: 'product',   minimumProficiency: 'beginner',     criticality: 4 },
      { name: 'User Research',       category: 'product',   minimumProficiency: 'beginner',     criticality: 4 },
      { name: 'Prioritization',      category: 'product',   minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'SQL',                 category: 'technical', minimumProficiency: 'beginner',     criticality: 3 },
      { name: 'Communication',       category: 'soft',      minimumProficiency: 'intermediate', criticality: 5 },
      { name: 'Agile / Scrum',       category: 'process',   minimumProficiency: 'beginner',     criticality: 3 },
    ],
  },
  product_manager_2: {
    roleId:      'product_manager_2',
    softDeleted: false,
    skills: [
      { name: 'Product Strategy',    category: 'product',   minimumProficiency: 'intermediate', criticality: 5 },
      { name: 'Data Analysis',       category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'User Research',       category: 'product',   minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Roadmap Planning',    category: 'soft',      minimumProficiency: 'intermediate', criticality: 5 },
      { name: 'Stakeholder Management', category: 'soft',   minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'SQL',                 category: 'technical', minimumProficiency: 'intermediate', criticality: 3 },
    ],
  },
  senior_product_manager: {
    roleId:      'senior_product_manager',
    softDeleted: false,
    skills: [
      { name: 'Product Strategy',    category: 'product',   minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Go-to-Market',        category: 'product',   minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'OKRs / Metrics',      category: 'product',   minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Executive Communication', category: 'soft',  minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Mentoring PMs',       category: 'soft',      minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'SQL',                 category: 'technical', minimumProficiency: 'advanced',     criticality: 4 },
    ],
  },
  data_analyst: {
    roleId:      'data_analyst',
    softDeleted: false,
    skills: [
      { name: 'SQL',              category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Python',          category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Excel / Sheets',  category: 'technical', minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'Data Visualization', category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Statistics',      category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Communication',   category: 'soft',      minimumProficiency: 'intermediate', criticality: 4 },
    ],
  },
  data_scientist: {
    roleId:      'data_scientist',
    softDeleted: false,
    skills: [
      { name: 'Python',           category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Machine Learning', category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'SQL',              category: 'technical', minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'Statistics',       category: 'technical', minimumProficiency: 'expert',       criticality: 5 },
      { name: 'Feature Engineering', category: 'technical', minimumProficiency: 'advanced',  criticality: 4 },
      { name: 'Communication',    category: 'soft',      minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'Experimentation (A/B)', category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
    ],
  },
  devops_engineer: {
    roleId:      'devops_engineer',
    softDeleted: false,
    skills: [
      { name: 'Docker / Kubernetes', category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'CI/CD',               category: 'technical', minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Cloud (AWS/GCP/Azure)', category: 'technical', minimumProficiency: 'advanced',   criticality: 5 },
      { name: 'Linux',               category: 'technical', minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'Infrastructure as Code', category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Monitoring / Observability', category: 'technical', minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Scripting (Bash/Python)', category: 'technical', minimumProficiency: 'intermediate', criticality: 3 },
    ],
  },
  ux_designer: {
    roleId:      'ux_designer',
    softDeleted: false,
    skills: [
      { name: 'Figma',            category: 'tool',      minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'User Research',    category: 'design',    minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Wireframing',      category: 'design',    minimumProficiency: 'advanced',     criticality: 5 },
      { name: 'Prototyping',      category: 'design',    minimumProficiency: 'advanced',     criticality: 4 },
      { name: 'Usability Testing',category: 'design',    minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Design Systems',   category: 'design',    minimumProficiency: 'intermediate', criticality: 4 },
      { name: 'Communication',    category: 'soft',      minimumProficiency: 'advanced',     criticality: 4 },
    ],
  },
};

// ─────────────────────────────────────────────────────────────
// SEED RUNNER
// ─────────────────────────────────────────────────────────────

function initAdmin() {
  if (admin.apps.length > 0) return;

  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const absPath    = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    const svcAccount = require(absPath);
    credential       = admin.credential.cert(svcAccount);
  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  } else {
    throw new Error(
      'No Firebase credentials found.\n' +
      'Set FIREBASE_SERVICE_ACCOUNT_PATH or ' +
      'FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.'
    );
  }

  admin.initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID });
}

async function seedCollection(db, collectionName, records) {
  const entries = Object.entries(records);
  console.log(`\n📦  ${collectionName} — ${entries.length} records`);

  const writeOpts = MERGE ? { merge: true } : {};

  for (const [docId, data] of entries) {
    if (WRITE) {
      await db.collection(collectionName).doc(docId).set(data, writeOpts);
      console.log(`  ✅  ${docId}`);
    } else {
      console.log(`  🔍  [DRY-RUN] would write ${collectionName}/${docId}:`, JSON.stringify(data, null, 2));
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HireRise — Firestore Seed Script');
  console.log(`  Mode  : ${WRITE ? (MERGE ? 'WRITE + MERGE' : 'WRITE (overwrite)') : 'DRY-RUN'}`);
  console.log('═══════════════════════════════════════════════════');

  if (!WRITE) {
    console.log('\n⚠️  Dry-run mode. Pass --write to actually write to Firestore.\n');
  }

  initAdmin();
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });

  await seedCollection(db, 'roles',       ROLES);
  await seedCollection(db, 'salaryBands', SALARY_BANDS);
  await seedCollection(db, 'roleSkills',  ROLE_SKILLS);

  console.log('\n✨  Seed complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌  Seed failed:', err.message);
  process.exit(1);
});