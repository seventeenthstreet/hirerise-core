'use strict';

const logger    = require('../utils/logger');
const supabase  = require('../config/supabase');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _fetch(table, filters = []) {
  let query = supabase.from(table).select('*');

  for (const f of filters) {
    query = query.eq(f.field, f.value);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return data || [];
}

// ── Taxonomy helpers ──────────────────────────────────────────────────────────

async function getAllCareerDomains() {
  return _fetch('cms_career_domains', [
    { field: 'softDeleted', value: false },
    { field: 'status', value: 'active' },
  ]);
}

async function getSkillClusters(domainId = null) {
  const filters = [
    { field: 'softDeleted', value: false },
    { field: 'status', value: 'active' },
  ];

  if (domainId) {
    filters.push({ field: 'domainId', value: domainId });
  }

  return _fetch('cms_skill_clusters', filters);
}

async function getCareerRoles(domainId = null) {
  const filters = [
    { field: 'softDeleted', value: false },
    { field: 'status', value: 'active' },
  ];

  if (domainId) {
    filters.push({ field: 'domainId', value: domainId });
  }

  return _fetch('cms_roles', filters);
}

// ── Domain Detection ──────────────────────────────────────────────────────────

async function detectCareerDomain(profile) {
  try {
    const [domains, clusters] = await Promise.all([
      getAllCareerDomains(),
      getSkillClusters(),
    ]);

    if (!domains.length) {
      return { domainId: null, domainName: null, confidence: 0, scores: [] };
    }

    const profileSkills = new Set(
      (profile.skills ?? []).map(s => s.toLowerCase().trim())
    );

    const titleTokens = (profile.currentTitle ?? '')
      .toLowerCase()
      .split(/\W+/)
      .filter(Boolean);

    const clustersByDomain = {};
    for (const cluster of clusters) {
      if (!clustersByDomain[cluster.domainId]) {
        clustersByDomain[cluster.domainId] = [];
      }
      clustersByDomain[cluster.domainId].push(cluster);
    }

    const scores = [];

    for (const domain of domains) {
      let score = 0;

      const domainClusters = clustersByDomain[domain.id] ?? [];

      for (const cluster of domainClusters) {
        const clusterTokens = cluster.name.toLowerCase().split(/\W+/).filter(Boolean);
        const matchCount = clusterTokens.filter(t => profileSkills.has(t)).length;
        score += matchCount * 0.15;
      }

      const domainTokens = domain.name.toLowerCase().split(/\W+/).filter(Boolean);
      const titleMatch = titleTokens.filter(t => domainTokens.includes(t)).length;
      score += titleMatch * 0.25;

      const confidence = Math.min(score, 1);

      scores.push({
        domainId: domain.id,
        domainName: domain.name,
        confidence,
      });
    }

    scores.sort((a, b) => b.confidence - a.confidence);

    const best = scores[0];
    const MIN_CONFIDENCE = 0.1;

    return {
      domainId:   best?.confidence >= MIN_CONFIDENCE ? best.domainId   : null,
      domainName: best?.confidence >= MIN_CONFIDENCE ? best.domainName : null,
      confidence: best?.confidence || 0,
      scores,
    };
  } catch (err) {
    logger.error('[CareerDomainService] detectCareerDomain failed', {
      error: err.message,
    });
    return { domainId: null, domainName: null, confidence: 0, scores: [] };
  }
}

// ── Full Taxonomy Tree ───────────────────────────────────────────────────────

async function getDomainsWithFamilies() {
  try {
    const [domains, families, roles] = await Promise.all([
      _fetch('cms_career_domains', [{ field: 'softDeleted', value: false }]),
      _fetch('cms_job_families',   [{ field: 'softDeleted', value: false }]),
      _fetch('cms_roles',          [{ field: 'softDeleted', value: false }]),
    ]);

    const familiesByDomain = {};
    for (const f of families) {
      const key = f.domainId ?? '__unassigned__';
      if (!familiesByDomain[key]) familiesByDomain[key] = [];
      familiesByDomain[key].push(f);
    }

    const rolesByFamily = {};
    for (const r of roles) {
      const key = r.jobFamilyId ?? '__unassigned__';
      if (!rolesByFamily[key]) rolesByFamily[key] = [];
      rolesByFamily[key].push(r);
    }

    return domains.map(domain => {
      const domainFamilies = (familiesByDomain[domain.id] ?? []).map(family => ({
        ...family,
        roles: rolesByFamily[family.id] ?? [],
      }));

      return { ...domain, jobFamilies: domainFamilies };
    });
  } catch (err) {
    logger.error('[CareerDomainService] getDomainsWithFamilies failed', {
      error: err.message,
    });
    return [];
  }
}

module.exports = {
  detectCareerDomain,
  getAllCareerDomains,
  getSkillClusters,
  getCareerRoles,
  getDomainsWithFamilies,
};





