'use strict';

/**
 * src/scripts/seedRoles.js
 *
 * Seeds the roles/{roleId} Firestore collection with common Indian job market roles
 * spanning Software Engineering, Product, Data, Design, and Business functions.
 *
 * Usage:
 *   node src/scripts/seedRoles.js
 *
 * IDs are slug-based, lowercase, hyphen-separated — deterministic and human-readable.
 * Re-running is safe: set(..., { merge: true }) preserves fields added after the seed.
 *
 * Document schema:
 * {
 *   roleId:         string  (same as document ID)
 *   title:          string
 *   category:       string  (engineering | product | data | design | business | operations)
 *   aliases:        string[] (alternative titles used in job postings)
 *   skillTags:      string[] (top skills associated with this role)
 *   careerPathNext: string[] (roleIds of logical next roles — no FK enforcement in Firestore)
 *   active:         boolean
 *   createdAt:      Timestamp
 *   updatedAt:      Timestamp
 * }
 */

const { db } = require('../../config/firebase');

const now = new Date();

/** @type {Array<{ id: string, doc: object }>} */
const ROLES = [

  // ── Software Engineering ──────────────────────────────────────────────────
  {
    id: 'software-engineer-i',
    doc: {
      title:          'Software Engineer I',
      category:       'engineering',
      aliases:        ['Junior Software Engineer', 'Junior Developer', 'Junior SWE'],
      skillTags:      ['JavaScript', 'Python', 'Git', 'REST APIs', 'SQL'],
      careerPathNext: ['software-engineer-ii'],
      active:         true,
    },
  },
  {
    id: 'software-engineer-ii',
    doc: {
      title:          'Software Engineer II',
      category:       'engineering',
      aliases:        ['Mid-level Software Engineer', 'Software Developer', 'SWE II'],
      skillTags:      ['JavaScript', 'Node.js', 'React', 'System Design', 'SQL', 'Git'],
      careerPathNext: ['software-engineer-iii', 'full-stack-engineer'],
      active:         true,
    },
  },
  {
    id: 'software-engineer-iii',
    doc: {
      title:          'Software Engineer III',
      category:       'engineering',
      aliases:        ['Senior Software Engineer', 'Senior Developer', 'Senior SWE'],
      skillTags:      ['System Design', 'Microservices', 'Cloud', 'Mentoring', 'Node.js', 'React'],
      careerPathNext: ['tech-lead', 'staff-engineer', 'engineering-manager'],
      active:         true,
    },
  },
  {
    id: 'tech-lead',
    doc: {
      title:          'Tech Lead',
      category:       'engineering',
      aliases:        ['Technical Lead', 'Lead Engineer', 'Lead Developer'],
      skillTags:      ['Architecture', 'Code Review', 'Mentoring', 'System Design', 'Agile'],
      careerPathNext: ['staff-engineer', 'engineering-manager', 'principal-engineer'],
      active:         true,
    },
  },
  {
    id: 'staff-engineer',
    doc: {
      title:          'Staff Engineer',
      category:       'engineering',
      aliases:        ['Staff Software Engineer', 'Staff SWE'],
      skillTags:      ['Architecture', 'Technical Strategy', 'Cross-team Collaboration', 'Mentoring'],
      careerPathNext: ['principal-engineer', 'distinguished-engineer'],
      active:         true,
    },
  },
  {
    id: 'principal-engineer',
    doc: {
      title:          'Principal Engineer',
      category:       'engineering',
      aliases:        ['Principal Software Engineer', 'Principal SWE'],
      skillTags:      ['Technical Vision', 'Architecture', 'Stakeholder Management', 'Systems Thinking'],
      careerPathNext: ['distinguished-engineer', 'vp-engineering'],
      active:         true,
    },
  },
  {
    id: 'engineering-manager',
    doc: {
      title:          'Engineering Manager',
      category:       'engineering',
      aliases:        ['EM', 'Dev Manager', 'Software Development Manager'],
      skillTags:      ['People Management', 'Hiring', 'Roadmap Planning', 'Agile', 'Performance Reviews'],
      careerPathNext: ['director-of-engineering', 'vp-engineering'],
      active:         true,
    },
  },
  {
    id: 'director-of-engineering',
    doc: {
      title:          'Director of Engineering',
      category:       'engineering',
      aliases:        ['Director Engineering', 'Head of Engineering'],
      skillTags:      ['Org Design', 'Budgeting', 'Technical Strategy', 'Stakeholder Management'],
      careerPathNext: ['vp-engineering', 'cto'],
      active:         true,
    },
  },
  {
    id: 'vp-engineering',
    doc: {
      title:          'VP of Engineering',
      category:       'engineering',
      aliases:        ['VP Engineering', 'Vice President Engineering'],
      skillTags:      ['Org Leadership', 'P&L', 'Technical Strategy', 'Executive Communication'],
      careerPathNext: ['cto'],
      active:         true,
    },
  },
  {
    id: 'full-stack-engineer',
    doc: {
      title:          'Full Stack Engineer',
      category:       'engineering',
      aliases:        ['Full Stack Developer', 'Full-Stack Software Engineer'],
      skillTags:      ['React', 'Node.js', 'SQL', 'REST APIs', 'CSS', 'Cloud'],
      careerPathNext: ['software-engineer-iii', 'tech-lead'],
      active:         true,
    },
  },
  {
    id: 'backend-engineer',
    doc: {
      title:          'Backend Engineer',
      category:       'engineering',
      aliases:        ['Backend Developer', 'Server-side Engineer'],
      skillTags:      ['Node.js', 'Python', 'SQL', 'Microservices', 'REST APIs', 'Cloud'],
      careerPathNext: ['software-engineer-iii', 'tech-lead'],
      active:         true,
    },
  },
  {
    id: 'frontend-engineer',
    doc: {
      title:          'Frontend Engineer',
      category:       'engineering',
      aliases:        ['Frontend Developer', 'UI Engineer', 'React Developer'],
      skillTags:      ['React', 'TypeScript', 'CSS', 'HTML', 'Performance Optimisation'],
      careerPathNext: ['software-engineer-iii', 'tech-lead'],
      active:         true,
    },
  },
  {
    id: 'devops-engineer',
    doc: {
      title:          'DevOps Engineer',
      category:       'engineering',
      aliases:        ['Site Reliability Engineer', 'SRE', 'Platform Engineer', 'Infrastructure Engineer'],
      skillTags:      ['Kubernetes', 'Docker', 'CI/CD', 'Terraform', 'AWS', 'GCP', 'Monitoring'],
      careerPathNext: ['senior-devops-engineer', 'engineering-manager'],
      active:         true,
    },
  },
  {
    id: 'senior-devops-engineer',
    doc: {
      title:          'Senior DevOps Engineer',
      category:       'engineering',
      aliases:        ['Senior SRE', 'Senior Platform Engineer'],
      skillTags:      ['Kubernetes', 'Terraform', 'AWS', 'Security', 'FinOps', 'Architecture'],
      careerPathNext: ['staff-engineer', 'engineering-manager'],
      active:         true,
    },
  },

  // ── Product Management ────────────────────────────────────────────────────
  {
    id: 'associate-product-manager',
    doc: {
      title:          'Associate Product Manager',
      category:       'product',
      aliases:        ['APM', 'Junior Product Manager'],
      skillTags:      ['Product Thinking', 'User Research', 'Jira', 'Data Analysis', 'PRD Writing'],
      careerPathNext: ['product-manager'],
      active:         true,
    },
  },
  {
    id: 'product-manager',
    doc: {
      title:          'Product Manager',
      category:       'product',
      aliases:        ['PM', 'Digital Product Manager'],
      skillTags:      ['Roadmapping', 'Stakeholder Management', 'A/B Testing', 'SQL', 'User Research'],
      careerPathNext: ['senior-product-manager'],
      active:         true,
    },
  },
  {
    id: 'senior-product-manager',
    doc: {
      title:          'Senior Product Manager',
      category:       'product',
      aliases:        ['Senior PM', 'Sr. Product Manager'],
      skillTags:      ['Product Strategy', 'OKRs', 'Go-to-Market', 'Data Analysis', 'Roadmapping'],
      careerPathNext: ['group-product-manager', 'director-of-product'],
      active:         true,
    },
  },
  {
    id: 'group-product-manager',
    doc: {
      title:          'Group Product Manager',
      category:       'product',
      aliases:        ['GPM', 'Lead Product Manager'],
      skillTags:      ['Product Portfolio', 'Team Leadership', 'Strategy', 'Executive Communication'],
      careerPathNext: ['director-of-product', 'vp-product'],
      active:         true,
    },
  },
  {
    id: 'director-of-product',
    doc: {
      title:          'Director of Product',
      category:       'product',
      aliases:        ['Director Product Management', 'Head of Product'],
      skillTags:      ['Product Vision', 'P&L', 'Hiring', 'Cross-functional Leadership'],
      careerPathNext: ['vp-product', 'cpo'],
      active:         true,
    },
  },
  {
    id: 'vp-product',
    doc: {
      title:          'VP of Product',
      category:       'product',
      aliases:        ['VP Product', 'Vice President Product'],
      skillTags:      ['Company Strategy', 'Product Vision', 'Executive Stakeholders'],
      careerPathNext: ['cpo'],
      active:         true,
    },
  },

  // ── Data & Analytics ──────────────────────────────────────────────────────
  {
    id: 'data-analyst',
    doc: {
      title:          'Data Analyst',
      category:       'data',
      aliases:        ['Business Analyst', 'Analytics Analyst', 'Junior Data Analyst'],
      skillTags:      ['SQL', 'Excel', 'Power BI', 'Tableau', 'Python', 'Data Storytelling'],
      careerPathNext: ['senior-data-analyst', 'data-scientist'],
      active:         true,
    },
  },
  {
    id: 'senior-data-analyst',
    doc: {
      title:          'Senior Data Analyst',
      category:       'data',
      aliases:        ['Sr. Data Analyst', 'Lead Analyst'],
      skillTags:      ['SQL', 'Python', 'Statistics', 'Dashboard Design', 'A/B Testing'],
      careerPathNext: ['data-scientist', 'analytics-engineering-lead'],
      active:         true,
    },
  },
  {
    id: 'data-scientist',
    doc: {
      title:          'Data Scientist',
      category:       'data',
      aliases:        ['Applied Scientist', 'ML Scientist'],
      skillTags:      ['Python', 'Machine Learning', 'Statistics', 'SQL', 'TensorFlow', 'Feature Engineering'],
      careerPathNext: ['senior-data-scientist', 'ml-engineer'],
      active:         true,
    },
  },
  {
    id: 'senior-data-scientist',
    doc: {
      title:          'Senior Data Scientist',
      category:       'data',
      aliases:        ['Sr. Data Scientist', 'Lead Data Scientist'],
      skillTags:      ['Deep Learning', 'MLOps', 'Statistical Modelling', 'Python', 'Team Leadership'],
      careerPathNext: ['principal-data-scientist', 'head-of-data'],
      active:         true,
    },
  },
  {
    id: 'ml-engineer',
    doc: {
      title:          'Machine Learning Engineer',
      category:       'data',
      aliases:        ['ML Engineer', 'AI Engineer', 'MLOps Engineer'],
      skillTags:      ['Python', 'TensorFlow', 'PyTorch', 'MLOps', 'Kubernetes', 'Cloud'],
      careerPathNext: ['senior-ml-engineer', 'staff-ml-engineer'],
      active:         true,
    },
  },
  {
    id: 'data-engineer',
    doc: {
      title:          'Data Engineer',
      category:       'data',
      aliases:        ['Big Data Engineer', 'Analytics Engineer', 'ETL Developer'],
      skillTags:      ['Python', 'Spark', 'Airflow', 'dbt', 'SQL', 'Cloud', 'Kafka'],
      careerPathNext: ['senior-data-engineer', 'head-of-data'],
      active:         true,
    },
  },
  {
    id: 'head-of-data',
    doc: {
      title:          'Head of Data',
      category:       'data',
      aliases:        ['Head of Data Engineering', 'Head of Analytics', 'Director of Data'],
      skillTags:      ['Data Strategy', 'Team Leadership', 'Data Governance', 'Stakeholder Management'],
      careerPathNext: ['chief-data-officer'],
      active:         true,
    },
  },

  // ── Design ────────────────────────────────────────────────────────────────
  {
    id: 'ux-designer',
    doc: {
      title:          'UX Designer',
      category:       'design',
      aliases:        ['User Experience Designer', 'Interaction Designer', 'Junior UX Designer'],
      skillTags:      ['Figma', 'User Research', 'Wireframing', 'Prototyping', 'Usability Testing'],
      careerPathNext: ['senior-ux-designer', 'product-designer'],
      active:         true,
    },
  },
  {
    id: 'senior-ux-designer',
    doc: {
      title:          'Senior UX Designer',
      category:       'design',
      aliases:        ['Sr. UX Designer', 'Lead UX Designer'],
      skillTags:      ['Figma', 'Design Systems', 'UX Research', 'Accessibility', 'Stakeholder Alignment'],
      careerPathNext: ['principal-designer', 'head-of-design'],
      active:         true,
    },
  },
  {
    id: 'product-designer',
    doc: {
      title:          'Product Designer',
      category:       'design',
      aliases:        ['UI/UX Designer', 'Digital Product Designer'],
      skillTags:      ['Figma', 'Prototyping', 'User Research', 'Design Thinking', 'Visual Design'],
      careerPathNext: ['senior-ux-designer', 'head-of-design'],
      active:         true,
    },
  },
  {
    id: 'head-of-design',
    doc: {
      title:          'Head of Design',
      category:       'design',
      aliases:        ['Design Lead', 'VP Design', 'Director of Design'],
      skillTags:      ['Design Strategy', 'Team Leadership', 'Design Systems', 'Executive Communication'],
      careerPathNext: ['chief-design-officer'],
      active:         true,
    },
  },

  // ── Business & Operations ─────────────────────────────────────────────────
  {
    id: 'business-analyst',
    doc: {
      title:          'Business Analyst',
      category:       'business',
      aliases:        ['BA', 'Systems Analyst', 'Requirements Analyst'],
      skillTags:      ['Requirements Gathering', 'Stakeholder Management', 'SQL', 'Process Mapping', 'Excel'],
      careerPathNext: ['senior-business-analyst', 'product-manager'],
      active:         true,
    },
  },
  {
    id: 'senior-business-analyst',
    doc: {
      title:          'Senior Business Analyst',
      category:       'business',
      aliases:        ['Sr. BA', 'Lead Business Analyst'],
      skillTags:      ['Process Improvement', 'Data Analysis', 'Stakeholder Management', 'Agile'],
      careerPathNext: ['product-manager', 'consulting-manager'],
      active:         true,
    },
  },
  {
    id: 'scrum-master',
    doc: {
      title:          'Scrum Master',
      category:       'operations',
      aliases:        ['Agile Coach', 'Agile Delivery Manager', 'Sprint Master'],
      skillTags:      ['Scrum', 'Kanban', 'Jira', 'Facilitation', 'Retrospectives', 'Stakeholder Management'],
      careerPathNext: ['agile-coach', 'engineering-manager'],
      active:         true,
    },
  },
  {
    id: 'project-manager',
    doc: {
      title:          'Project Manager',
      category:       'operations',
      aliases:        ['PM', 'Technical Project Manager', 'TPM', 'Delivery Manager'],
      skillTags:      ['Project Planning', 'Risk Management', 'Stakeholder Management', 'MS Project', 'Agile'],
      careerPathNext: ['senior-project-manager', 'program-manager'],
      active:         true,
    },
  },
  {
    id: 'program-manager',
    doc: {
      title:          'Program Manager',
      category:       'operations',
      aliases:        ['Technical Program Manager', 'TPgM'],
      skillTags:      ['Program Governance', 'Cross-team Coordination', 'Risk Management', 'Executive Reporting'],
      careerPathNext: ['director-of-program-management', 'vp-engineering'],
      active:         true,
    },
  },

  // ── Sales & Marketing (tech companies) ───────────────────────────────────
  {
    id: 'sales-development-representative',
    doc: {
      title:          'Sales Development Representative',
      category:       'business',
      aliases:        ['SDR', 'Business Development Representative', 'BDR'],
      skillTags:      ['Prospecting', 'CRM', 'Cold Outreach', 'Communication', 'Salesforce'],
      careerPathNext: ['account-executive'],
      active:         true,
    },
  },
  {
    id: 'account-executive',
    doc: {
      title:          'Account Executive',
      category:       'business',
      aliases:        ['AE', 'Sales Executive', 'Enterprise Sales'],
      skillTags:      ['Consultative Selling', 'CRM', 'Contract Negotiation', 'Pipeline Management'],
      careerPathNext: ['senior-account-executive', 'sales-manager'],
      active:         true,
    },
  },
  {
    id: 'growth-manager',
    doc: {
      title:          'Growth Manager',
      category:       'business',
      aliases:        ['Growth Marketing Manager', 'Acquisition Manager'],
      skillTags:      ['Growth Hacking', 'A/B Testing', 'SQL', 'Analytics', 'Paid Acquisition', 'SEO'],
      careerPathNext: ['head-of-growth', 'vp-marketing'],
      active:         true,
    },
  },
];

// ── Pre-flight integrity check ─────────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['engineering', 'product', 'data', 'design', 'business', 'operations']);

for (const { id, doc } of ROLES) {
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`[seedRoles] Invalid ID format: "${id}"`);
  }
  if (!doc.title  || typeof doc.title  !== 'string') throw new Error(`[seedRoles] Missing title on: ${id}`);
  if (!doc.category || !VALID_CATEGORIES.has(doc.category)) {
    throw new Error(`[seedRoles] Invalid category "${doc.category}" on: ${id}`);
  }
  if (!Array.isArray(doc.aliases))        throw new Error(`[seedRoles] aliases must be array on: ${id}`);
  if (!Array.isArray(doc.skillTags))      throw new Error(`[seedRoles] skillTags must be array on: ${id}`);
  if (!Array.isArray(doc.careerPathNext)) throw new Error(`[seedRoles] careerPathNext must be array on: ${id}`);
  if (typeof doc.active !== 'boolean')    throw new Error(`[seedRoles] active must be boolean on: ${id}`);
}

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  const col   = db.collection('roles');
  let   count = 0;

  for (const { id, doc } of ROLES) {
    await col.doc(id).set(
      {
        ...doc,
        roleId:    id,    // denormalise ID onto document for convenience
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    count++;
    process.stdout.write(`  ✓ ${id}\n`);
  }

  console.log(`\n[seedRoles] Seeded ${count} role(s) into roles/.`);
}

seed().catch((err) => {
  console.error('[seedRoles] Fatal error:', err);
  process.exit(1);
});