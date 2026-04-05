'use strict';

/**
 * services/resumeParser/skillDictionary.js
 *
 * Canonical skill taxonomy registry used by deterministic resume parsing.
 * Optimized for parser hot-path performance and long-lived worker safety.
 */

const SKILL_DICTIONARY_VERSION = '2.0.0';

const RAW_SKILL_ENTRIES = [
  // ── Programming ───────────────────────────────────────────────────────────
  {
    canonical: 'JavaScript',
    aliases: ['javascript', 'js', 'ecmascript', 'es6', 'es2015'],
    category: 'Programming',
  },
  {
    canonical: 'TypeScript',
    aliases: ['typescript', 'ts'],
    category: 'Programming',
  },
  {
    canonical: 'Python',
    aliases: ['python', 'python3'],
    category: 'Programming',
  },
  {
    canonical: 'Java',
    aliases: ['java', 'java 8', 'java 11', 'java 17'],
    category: 'Programming',
  },
  {
    canonical: 'React',
    aliases: ['react', 'reactjs', 'react.js'],
    category: 'Frontend',
  },
  {
    canonical: 'Node.js',
    aliases: ['node.js', 'nodejs', 'node'],
    category: 'Backend',
  },
  {
    canonical: 'PostgreSQL',
    aliases: ['postgresql', 'postgres', 'pg'],
    category: 'Databases',
  },
  {
    canonical: 'Supabase',
    aliases: ['supabase'],
    category: 'Databases',
  },
  {
    canonical: 'Docker',
    aliases: ['docker', 'dockerfile'],
    category: 'DevOps',
  },
  {
    canonical: 'Kubernetes',
    aliases: ['kubernetes', 'k8s'],
    category: 'DevOps',
  },
  {
    canonical: 'AWS',
    aliases: ['aws', 'amazon web services'],
    category: 'Cloud',
  },
  {
    canonical: 'OpenAI API',
    aliases: ['openai', 'gpt', 'chatgpt', 'openai api'],
    category: 'AI/ML',
  },
  {
    canonical: 'Financial Reporting',
    aliases: ['financial reporting', 'balance sheet', 'p&l'],
    category: 'Finance',
  },
  {
    canonical: 'GST',
    aliases: ['gst', 'gst filing', 'gst compliance'],
    category: 'Finance',
  },
  {
    canonical: 'SEO',
    aliases: ['seo', 'search engine optimization'],
    category: 'Marketing',
  },
];

/**
 * Normalize entries once at module load.
 */
const SKILL_ENTRIES = Object.freeze(
  RAW_SKILL_ENTRIES.map(entry =>
    Object.freeze({
      canonical: entry.canonical,
      category: entry.category,
      aliases: Object.freeze(
        entry.aliases
          .map(alias => alias.trim().toLowerCase())
          .filter(Boolean)
      ),
    })
  )
);

/**
 * aliasMap: normalized alias -> canonical mapping
 * First writer wins to avoid silent taxonomy drift.
 */
const aliasMap = new Map();

for (const entry of SKILL_ENTRIES) {
  const payload = Object.freeze({
    canonical: entry.canonical,
    category: entry.category,
  });

  const allAliases = [
    entry.canonical.toLowerCase(),
    ...entry.aliases,
  ];

  for (const alias of allAliases) {
    if (!aliasMap.has(alias)) {
      aliasMap.set(alias, payload);
    }
  }
}

module.exports = Object.freeze({
  SKILL_ENTRIES,
  aliasMap,
  SKILL_DICTIONARY_VERSION,
});