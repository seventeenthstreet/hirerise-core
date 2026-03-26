'use strict';

/**
 * collectors/jobCollector.service.js
 *
 * Ingests job posting data into lmi_job_market_data.
 *
 * Current mode: MOCK — generates realistic synthetic postings.
 *
 * Real integrations (plug in later by replacing the source functions below):
 *   collectFromLinkedIn()  — LinkedIn Jobs API
 *   collectFromIndeed()    — Indeed Publisher API
 *   collectFromNaukri()    — Naukri API
 *
 * Scheduled by:  automation/lmi.scheduler.js  (every 12 hours)
 * Called by:     market.controller.js          (POST /api/v1/market/ingest)
 */

const { db }        = require('../../../config/supabase');
const { FieldValue } = require('../../../config/supabase');
const logger        = require('../../../utils/logger');
const { COLLECTIONS, buildJobDoc } = require('../models/jobMarket.model');

// ─── Mock job dataset ─────────────────────────────────────────────────────────
// Realistic Indian tech job market data.
// Each entry is a template; the collector generates slight variations per run.

const JOB_TEMPLATES = [
  // ── Engineering / Tech ───────────────────────────────────────────────────
  { job_title: 'Software Engineer',         industry: 'Technology',    salary_min: 600000,  salary_max: 1200000, skills: ['Python', 'JavaScript', 'Node.js', 'SQL', 'Git'],              location: 'Bengaluru' },
  { job_title: 'Senior Software Engineer',  industry: 'Technology',    salary_min: 1200000, salary_max: 2400000, skills: ['Python', 'React', 'AWS', 'System Design', 'Microservices'],    location: 'Bengaluru' },
  { job_title: 'AI / ML Engineer',          industry: 'Technology',    salary_min: 900000,  salary_max: 2000000, skills: ['Python', 'TensorFlow', 'PyTorch', 'Machine Learning', 'NLP'], location: 'Hyderabad' },
  { job_title: 'Data Scientist',            industry: 'Technology',    salary_min: 800000,  salary_max: 1800000, skills: ['Python', 'R', 'SQL', 'Machine Learning', 'Statistics'],        location: 'Bengaluru' },
  { job_title: 'Data Engineer',             industry: 'Technology',    salary_min: 700000,  salary_max: 1500000, skills: ['Python', 'Spark', 'Kafka', 'SQL', 'AWS'],                       location: 'Pune' },
  { job_title: 'Cybersecurity Analyst',     industry: 'Technology',    salary_min: 700000,  salary_max: 1400000, skills: ['Network Security', 'Ethical Hacking', 'Python', 'SIEM', 'ISO 27001'], location: 'Delhi' },
  { job_title: 'DevOps Engineer',           industry: 'Technology',    salary_min: 800000,  salary_max: 1600000, skills: ['Docker', 'Kubernetes', 'AWS', 'CI/CD', 'Terraform'],            location: 'Bengaluru' },
  { job_title: 'Cloud Architect',           industry: 'Technology',    salary_min: 1500000, salary_max: 3000000, skills: ['AWS', 'Azure', 'GCP', 'Microservices', 'Security'],             location: 'Bengaluru' },
  { job_title: 'Product Manager',           industry: 'Technology',    salary_min: 1200000, salary_max: 2500000, skills: ['Product Roadmap', 'Agile', 'SQL', 'Communication', 'Analytics'], location: 'Mumbai' },
  { job_title: 'UX Designer',              industry: 'Technology',    salary_min: 600000,  salary_max: 1400000, skills: ['Figma', 'User Research', 'Prototyping', 'CSS', 'Communication'], location: 'Bengaluru' },

  // ── Finance / Commerce ───────────────────────────────────────────────────
  { job_title: 'Investment Banker',         industry: 'Finance',       salary_min: 900000,  salary_max: 2500000, skills: ['Financial Modeling', 'Excel', 'Valuation', 'Communication', 'CFA'], location: 'Mumbai' },
  { job_title: 'Chartered Accountant',      industry: 'Finance',       salary_min: 700000,  salary_max: 1600000, skills: ['Accounting', 'Taxation', 'Tally', 'GST', 'Audit'],             location: 'Mumbai' },
  { job_title: 'Financial Analyst',         industry: 'Finance',       salary_min: 600000,  salary_max: 1200000, skills: ['Excel', 'Financial Modeling', 'SQL', 'Python', 'Valuation'],    location: 'Mumbai' },
  { job_title: 'Marketing Manager',         industry: 'Marketing',     salary_min: 700000,  salary_max: 1500000, skills: ['Digital Marketing', 'SEO', 'Google Analytics', 'Content', 'CRM'], location: 'Delhi' },
  { job_title: 'Business Analyst',          industry: 'Consulting',    salary_min: 650000,  salary_max: 1300000, skills: ['SQL', 'Excel', 'Communication', 'Tableau', 'Business Analysis'], location: 'Bengaluru' },

  // ── Medical / Science ────────────────────────────────────────────────────
  { job_title: 'Medical Officer',           industry: 'Healthcare',    salary_min: 700000,  salary_max: 1500000, skills: ['Clinical Diagnosis', 'Patient Care', 'Medical Research', 'EMR'], location: 'Delhi' },
  { job_title: 'Biomedical Engineer',       industry: 'Healthcare',    salary_min: 500000,  salary_max: 1000000, skills: ['Biomedical Devices', 'MATLAB', 'Research', 'Data Analysis'],    location: 'Hyderabad' },
  { job_title: 'Clinical Research Assoc.', industry: 'Pharma',        salary_min: 450000,  salary_max: 900000,  skills: ['Clinical Trials', 'GCP', 'Medical Writing', 'Statistics'],       location: 'Mumbai' },

  // ── Humanities / Law ─────────────────────────────────────────────────────
  { job_title: 'Corporate Lawyer',          industry: 'Legal',         salary_min: 700000,  salary_max: 2000000, skills: ['Contract Law', 'Corporate Law', 'Legal Research', 'Communication'], location: 'Mumbai' },
  { job_title: 'Content Strategist',        industry: 'Media',         salary_min: 400000,  salary_max: 900000,  skills: ['Content Writing', 'SEO', 'Social Media', 'Analytics'],           location: 'Bengaluru' },
];

const COMPANIES = [
  'Infosys', 'TCS', 'Wipro', 'HCLTech', 'Tech Mahindra',
  'Amazon', 'Google', 'Microsoft', 'Flipkart', 'Swiggy',
  'Zomato', 'HDFC Bank', 'ICICI Bank', 'Paytm', 'Razorpay',
  'Byju\'s', 'Unacademy', 'PhonePe', 'Ola', 'Nykaa',
];

const SOURCES = ['linkedin', 'indeed', 'naukri', 'mock'];

// ─── Collect ──────────────────────────────────────────────────────────────────

/**
 * Main entry. Runs mock collection + writes to Firestore.
 * @param {object} options
 * @param {number} options.batchSize — number of jobs to generate per run (default 50)
 * @param {string} options.source    — source label (default 'mock')
 */
async function collect({ batchSize = 50, source = 'mock' } = {}) {
  const runId    = `run_${Date.now()}`;
  const startMs  = Date.now();
  logger.info({ runId, batchSize, source }, '[JobCollector] Collection started');

  try {
    const jobs = _generateMockJobs(batchSize, source);

    // Write in batches of 500 (Firestore limit)
    let written = 0;
    for (let i = 0; i < jobs.length; i += 400) {
      const chunk = jobs.slice(i, i + 400);
      const batch = db.batch();
      for (const job of chunk) {
        const ref = db.collection(COLLECTIONS.JOB_MARKET).doc();
        batch.set(ref, { ...buildJobDoc(job), created_at: FieldValue.serverTimestamp() });
      }
      await batch.commit();
      written += chunk.length;
    }

    // Log ingestion run
    await db.collection(COLLECTIONS.INGESTION_RUNS).doc(runId).set({
      run_id:     runId,
      source,
      jobs_written: written,
      duration_ms:  Date.now() - startMs,
      status:     'success',
      created_at: FieldValue.serverTimestamp(),
    });

    logger.info({ runId, written }, '[JobCollector] Collection complete');
    return { runId, written };

  } catch (err) {
    await db.collection(COLLECTIONS.INGESTION_RUNS).doc(runId).set({
      run_id:   runId,
      source,
      status:   'error',
      error:    err.message,
      created_at: FieldValue.serverTimestamp(),
    }).catch(() => {});
    logger.error({ runId, err: err.message }, '[JobCollector] Collection failed');
    throw err;
  }
}

// ─── Mock generation ──────────────────────────────────────────────────────────

function _generateMockJobs(count, source) {
  const jobs = [];
  const today = new Date();

  for (let i = 0; i < count; i++) {
    const template = JOB_TEMPLATES[i % JOB_TEMPLATES.length];
    const company  = COMPANIES[Math.floor(Math.random() * COMPANIES.length)];

    // Vary salary slightly per posting (±10%)
    const variance  = 0.9 + Math.random() * 0.2;
    const salaryMin = Math.round(template.salary_min * variance / 50000) * 50000;
    const salaryMax = Math.round(template.salary_max * variance / 50000) * 50000;

    // Randomise posting date within last 30 days
    const daysAgo = Math.floor(Math.random() * 30);
    const postDate = new Date(today);
    postDate.setDate(postDate.getDate() - daysAgo);

    jobs.push({
      job_title:    template.job_title,
      company,
      location:     template.location,
      salary_min:   salaryMin,
      salary_max:   salaryMax,
      skills:       [...template.skills],
      industry:     template.industry,
      source:       source || SOURCES[Math.floor(Math.random() * SOURCES.length)],
      posting_date: postDate.toISOString().slice(0, 10),
    });
  }
  return jobs;
}

// ─── Stub real collectors (wire up later) ─────────────────────────────────────

async function collectFromLinkedIn() {
  // TODO: LinkedIn Jobs API integration
  logger.warn('[JobCollector] LinkedIn integration not yet implemented — using mock');
  return collect({ source: 'linkedin' });
}

async function collectFromIndeed() {
  // TODO: Indeed Publisher API integration
  logger.warn('[JobCollector] Indeed integration not yet implemented — using mock');
  return collect({ source: 'indeed' });
}

async function collectFromNaukri() {
  // TODO: Naukri API integration
  logger.warn('[JobCollector] Naukri integration not yet implemented — using mock');
  return collect({ source: 'naukri' });
}

module.exports = { collect, collectFromLinkedIn, collectFromIndeed, collectFromNaukri, JOB_TEMPLATES };










