'use strict';

/**
 * @file src/services/careerDomain.service.js
 * @description
 * Supabase-native career taxonomy + domain detection service.
 *
 * Optimized for:
 * - snake_case Supabase schema
 * - deterministic ordering
 * - safer null handling
 * - low-overfetch queries
 * - map-based grouping
 * - clean service boundaries
 */

const logger = require('../utils/logger');
const { supabase } = require('../config/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// Query helper
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRows(table, {
  filters = [],
  columns = '*',
  orderBy = null,
} = {}) {
  let query = supabase.from(table).select(columns);

  for (const filter of filters) {
    query = query.eq(filter.field, filter.value);
  }

  if (orderBy?.column) {
    query = query.order(orderBy.column, {
      ascending: orderBy.ascending ?? true,
    });
  }

  const { data, error } = await query;

  if (error) {
    logger.error('[CareerDomainService] fetchRows failed', {
      table,
      error: error.message,
    });
    throw error;
  }

  return Array.isArray(data) ? data : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxonomy helpers
// ─────────────────────────────────────────────────────────────────────────────
async function getAllCareerDomains() {
  return fetchRows('cms_career_domains', {
    filters: [
      { field: 'soft_deleted', value: false },
      { field: 'status', value: 'active' },
    ],
    columns: 'id,name,status',
    orderBy: { column: 'name', ascending: true },
  });
}

async function getSkillClusters(domainId = null) {
  const filters = [
    { field: 'soft_deleted', value: false },
    { field: 'status', value: 'active' },
  ];

  if (domainId) {
    filters.push({ field: 'domain_id', value: domainId });
  }

  return fetchRows('cms_skill_clusters', {
    filters,
    columns: 'id,name,domain_id,status',
    orderBy: { column: 'name', ascending: true },
  });
}

async function getCareerRoles(domainId = null) {
  const filters = [
    { field: 'soft_deleted', value: false },
    { field: 'status', value: 'active' },
  ];

  if (domainId) {
    filters.push({ field: 'domain_id', value: domainId });
  }

  return fetchRows('cms_roles', {
    filters,
    columns: 'id,name,domain_id,job_family_id,status',
    orderBy: { column: 'name', ascending: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain detection
// ─────────────────────────────────────────────────────────────────────────────
async function detectCareerDomain(profile = {}) {
  try {
    const [domains, clusters] = await Promise.all([
      getAllCareerDomains(),
      getSkillClusters(),
    ]);

    if (!domains.length) {
      return {
        domainId: null,
        domainName: null,
        confidence: 0,
        scores: [],
      };
    }

    const profileSkills = new Set(
      (Array.isArray(profile.skills) ? profile.skills : [])
        .map((skill) => String(skill).toLowerCase().trim())
        .filter(Boolean)
    );

    const titleTokens = String(profile.currentTitle || '')
      .toLowerCase()
      .split(/\W+/)
      .filter(Boolean);

    const clustersByDomain = new Map();

    for (const cluster of clusters) {
      const key = cluster.domain_id;
      if (!clustersByDomain.has(key)) {
        clustersByDomain.set(key, []);
      }
      clustersByDomain.get(key).push(cluster);
    }

    const scores = domains.map((domain) => {
      let score = 0;

      const domainClusters = clustersByDomain.get(domain.id) || [];

      for (const cluster of domainClusters) {
        const clusterTokens = String(cluster.name)
          .toLowerCase()
          .split(/\W+/)
          .filter(Boolean);

        const matchCount = clusterTokens.filter((token) =>
          profileSkills.has(token)
        ).length;

        score += matchCount * 0.15;
      }

      const domainTokens = String(domain.name)
        .toLowerCase()
        .split(/\W+/)
        .filter(Boolean);

      const titleMatch = titleTokens.filter((token) =>
        domainTokens.includes(token)
      ).length;

      score += titleMatch * 0.25;

      return {
        domainId: domain.id,
        domainName: domain.name,
        confidence: Math.min(score, 1),
      };
    });

    scores.sort((a, b) => b.confidence - a.confidence);

    const best = scores[0];
    const MIN_CONFIDENCE = 0.1;

    return {
      domainId:
        best?.confidence >= MIN_CONFIDENCE ? best.domainId : null,
      domainName:
        best?.confidence >= MIN_CONFIDENCE ? best.domainName : null,
      confidence: best?.confidence || 0,
      scores,
    };
  } catch (err) {
    logger.error('[CareerDomainService] detectCareerDomain failed', {
      error: err?.message || 'Unknown detection error',
    });

    return {
      domainId: null,
      domainName: null,
      confidence: 0,
      scores: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full taxonomy tree
// ─────────────────────────────────────────────────────────────────────────────
async function getDomainsWithFamilies() {
  try {
    const [domains, families, roles] = await Promise.all([
      fetchRows('cms_career_domains', {
        filters: [{ field: 'soft_deleted', value: false }],
        columns: 'id,name,status',
        orderBy: { column: 'name' },
      }),
      fetchRows('cms_job_families', {
        filters: [{ field: 'soft_deleted', value: false }],
        columns: 'id,name,domain_id',
        orderBy: { column: 'name' },
      }),
      fetchRows('cms_roles', {
        filters: [{ field: 'soft_deleted', value: false }],
        columns: 'id,name,job_family_id,domain_id',
        orderBy: { column: 'name' },
      }),
    ]);

    const familiesByDomain = new Map();
    for (const family of families) {
      const key = family.domain_id ?? '__unassigned__';
      if (!familiesByDomain.has(key)) {
        familiesByDomain.set(key, []);
      }
      familiesByDomain.get(key).push(family);
    }

    const rolesByFamily = new Map();
    for (const role of roles) {
      const key = role.job_family_id ?? '__unassigned__';
      if (!rolesByFamily.has(key)) {
        rolesByFamily.set(key, []);
      }
      rolesByFamily.get(key).push(role);
    }

    return domains.map((domain) => {
      const domainFamilies = (familiesByDomain.get(domain.id) || []).map(
        (family) => ({
          ...family,
          roles: rolesByFamily.get(family.id) || [],
        })
      );

      return {
        ...domain,
        jobFamilies: domainFamilies,
      };
    });
  } catch (err) {
    logger.error('[CareerDomainService] getDomainsWithFamilies failed', {
      error: err?.message || 'Unknown taxonomy error',
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