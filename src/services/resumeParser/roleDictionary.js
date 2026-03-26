'use strict';

/**
 * roleDictionary.js
 *
 * Maps resume text patterns → canonical job roles.
 * Each entry has a canonical role title and an array of keyword patterns
 * (all lowercased) that should trigger detection.
 *
 * Detection strategy:
 *   - Score each role by how many of its keywords appear in the resume text.
 *   - Return top N roles sorted by score descending.
 *   - Require score >= 1 to include a role.
 */

const ROLE_ENTRIES = [
  // ── Engineering ───────────────────────────────────────────────────────────
  {
    canonical: 'Software Engineer',
    keywords:  ['software engineer', 'software developer', 'swe', 'software development', 'backend developer', 'backend engineer'],
    category:  'Engineering',
  },
  {
    canonical: 'Frontend Developer',
    keywords:  ['frontend developer', 'front-end developer', 'frontend engineer', 'front end developer', 'ui developer'],
    category:  'Engineering',
  },
  {
    canonical: 'Full Stack Developer',
    keywords:  ['full stack', 'fullstack', 'full-stack developer', 'full stack developer', 'full stack engineer'],
    category:  'Engineering',
  },
  {
    canonical: 'Mobile Developer',
    keywords:  ['mobile developer', 'ios developer', 'android developer', 'react native developer', 'flutter developer'],
    category:  'Engineering',
  },
  {
    canonical: 'DevOps Engineer',
    keywords:  ['devops', 'devops engineer', 'site reliability', 'sre', 'platform engineer', 'infrastructure engineer'],
    category:  'Engineering',
  },
  {
    canonical: 'Cloud Architect',
    keywords:  ['cloud architect', 'cloud engineer', 'solutions architect', 'aws architect', 'azure architect'],
    category:  'Engineering',
  },
  {
    canonical: 'Data Engineer',
    keywords:  ['data engineer', 'data pipeline', 'etl developer', 'data platform', 'analytics engineer'],
    category:  'Data',
  },
  {
    canonical: 'Data Scientist',
    keywords:  ['data scientist', 'data science', 'machine learning engineer', 'ml engineer', 'ai engineer'],
    category:  'Data',
  },
  {
    canonical: 'Data Analyst',
    keywords:  ['data analyst', 'business analyst', 'reporting analyst', 'bi analyst', 'analytics analyst'],
    category:  'Data',
  },
  {
    canonical: 'Security Engineer',
    keywords:  ['security engineer', 'cybersecurity engineer', 'information security', 'security analyst', 'penetration tester', 'ethical hacker'],
    category:  'Engineering',
  },
  {
    canonical: 'QA Engineer',
    keywords:  ['qa engineer', 'quality assurance engineer', 'test engineer', 'sdet', 'automation engineer', 'testing engineer'],
    category:  'Engineering',
  },
  {
    canonical: 'Embedded Engineer',
    keywords:  ['embedded engineer', 'embedded systems engineer', 'firmware engineer', 'embedded software'],
    category:  'Engineering',
  },
  {
    canonical: 'Mechanical Engineer',
    keywords:  ['mechanical engineer', 'mechanical design engineer', 'design engineer'],
    category:  'Engineering',
  },
  {
    canonical: 'Civil Engineer',
    keywords:  ['civil engineer', 'structural engineer', 'site engineer'],
    category:  'Engineering',
  },
  {
    canonical: 'Electrical Engineer',
    keywords:  ['electrical engineer', 'power engineer', 'control systems engineer'],
    category:  'Engineering',
  },

  // ── Product & Management ──────────────────────────────────────────────────
  {
    canonical: 'Product Manager',
    keywords:  ['product manager', 'pm', 'product management', 'senior product manager', 'product owner'],
    category:  'Management',
  },
  {
    canonical: 'Project Manager',
    keywords:  ['project manager', 'program manager', 'delivery manager', 'scrum master', 'pmo', 'it project manager'],
    category:  'Management',
  },
  {
    canonical: 'Engineering Manager',
    keywords:  ['engineering manager', 'development manager', 'tech lead', 'technical lead', 'team lead'],
    category:  'Management',
  },
  {
    canonical: 'CTO',
    keywords:  ['chief technology officer', 'cto', 'vp engineering', 'vp of engineering'],
    category:  'Management',
  },
  {
    canonical: 'Operations Manager',
    keywords:  ['operations manager', 'operations director', 'head of operations', 'ops manager'],
    category:  'Management',
  },

  // ── Finance & Accounting ──────────────────────────────────────────────────
  {
    canonical: 'Accountant',
    keywords:  ['accountant', 'accounts executive', 'accounts manager', 'chartered accountant', 'ca', 'cost accountant', 'junior accountant', 'senior accountant'],
    category:  'Finance',
  },
  {
    canonical: 'Financial Analyst',
    keywords:  ['financial analyst', 'finance analyst', 'investment analyst', 'equity analyst', 'fp&a analyst', 'fp&a manager'],
    category:  'Finance',
  },
  {
    canonical: 'Finance Manager',
    keywords:  ['finance manager', 'head of finance', 'vp finance', 'cfo', 'chief financial officer', 'director of finance'],
    category:  'Finance',
  },
  {
    canonical: 'Auditor',
    keywords:  ['auditor', 'internal auditor', 'external auditor', 'statutory auditor', 'audit manager'],
    category:  'Finance',
  },
  {
    canonical: 'Tax Consultant',
    keywords:  ['tax consultant', 'tax analyst', 'tax manager', 'taxation specialist', 'indirect tax'],
    category:  'Finance',
  },
  {
    canonical: 'Banking Professional',
    keywords:  ['banker', 'relationship manager', 'credit analyst', 'branch manager', 'loan officer', 'risk analyst'],
    category:  'Finance',
  },
  {
    canonical: 'Investment Banker',
    keywords:  ['investment banker', 'investment banking analyst', 'm&a analyst', 'deal analyst'],
    category:  'Finance',
  },

  // ── Marketing ─────────────────────────────────────────────────────────────
  {
    canonical: 'Marketing Manager',
    keywords:  ['marketing manager', 'head of marketing', 'marketing director', 'marketing lead', 'growth manager'],
    category:  'Marketing',
  },
  {
    canonical: 'Digital Marketing Specialist',
    keywords:  ['digital marketer', 'digital marketing specialist', 'digital marketing executive', 'performance marketer'],
    category:  'Marketing',
  },
  {
    canonical: 'Content Writer',
    keywords:  ['content writer', 'content creator', 'copywriter', 'technical writer', 'content strategist', 'blog writer'],
    category:  'Marketing',
  },
  {
    canonical: 'SEO Specialist',
    keywords:  ['seo specialist', 'seo manager', 'seo analyst', 'search engine optimization specialist'],
    category:  'Marketing',
  },
  {
    canonical: 'Social Media Manager',
    keywords:  ['social media manager', 'social media specialist', 'community manager', 'social media executive'],
    category:  'Marketing',
  },
  {
    canonical: 'Brand Manager',
    keywords:  ['brand manager', 'brand strategist', 'brand executive'],
    category:  'Marketing',
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    canonical: 'Sales Executive',
    keywords:  ['sales executive', 'sales representative', 'account executive', 'sales associate', 'territory manager'],
    category:  'Sales',
  },
  {
    canonical: 'Sales Manager',
    keywords:  ['sales manager', 'regional sales manager', 'national sales manager', 'vp sales', 'head of sales'],
    category:  'Sales',
  },
  {
    canonical: 'Business Development Manager',
    keywords:  ['business development manager', 'bdm', 'business development executive', 'bde'],
    category:  'Sales',
  },
  {
    canonical: 'Key Account Manager',
    keywords:  ['key account manager', 'kam', 'account manager', 'client success manager', 'customer success manager'],
    category:  'Sales',
  },

  // ── HR ────────────────────────────────────────────────────────────────────
  {
    canonical: 'HR Manager',
    keywords:  ['hr manager', 'human resources manager', 'hr business partner', 'hrbp', 'people manager', 'hr director'],
    category:  'HR',
  },
  {
    canonical: 'Recruiter',
    keywords:  ['recruiter', 'talent acquisition specialist', 'talent acquisition manager', 'hr recruiter', 'technical recruiter'],
    category:  'HR',
  },
  {
    canonical: 'HR Executive',
    keywords:  ['hr executive', 'hr associate', 'hr generalist', 'hr coordinator'],
    category:  'HR',
  },

  // ── Design ────────────────────────────────────────────────────────────────
  {
    canonical: 'Graphic Designer',
    keywords:  ['graphic designer', 'visual designer', 'graphic artist', 'art director'],
    category:  'Design',
  },
  {
    canonical: 'UI/UX Designer',
    keywords:  ['ui/ux designer', 'ux designer', 'ui designer', 'product designer', 'interaction designer', 'user experience designer'],
    category:  'Design',
  },
  {
    canonical: 'Motion Designer',
    keywords:  ['motion designer', 'motion graphics', 'video editor', 'video producer'],
    category:  'Design',
  },

  // ── Healthcare ────────────────────────────────────────────────────────────
  {
    canonical: 'Doctor',
    keywords:  ['doctor', 'physician', 'mbbs', 'medical officer', 'general practitioner'],
    category:  'Healthcare',
  },
  {
    canonical: 'Nurse',
    keywords:  ['nurse', 'registered nurse', 'clinical nurse', 'nursing officer'],
    category:  'Healthcare',
  },
  {
    canonical: 'Pharmacist',
    keywords:  ['pharmacist', 'clinical pharmacist'],
    category:  'Healthcare',
  },
  {
    canonical: 'Healthcare Administrator',
    keywords:  ['healthcare administrator', 'hospital administrator', 'medical administrator'],
    category:  'Healthcare',
  },
  {
    canonical: 'Clinical Research Associate',
    keywords:  ['clinical research associate', 'cra', 'clinical research coordinator', 'clinical trial'],
    category:  'Healthcare',
  },

  // ── Legal ─────────────────────────────────────────────────────────────────
  {
    canonical: 'Lawyer',
    keywords:  ['lawyer', 'advocate', 'attorney', 'legal counsel', 'solicitor', 'corporate lawyer'],
    category:  'Legal',
  },
  {
    canonical: 'Legal Analyst',
    keywords:  ['legal analyst', 'legal associate', 'paralegal', 'legal executive'],
    category:  'Legal',
  },
  {
    canonical: 'Compliance Officer',
    keywords:  ['compliance officer', 'compliance manager', 'regulatory affairs', 'legal compliance'],
    category:  'Legal',
  },

  // ── Education ─────────────────────────────────────────────────────────────
  {
    canonical: 'Teacher',
    keywords:  ['teacher', 'lecturer', 'professor', 'instructor', 'faculty', 'educator', 'tutor'],
    category:  'Education',
  },
  {
    canonical: 'Trainer',
    keywords:  ['trainer', 'corporate trainer', 'training specialist', 'facilitator', 'learning specialist'],
    category:  'Education',
  },
];

module.exports = { ROLE_ENTRIES };









