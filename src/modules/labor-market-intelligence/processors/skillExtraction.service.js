'use strict';

/**
 * src/modules/labor-market-intelligence/processors/skillExtraction.service.js
 *
 * Skill normalization + extraction utilities.
 *
 * Optimized for:
 * - deterministic Supabase analytics
 * - taxonomy-safe canonicalization
 * - low allocation hot paths
 * - future LLM enrichment compatibility
 */

const SKILL_TAXONOMY = Object.freeze([
  { canonical: 'Python', aliases: ['python', 'py'] },
  { canonical: 'JavaScript', aliases: ['javascript', 'js', 'node.js', 'nodejs'] },
  { canonical: 'TypeScript', aliases: ['typescript', 'ts'] },
  { canonical: 'Java', aliases: ['java', 'spring boot', 'springboot'] },
  { canonical: 'C++', aliases: ['c++', 'cpp'] },
  { canonical: 'Go', aliases: ['go', 'golang'] },
  { canonical: 'R', aliases: ['r', 'r programming'] },
  { canonical: 'SQL', aliases: ['sql', 'mysql', 'postgresql', 'postgres'] },

  { canonical: 'AWS', aliases: ['aws', 'amazon web services'] },
  { canonical: 'Azure', aliases: ['azure', 'microsoft azure'] },
  { canonical: 'GCP', aliases: ['gcp', 'google cloud'] },
  { canonical: 'Docker', aliases: ['docker', 'containerization'] },
  { canonical: 'Kubernetes', aliases: ['kubernetes', 'k8s'] },
  { canonical: 'Terraform', aliases: ['terraform', 'iac'] },
  { canonical: 'CI/CD', aliases: ['ci/cd', 'cicd', 'jenkins', 'github actions'] },

  { canonical: 'Machine Learning', aliases: ['machine learning', 'ml', 'supervised learning'] },
  { canonical: 'Deep Learning', aliases: ['deep learning', 'dl', 'neural networks'] },
  { canonical: 'TensorFlow', aliases: ['tensorflow', 'tf'] },
  { canonical: 'PyTorch', aliases: ['pytorch'] },
  { canonical: 'NLP', aliases: ['nlp', 'natural language processing', 'llm'] },
  { canonical: 'Computer Vision', aliases: ['computer vision', 'cv', 'image processing'] },

  { canonical: 'Data Analysis', aliases: ['data analysis', 'data analytics', 'analytics'] },
  { canonical: 'Statistics', aliases: ['statistics', 'statistical modeling'] },
  { canonical: 'Tableau', aliases: ['tableau', 'data visualisation', 'data visualization'] },
  { canonical: 'Apache Spark', aliases: ['spark', 'apache spark', 'pyspark'] },
  { canonical: 'Kafka', aliases: ['kafka', 'apache kafka'] },

  { canonical: 'React', aliases: ['react', 'reactjs', 'react.js'] },
  { canonical: 'Angular', aliases: ['angular', 'angularjs'] },
  { canonical: 'Vue.js', aliases: ['vue', 'vuejs'] },
  { canonical: 'CSS', aliases: ['css', 'scss', 'tailwind'] },
  { canonical: 'Figma', aliases: ['figma', 'ux design', 'ui design'] },

  { canonical: 'Network Security', aliases: ['network security', 'firewall', 'vpn'] },
  { canonical: 'Ethical Hacking', aliases: ['ethical hacking', 'penetration testing', 'pentesting'] },
  { canonical: 'SIEM', aliases: ['siem', 'splunk', 'security monitoring'] },
  { canonical: 'ISO 27001', aliases: ['iso 27001', 'information security'] },

  { canonical: 'Financial Modeling', aliases: ['financial modeling', 'financial modelling', 'dcf'] },
  { canonical: 'Excel', aliases: ['excel', 'microsoft excel', 'spreadsheets'] },
  { canonical: 'Accounting', aliases: ['accounting', 'bookkeeping', 'tally'] },
  { canonical: 'Taxation', aliases: ['taxation', 'tax', 'gst', 'income tax'] },

  { canonical: 'Communication', aliases: ['communication', 'presentation', 'verbal communication'] },
  { canonical: 'Leadership', aliases: ['leadership', 'team lead', 'team management'] },
  { canonical: 'Agile', aliases: ['agile', 'scrum', 'kanban'] },
  { canonical: 'System Design', aliases: ['system design', 'architecture', 'microservices'] },

  { canonical: 'Clinical Diagnosis', aliases: ['clinical diagnosis', 'clinical skills', 'patient care'] },
  { canonical: 'Medical Research', aliases: ['medical research', 'clinical trials', 'gcp'] },
  { canonical: 'Biomedical', aliases: ['biomedical', 'biomedical engineering', 'matlab'] },

  { canonical: 'Corporate Law', aliases: ['corporate law', 'contract law', 'legal research'] },
  { canonical: 'Legal Writing', aliases: ['legal writing', 'drafting', 'legal research'] },

  { canonical: 'Digital Marketing', aliases: ['digital marketing', 'seo', 'sem', 'performance marketing'] },
  { canonical: 'Content Marketing', aliases: ['content marketing', 'content writing', 'copywriting'] },
  { canonical: 'Google Analytics', aliases: ['google analytics', 'ga4', 'web analytics'] }
]);

const aliasMap = buildAliasMap(SKILL_TAXONOMY);
const sortedAliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length);

// ───────────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────────

function extractFromText(text) {
  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    return [];
  }

  const found = new Set();

  for (const alias of sortedAliases) {
    if (containsWholePhrase(normalizedText, alias)) {
      found.add(aliasMap.get(alias));
    }
  }

  return [...found];
}

function aggregateSkillCounts(jobs) {
  const counts = new Map();

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return counts;
  }

  for (const job of jobs) {
    const skills = Array.isArray(job?.skills) ? job.skills : [];

    for (const rawSkill of skills) {
      const canonical = normalizeSkill(rawSkill);
      if (!canonical) continue;

      counts.set(canonical, (counts.get(canonical) || 0) + 1);
    }
  }

  return counts;
}

function getTaxonomy() {
  return SKILL_TAXONOMY;
}

// ───────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ───────────────────────────────────────────────────────────────────────────────

function buildAliasMap(taxonomy) {
  const map = new Map();

  for (const entry of taxonomy) {
    const canonical = normalizeToken(entry.canonical);
    if (!canonical) continue;

    map.set(canonical, entry.canonical);

    for (const alias of entry.aliases || []) {
      const normalizedAlias = normalizeToken(alias);
      if (normalizedAlias) {
        map.set(normalizedAlias, entry.canonical);
      }
    }
  }

  return map;
}

function normalizeSkill(value) {
  const token = normalizeToken(value);
  if (!token) return null;

  return aliasMap.get(token) || String(value).trim();
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return ` ${value.toLowerCase().replace(/\s+/g, ' ').trim()} `;
}

function normalizeToken(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsWholePhrase(text, phrase) {
  return text.includes(` ${phrase} `);
}

module.exports = Object.freeze({
  extractFromText,
  aggregateSkillCounts,
  getTaxonomy
});