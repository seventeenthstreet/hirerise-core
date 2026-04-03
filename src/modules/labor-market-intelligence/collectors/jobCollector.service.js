'use strict';

/**
 * src/modules/labor-market-intelligence/collectors/jobCollector.service.js
 *
 * Ingests job posting data into Supabase.
 *
 * Current mode: MOCK — generates realistic synthetic postings.
 *
 * Real integrations can replace the source adapters below:
 *   - collectFromLinkedIn()
 *   - collectFromIndeed()
 *   - collectFromNaukri()
 *
 * Scheduled by:
 *   automation/lmi.scheduler.js
 *
 * Called by:
 *   market.controller.js
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const {
  COLLECTIONS,
  buildJobDoc
} = require('../models/jobMarket.model');

const INSERT_CHUNK_SIZE = 400;
const DEFAULT_BATCH_SIZE = 50;
const MAX_POST_AGE_DAYS = 30;
const SALARY_ROUNDING = 50000;

// ───────────────────────────────────────────────────────────────────────────────
// Static Mock Dataset
// ───────────────────────────────────────────────────────────────────────────────

const JOB_TEMPLATES = Object.freeze([
  {
    job_title: 'Software Engineer',
    industry: 'Technology',
    salary_min: 600000,
    salary_max: 1200000,
    skills: ['Python', 'JavaScript', 'Node.js', 'SQL', 'Git'],
    location: 'Bengaluru'
  },
  {
    job_title: 'Senior Software Engineer',
    industry: 'Technology',
    salary_min: 1200000,
    salary_max: 2400000,
    skills: ['Python', 'React', 'AWS', 'System Design', 'Microservices'],
    location: 'Bengaluru'
  },
  {
    job_title: 'AI / ML Engineer',
    industry: 'Technology',
    salary_min: 900000,
    salary_max: 2000000,
    skills: ['Python', 'TensorFlow', 'PyTorch', 'Machine Learning', 'NLP'],
    location: 'Hyderabad'
  },
  {
    job_title: 'Data Scientist',
    industry: 'Technology',
    salary_min: 800000,
    salary_max: 1800000,
    skills: ['Python', 'R', 'SQL', 'Machine Learning', 'Statistics'],
    location: 'Bengaluru'
  },
  {
    job_title: 'Data Engineer',
    industry: 'Technology',
    salary_min: 700000,
    salary_max: 1500000,
    skills: ['Python', 'Spark', 'Kafka', 'SQL', 'AWS'],
    location: 'Pune'
  },
  {
    job_title: 'Cybersecurity Analyst',
    industry: 'Technology',
    salary_min: 700000,
    salary_max: 1400000,
    skills: ['Network Security', 'Ethical Hacking', 'Python', 'SIEM', 'ISO 27001'],
    location: 'Delhi'
  },
  {
    job_title: 'DevOps Engineer',
    industry: 'Technology',
    salary_min: 800000,
    salary_max: 1600000,
    skills: ['Docker', 'Kubernetes', 'AWS', 'CI/CD', 'Terraform'],
    location: 'Bengaluru'
  },
  {
    job_title: 'Cloud Architect',
    industry: 'Technology',
    salary_min: 1500000,
    salary_max: 3000000,
    skills: ['AWS', 'Azure', 'GCP', 'Microservices', 'Security'],
    location: 'Bengaluru'
  },
  {
    job_title: 'Product Manager',
    industry: 'Technology',
    salary_min: 1200000,
    salary_max: 2500000,
    skills: ['Product Roadmap', 'Agile', 'SQL', 'Communication', 'Analytics'],
    location: 'Mumbai'
  },
  {
    job_title: 'UX Designer',
    industry: 'Technology',
    salary_min: 600000,
    salary_max: 1400000,
    skills: ['Figma', 'User Research', 'Prototyping', 'CSS', 'Communication'],
    location: 'Bengaluru'
  },
  {
    job_title: 'Investment Banker',
    industry: 'Finance',
    salary_min: 900000,
    salary_max: 2500000,
    skills: ['Financial Modeling', 'Excel', 'Valuation', 'Communication', 'CFA'],
    location: 'Mumbai'
  },
  {
    job_title: 'Chartered Accountant',
    industry: 'Finance',
    salary_min: 700000,
    salary_max: 1600000,
    skills: ['Accounting', 'Taxation', 'Tally', 'GST', 'Audit'],
    location: 'Mumbai'
  },
  {
    job_title: 'Financial Analyst',
    industry: 'Finance',
    salary_min: 600000,
    salary_max: 1200000,
    skills: ['Excel', 'Financial Modeling', 'SQL', 'Python', 'Valuation'],
    location: 'Mumbai'
  },
  {
    job_title: 'Marketing Manager',
    industry: 'Marketing',
    salary_min: 700000,
    salary_max: 1500000,
    skills: ['Digital Marketing', 'SEO', 'Google Analytics', 'Content', 'CRM'],
    location: 'Delhi'
  },
  {
    job_title: 'Business Analyst',
    industry: 'Consulting',
    salary_min: 650000,
    salary_max: 1300000,
    skills: ['SQL', 'Excel', 'Communication', 'Tableau', 'Business Analysis'],
    location: 'Bengaluru'
  },
  {
    job_title: 'Medical Officer',
    industry: 'Healthcare',
    salary_min: 700000,
    salary_max: 1500000,
    skills: ['Clinical Diagnosis', 'Patient Care', 'Medical Research', 'EMR'],
    location: 'Delhi'
  },
  {
    job_title: 'Biomedical Engineer',
    industry: 'Healthcare',
    salary_min: 500000,
    salary_max: 1000000,
    skills: ['Biomedical Devices', 'MATLAB', 'Research', 'Data Analysis'],
    location: 'Hyderabad'
  },
  {
    job_title: 'Clinical Research Assoc.',
    industry: 'Pharma',
    salary_min: 450000,
    salary_max: 900000,
    skills: ['Clinical Trials', 'GCP', 'Medical Writing', 'Statistics'],
    location: 'Mumbai'
  },
  {
    job_title: 'Corporate Lawyer',
    industry: 'Legal',
    salary_min: 700000,
    salary_max: 2000000,
    skills: ['Contract Law', 'Corporate Law', 'Legal Research', 'Communication'],
    location: 'Mumbai'
  },
  {
    job_title: 'Content Strategist',
    industry: 'Media',
    salary_min: 400000,
    salary_max: 900000,
    skills: ['Content Writing', 'SEO', 'Social Media', 'Analytics'],
    location: 'Bengaluru'
  }
]);

const COMPANIES = Object.freeze([
  'Infosys',
  'TCS',
  'Wipro',
  'HCLTech',
  'Tech Mahindra',
  'Amazon',
  'Google',
  'Microsoft',
  'Flipkart',
  'Swiggy',
  'Zomato',
  'HDFC Bank',
  'ICICI Bank',
  'Paytm',
  'Razorpay',
  "Byju's",
  'Unacademy',
  'PhonePe',
  'Ola',
  'Nykaa'
]);

const SOURCES = Object.freeze(['linkedin', 'indeed', 'naukri', 'mock']);

// ───────────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────────

async function collect({
  batchSize = DEFAULT_BATCH_SIZE,
  source = 'mock'
} = {}) {
  const runId = `run_${Date.now()}`;
  const startedAt = Date.now();

  logger.info(
    { runId, batchSize, source },
    '[JobCollector] Collection started'
  );

  try {
    const safeBatchSize = normalizeBatchSize(batchSize);
    const safeSource = normalizeSource(source);
    const generatedAt = new Date().toISOString();

    const jobs = generateMockJobs(safeBatchSize, safeSource);

    const written = await insertJobsInChunks(jobs, generatedAt);

    await logIngestionRun({
      runId,
      source: safeSource,
      jobsWritten: written,
      durationMs: Date.now() - startedAt,
      status: 'success',
      createdAt: generatedAt
    });

    logger.info(
      { runId, written, durationMs: Date.now() - startedAt },
      '[JobCollector] Collection complete'
    );

    return { runId, written };
  } catch (error) {
    await safeLogFailure({
      runId,
      source,
      error
    });

    logger.error(
      {
        runId,
        error: error.message,
        stack: error.stack
      },
      '[JobCollector] Collection failed'
    );

    throw error;
  }
}

async function collectFromLinkedIn() {
  logger.warn(
    '[JobCollector] LinkedIn integration not implemented — using mock source'
  );
  return collect({ source: 'linkedin' });
}

async function collectFromIndeed() {
  logger.warn(
    '[JobCollector] Indeed integration not implemented — using mock source'
  );
  return collect({ source: 'indeed' });
}

async function collectFromNaukri() {
  logger.warn(
    '[JobCollector] Naukri integration not implemented — using mock source'
  );
  return collect({ source: 'naukri' });
}

// ───────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ───────────────────────────────────────────────────────────────────────────────

async function insertJobsInChunks(jobs, createdAt) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return 0;
  }

  let written = 0;

  for (let i = 0; i < jobs.length; i += INSERT_CHUNK_SIZE) {
    const chunk = jobs.slice(i, i + INSERT_CHUNK_SIZE);

    const rows = chunk.map((job) => ({
      ...buildJobDoc(job),
      created_at: createdAt
    }));

    const { error } = await supabase
      .from(COLLECTIONS.JOB_MARKET)
      .insert(rows);

    if (error) {
      throw new Error(
        `[JobCollector] Failed inserting chunk ${i}-${i + chunk.length}: ${error.message}`
      );
    }

    written += rows.length;
  }

  return written;
}

async function logIngestionRun({
  runId,
  source,
  jobsWritten = 0,
  durationMs = 0,
  status,
  createdAt,
  errorMessage = null
}) {
  const payload = {
    id: runId,
    run_id: runId,
    source,
    jobs_written: jobsWritten,
    duration_ms: durationMs,
    status,
    error: errorMessage,
    created_at: createdAt
  };

  const { error } = await supabase
    .from(COLLECTIONS.INGESTION_RUNS)
    .upsert(payload);

  if (error) {
    throw new Error(
      `[JobCollector] Failed logging ingestion run: ${error.message}`
    );
  }
}

async function safeLogFailure({ runId, source, error }) {
  try {
    await logIngestionRun({
      runId,
      source: normalizeSource(source),
      status: 'error',
      errorMessage: error?.message || 'Unknown collection failure',
      createdAt: new Date().toISOString()
    });
  } catch (logError) {
    logger.error(
      {
        runId,
        error: logError.message
      },
      '[JobCollector] Failed to log failed ingestion run'
    );
  }
}

function generateMockJobs(count, source) {
  const jobs = [];
  const today = new Date();

  for (let i = 0; i < count; i++) {
    const template = JOB_TEMPLATES[i % JOB_TEMPLATES.length];
    if (!template) continue;

    const company = pickRandom(COMPANIES);
    const variance = 0.9 + Math.random() * 0.2;

    const salaryMin = roundSalary(template.salary_min * variance);
    const salaryMax = roundSalary(template.salary_max * variance);

    const postDate = new Date(today);
    postDate.setDate(postDate.getDate() - randomInt(MAX_POST_AGE_DAYS));

    jobs.push({
      job_title: template.job_title,
      company,
      location: template.location,
      salary_min: salaryMin,
      salary_max: Math.max(salaryMax, salaryMin),
      skills: Array.isArray(template.skills) ? [...template.skills] : [],
      industry: template.industry,
      source: source || pickRandom(SOURCES),
      posting_date: postDate.toISOString().slice(0, 10)
    });
  }

  return jobs;
}

function normalizeBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.floor(parsed);
}

function normalizeSource(source) {
  return typeof source === 'string' && source.trim()
    ? source.trim().toLowerCase()
    : 'mock';
}

function roundSalary(value) {
  return Math.round(value / SALARY_ROUNDING) * SALARY_ROUNDING;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function pickRandom(arr) {
  return arr[randomInt(arr.length)];
}

module.exports = {
  collect,
  collectFromLinkedIn,
  collectFromIndeed,
  collectFromNaukri,
  JOB_TEMPLATES
};