'use strict';

/**
 * processors/skillExtraction.service.js
 *
 * Extracts and normalises skills from raw job posting data.
 *
 * Two modes:
 *   extractFromText(text)   — parse a free-text job description
 *   extractFromJobs(jobs)   — aggregate skills across an array of job docs
 *
 * Future integration: replace keyword matching with an LLM call
 * (e.g. Claude claude-haiku) for richer extraction.
 */

// ─── Master skill taxonomy ────────────────────────────────────────────────────
// Flat list of canonical skills with aliases.
// Add new skills here to expand coverage.

const SKILL_TAXONOMY = [
  // ── Programming languages ──────────────────────────────────────────────
  { canonical: 'Python',        aliases: ['python', 'py'] },
  { canonical: 'JavaScript',    aliases: ['javascript', 'js', 'node.js', 'nodejs'] },
  { canonical: 'TypeScript',    aliases: ['typescript', 'ts'] },
  { canonical: 'Java',          aliases: ['java', 'spring boot', 'springboot'] },
  { canonical: 'C++',           aliases: ['c++', 'cpp'] },
  { canonical: 'Go',            aliases: [' go ', 'golang'] },
  { canonical: 'R',             aliases: [' r ', 'r programming'] },
  { canonical: 'SQL',           aliases: ['sql', 'mysql', 'postgresql', 'postgres'] },

  // ── Cloud & DevOps ─────────────────────────────────────────────────────
  { canonical: 'AWS',           aliases: ['aws', 'amazon web services'] },
  { canonical: 'Azure',         aliases: ['azure', 'microsoft azure'] },
  { canonical: 'GCP',           aliases: ['gcp', 'google cloud'] },
  { canonical: 'Docker',        aliases: ['docker', 'containerization'] },
  { canonical: 'Kubernetes',    aliases: ['kubernetes', 'k8s'] },
  { canonical: 'Terraform',     aliases: ['terraform', 'iac'] },
  { canonical: 'CI/CD',         aliases: ['ci/cd', 'cicd', 'jenkins', 'github actions'] },

  // ── AI / ML ────────────────────────────────────────────────────────────
  { canonical: 'Machine Learning', aliases: ['machine learning', 'ml', 'supervised learning'] },
  { canonical: 'Deep Learning',    aliases: ['deep learning', 'dl', 'neural networks'] },
  { canonical: 'TensorFlow',       aliases: ['tensorflow', 'tf'] },
  { canonical: 'PyTorch',          aliases: ['pytorch'] },
  { canonical: 'NLP',              aliases: ['nlp', 'natural language processing', 'llm'] },
  { canonical: 'Computer Vision',  aliases: ['computer vision', 'cv', 'image processing'] },

  // ── Data ───────────────────────────────────────────────────────────────
  { canonical: 'Data Analysis',    aliases: ['data analysis', 'data analytics', 'analytics'] },
  { canonical: 'Statistics',       aliases: ['statistics', 'statistical modeling'] },
  { canonical: 'Tableau',          aliases: ['tableau', 'data visualisation', 'data visualization'] },
  { canonical: 'Apache Spark',     aliases: ['spark', 'apache spark', 'pyspark'] },
  { canonical: 'Kafka',            aliases: ['kafka', 'apache kafka'] },

  // ── Frontend ───────────────────────────────────────────────────────────
  { canonical: 'React',            aliases: ['react', 'reactjs', 'react.js'] },
  { canonical: 'Angular',          aliases: ['angular', 'angularjs'] },
  { canonical: 'Vue.js',           aliases: ['vue', 'vuejs'] },
  { canonical: 'CSS',              aliases: ['css', 'scss', 'tailwind'] },
  { canonical: 'Figma',            aliases: ['figma', 'ux design', 'ui design'] },

  // ── Cybersecurity ──────────────────────────────────────────────────────
  { canonical: 'Network Security', aliases: ['network security', 'firewall', 'vpn'] },
  { canonical: 'Ethical Hacking',  aliases: ['ethical hacking', 'penetration testing', 'pentesting'] },
  { canonical: 'SIEM',             aliases: ['siem', 'splunk', 'security monitoring'] },
  { canonical: 'ISO 27001',        aliases: ['iso 27001', 'information security'] },

  // ── Finance ────────────────────────────────────────────────────────────
  { canonical: 'Financial Modeling', aliases: ['financial modeling', 'financial modelling', 'dcf'] },
  { canonical: 'Excel',              aliases: ['excel', 'microsoft excel', 'spreadsheets'] },
  { canonical: 'Accounting',        aliases: ['accounting', 'bookkeeping', 'tally'] },
  { canonical: 'Taxation',          aliases: ['taxation', 'tax', 'gst', 'income tax'] },

  // ── Soft skills ────────────────────────────────────────────────────────
  { canonical: 'Communication',    aliases: ['communication', 'presentation', 'verbal communication'] },
  { canonical: 'Leadership',       aliases: ['leadership', 'team lead', 'team management'] },
  { canonical: 'Agile',            aliases: ['agile', 'scrum', 'kanban'] },
  { canonical: 'System Design',    aliases: ['system design', 'architecture', 'microservices'] },

  // ── Medical ────────────────────────────────────────────────────────────
  { canonical: 'Clinical Diagnosis', aliases: ['clinical diagnosis', 'clinical skills', 'patient care'] },
  { canonical: 'Medical Research',   aliases: ['medical research', 'clinical trials', 'gcp'] },
  { canonical: 'Biomedical',         aliases: ['biomedical', 'biomedical engineering', 'matlab'] },

  // ── Legal ──────────────────────────────────────────────────────────────
  { canonical: 'Corporate Law',     aliases: ['corporate law', 'contract law', 'legal research'] },
  { canonical: 'Legal Writing',     aliases: ['legal writing', 'drafting', 'legal research'] },

  // ── Marketing ─────────────────────────────────────────────────────────
  { canonical: 'Digital Marketing', aliases: ['digital marketing', 'seo', 'sem', 'performance marketing'] },
  { canonical: 'Content Marketing', aliases: ['content marketing', 'content writing', 'copywriting'] },
  { canonical: 'Google Analytics',  aliases: ['google analytics', 'ga4', 'web analytics'] },
];

// Build fast lookup: alias → canonical
const _aliasMap = new Map();
for (const entry of SKILL_TAXONOMY) {
  for (const alias of entry.aliases) {
    _aliasMap.set(alias.toLowerCase().trim(), entry.canonical);
  }
  _aliasMap.set(entry.canonical.toLowerCase().trim(), entry.canonical);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract canonical skills from a free-text job description.
 *
 * @param {string} text
 * @returns {string[]} deduplicated canonical skill names
 */
function extractFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = ` ${text.toLowerCase()} `;
  const found = new Set();

  for (const [alias, canonical] of _aliasMap.entries()) {
    if (lower.includes(alias)) {
      found.add(canonical);
    }
  }
  return Array.from(found);
}

/**
 * Aggregate skills from an array of job docs (already have skills[]).
 * Normalises skills and returns a frequency map.
 *
 * @param {Array<{skills: string[]}>} jobs
 * @returns {Map<string, number>} skill → count
 */
function aggregateSkillCounts(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    for (const raw of (job.skills ?? [])) {
      const canonical = _aliasMap.get(raw.toLowerCase().trim()) ?? raw;
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Return the SKILL_TAXONOMY for inspection / seeding.
 */
function getTaxonomy() {
  return SKILL_TAXONOMY;
}

module.exports = { extractFromText, aggregateSkillCounts, getTaxonomy };









