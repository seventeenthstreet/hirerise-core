'use strict';

/**
 * collectors/jobCollector.service.js
 *
 * Production-ready Supabase ingestion service for synthetic LMI job market data.
 *
 * Responsibilities:
 * - Generate realistic mock job postings
 * - Insert rows into lmi_job_market_data
 * - Record ingestion telemetry
 * - Provide future-ready adapters for real providers
 */

const { randomUUID } = require('crypto');
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const {
  COLLECTIONS,
  buildJobDoc
} = require('../models/jobMarket.model');

const INSERT_CHUNK_SIZE = 400;
const DEFAULT_BATCH_SIZE = 50;
const MAX_POST_AGE_DAYS = 30;

const SOURCES = Object.freeze(['linkedin', 'indeed', 'naukri', 'mock']);

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

const JOB_TEMPLATES = [
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
  }
];

function getRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function roundSalary(value) {
  return Math.round(value / 50000) * 50000;
}

function buildRunId() {
  return randomUUID();
}

function normalizeSource(source) {
  return SOURCES.includes(source) ? source : 'mock';
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function writeIngestionRun(payload) {
  const { error } = await supabase
    .from(COLLECTIONS.INGESTION_RUNS)
    .upsert(payload, {
      onConflict: 'run_id'
    });

  if (error) {
    logger.error(
      { payload, error: error.message },
      '[JobCollector] Failed to write ingestion run'
    );
    throw error;
  }
}

async function insertJobBatch(rows) {
  const { error } = await supabase
    .from(COLLECTIONS.JOB_MARKET)
    .insert(rows);

  if (error) {
    logger.error(
      { error: error.message, rowCount: rows.length },
      '[JobCollector] Batch insert failed'
    );
    throw error;
  }
}

async function collect(options = {}) {
  const batchSize = Number.isInteger(options.batchSize)
    ? options.batchSize
    : DEFAULT_BATCH_SIZE;

  const source = normalizeSource(options.source || 'mock');
  const runId = buildRunId();
  const startMs = Date.now();

  logger.info(
    { runId, batchSize, source },
    '[JobCollector] Collection started'
  );

  try {
    const jobs = generateMockJobs(batchSize, source);
    const chunks = chunkArray(jobs, INSERT_CHUNK_SIZE);

    let written = 0;

    for (const chunk of chunks) {
      const rows = chunk.map((job) => buildJobDoc(job));
      await insertJobBatch(rows);
      written += rows.length;
    }

    const durationMs = Date.now() - startMs;

    await writeIngestionRun({
      run_id: runId,
      source,
      jobs_written: written,
      duration_ms: durationMs,
      status: 'success'
    });

    logger.info(
      { runId, written, durationMs },
      '[JobCollector] Collection completed'
    );

    return {
      runId,
      written,
      durationMs
    };
  } catch (error) {
    const durationMs = Date.now() - startMs;

    try {
      await writeIngestionRun({
        run_id: runId,
        source,
        jobs_written: 0,
        duration_ms: durationMs,
        status: 'error',
        error: error.message
      });
    } catch (runError) {
      logger.error(
        { runId, error: runError.message },
        '[JobCollector] Failed to persist failed telemetry'
      );
    }

    logger.error(
      {
        runId,
        source,
        error: error.message
      },
      '[JobCollector] Collection failed'
    );

    throw error;
  }
}

function generateMockJobs(count, source) {
  const jobs = [];
  const today = new Date();

  for (let i = 0; i < count; i++) {
    const template = JOB_TEMPLATES[i % JOB_TEMPLATES.length];
    const variance = 0.9 + Math.random() * 0.2;

    const salaryMin = roundSalary(template.salary_min * variance);
    const salaryMax = roundSalary(template.salary_max * variance);

    const daysAgo = Math.floor(Math.random() * MAX_POST_AGE_DAYS);
    const postingDate = new Date(today);
    postingDate.setDate(postingDate.getDate() - daysAgo);

    jobs.push({
      job_title: template.job_title,
      company: getRandomItem(COMPANIES),
      location: template.location,
      salary_min: salaryMin,
      salary_max: salaryMax,
      skills: [...template.skills],
      industry: template.industry,
      source,
      posting_date: postingDate.toISOString().slice(0, 10)
    });
  }

  return jobs;
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

module.exports = {
  collect,
  collectFromLinkedIn,
  collectFromIndeed,
  collectFromNaukri,
  generateMockJobs,
  JOB_TEMPLATES
};