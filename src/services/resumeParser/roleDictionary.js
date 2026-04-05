'use strict';

/**
 * services/resumeParser/roleDictionary.js
 *
 * Canonical role taxonomy used by the deterministic resume parser.
 *
 * This module is intentionally:
 * - infrastructure agnostic
 * - immutable
 * - parser hot-path optimized
 * - safe for long-lived Node workers
 */

const ROLE_DICTIONARY_VERSION = '1.1.0';

const RAW_ROLE_ENTRIES = [
  // ── Engineering ───────────────────────────────────────────────────────────
  {
    canonical: 'Software Engineer',
    keywords: [
      'software engineer',
      'software developer',
      'swe',
      'software development',
      'backend developer',
      'backend engineer',
    ],
    category: 'Engineering',
  },
  {
    canonical: 'Frontend Developer',
    keywords: [
      'frontend developer',
      'front-end developer',
      'frontend engineer',
      'front end developer',
      'ui developer',
    ],
    category: 'Engineering',
  },
  {
    canonical: 'Full Stack Developer',
    keywords: [
      'full stack',
      'fullstack',
      'full-stack developer',
      'full stack developer',
      'full stack engineer',
    ],
    category: 'Engineering',
  },
  {
    canonical: 'Mobile Developer',
    keywords: [
      'mobile developer',
      'ios developer',
      'android developer',
      'react native developer',
      'flutter developer',
    ],
    category: 'Engineering',
  },
  {
    canonical: 'DevOps Engineer',
    keywords: [
      'devops',
      'devops engineer',
      'site reliability',
      'sre',
      'platform engineer',
      'infrastructure engineer',
    ],
    category: 'Engineering',
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    canonical: 'Data Engineer',
    keywords: [
      'data engineer',
      'data pipeline',
      'etl developer',
      'analytics engineer',
    ],
    category: 'Data',
  },
  {
    canonical: 'Data Scientist',
    keywords: [
      'data scientist',
      'data science',
      'machine learning engineer',
      'ml engineer',
      'ai engineer',
    ],
    category: 'Data',
  },
  {
    canonical: 'Data Analyst',
    keywords: [
      'data analyst',
      'business analyst',
      'reporting analyst',
      'bi analyst',
    ],
    category: 'Data',
  },

  // ── Finance ───────────────────────────────────────────────────────────────
  {
    canonical: 'Accountant',
    keywords: [
      'accountant',
      'accounts executive',
      'accounts manager',
      'chartered accountant',
      'ca',
    ],
    category: 'Finance',
  },
  {
    canonical: 'Financial Analyst',
    keywords: [
      'financial analyst',
      'finance analyst',
      'investment analyst',
      'equity analyst',
    ],
    category: 'Finance',
  },

  // ── Legal ─────────────────────────────────────────────────────────────────
  {
    canonical: 'Lawyer',
    keywords: [
      'lawyer',
      'advocate',
      'attorney',
      'legal counsel',
      'solicitor',
    ],
    category: 'Legal',
  },

  // ── Education ─────────────────────────────────────────────────────────────
  {
    canonical: 'Teacher',
    keywords: [
      'teacher',
      'lecturer',
      'professor',
      'instructor',
      'faculty',
      'educator',
    ],
    category: 'Education',
  },
];

/**
 * Normalize all keywords once at module load.
 * Guarantees parser assumptions stay valid.
 */
const ROLE_ENTRIES = Object.freeze(
  RAW_ROLE_ENTRIES.map(entry =>
    Object.freeze({
      canonical: entry.canonical,
      category: entry.category,
      keywords: Object.freeze(
        entry.keywords.map(keyword => keyword.toLowerCase().trim())
      ),
    })
  )
);

module.exports = Object.freeze({
  ROLE_ENTRIES,
  ROLE_DICTIONARY_VERSION,
});