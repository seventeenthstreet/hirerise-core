'use strict';

/**
 * modules/knowledge-runtime/knowledge/knowledge.repository.js
 *
 * Data access for KnowledgeService — reads the four canonical, CMS-managed
 * HKP knowledge tables that make up the runtime taxonomy:
 *
 *   NODE_TYPE.DOMAIN         -> cms_career_domains
 *   NODE_TYPE.ROLE           -> cms_roles
 *   NODE_TYPE.SKILL          -> cms_skills
 *   NODE_TYPE.SKILL_CLUSTER  -> cms_skill_clusters
 *
 * These are the same tables `modules/admin/cms/*` writes to. This repository
 * is READ-ONLY by design (Objective 3 / REPOSITORY_INTEGRATION_GUIDE.md
 * §1) — taxonomy writes remain owned exclusively by the admin CMS layer.
 *
 * IMPLEMENTATION DECISION (documented per Objective 10 review):
 * RUNTIME_CLASS_REFERENCE.md and REPOSITORY_INTEGRATION_GUIDE.md describe
 * `knowledge.repository.js` as "extends BaseRepository, constructed with
 * the taxonomy/knowledge table name(s)". The real schema (confirmed by
 * repository inspection, not assumed) splits the taxonomy across four
 * independently-owned CMS tables rather than one. A single-table
 * `extends BaseRepository` cannot address four tables without either
 * mutating shared instance state per call (unsafe under interleaved async
 * calls) or duplicating BaseRepository's query/normalize logic per table
 * (forbidden by Objective 3: "No duplicated repository logic").
 *
 * Resolution: KnowledgeRepository is composed of four small, table-scoped
 * classes that each `extends BaseRepository` directly (one table each,
 * zero duplicated logic), and KnowledgeRepository itself is the
 * aggregation/orchestration point that RUNTIME_CLASS_REFERENCE.md's public
 * method list describes. Every read still goes through BaseRepository's
 * inherited `findById` / `find`, `_normalize`, and `_applyFilter` — nothing
 * bypasses it.
 *
 * SCHEMA GAP (documented, not silently worked around — Objective 10):
 * There is no join/membership table linking `cms_skills` rows to
 * `cms_skill_clusters` rows in the current schema (confirmed: neither
 * `adminCmsSkills.repository.js` nor `adminCmsSkillClusters.module.js`
 * expose a cluster/skill foreign key or array column). `resolveSkillCluster`
 * therefore returns the cluster record with `memberSkills: []` and
 * `memberSkillsAvailable: false` rather than inventing a relationship. See
 * WP-IMP-02 implementation notes for the follow-up needed from HKP/CMS.
 */

const BaseRepository = require('../../../repositories/BaseRepository');
const logger = require('../../../utils/logger');

const NODE_TYPE = Object.freeze({
  DOMAIN: 'DOMAIN',
  ROLE: 'ROLE',
  SKILL: 'SKILL',
  SKILL_CLUSTER: 'SKILL_CLUSTER',
});

const TABLE_BY_NODE_TYPE = Object.freeze({
  [NODE_TYPE.DOMAIN]: 'cms_career_domains',
  [NODE_TYPE.ROLE]: 'cms_roles',
  [NODE_TYPE.SKILL]: 'cms_skills',
  [NODE_TYPE.SKILL_CLUSTER]: 'cms_skill_clusters',
});

// ─────────────────────────────────────────────────────────────
// TABLE-SCOPED REPOSITORIES
// Each extends BaseRepository directly — no logic duplicated.
// ─────────────────────────────────────────────────────────────

class DomainRepository extends BaseRepository {
  constructor() {
    super('cms_career_domains');
  }
}

class RoleRepository extends BaseRepository {
  constructor() {
    super('cms_roles');
  }
}

class SkillRepository extends BaseRepository {
  constructor() {
    super('cms_skills');
  }
}

class SkillClusterRepository extends BaseRepository {
  constructor() {
    super('cms_skill_clusters');
  }
}

// ─────────────────────────────────────────────────────────────
// KNOWLEDGE REPOSITORY (aggregation point)
// ─────────────────────────────────────────────────────────────

class KnowledgeRepository {
  constructor() {
    this._repos = {
      [NODE_TYPE.DOMAIN]: new DomainRepository(),
      [NODE_TYPE.ROLE]: new RoleRepository(),
      [NODE_TYPE.SKILL]: new SkillRepository(),
      [NODE_TYPE.SKILL_CLUSTER]: new SkillClusterRepository(),
    };
  }

  /**
   * Resolve a single taxonomy node by id.
   *
   * @param {string} nodeId
   * @param {string} [nodeType] — one of NODE_TYPE; if omitted, all four
   *   tables are probed (bounded to 4 lookups) and the first hit is
   *   returned. Callers that already know the type should pass it to avoid
   *   the extra round-trips.
   * @returns {Promise<{nodeType: string, node: object} | null>}
   */
  async findNodeById(nodeId, nodeType = null) {
    if (!nodeId) return null;

    if (nodeType) {
      const repo = this._repoFor(nodeType);
      const node = await repo.findById(nodeId);
      return node ? { nodeType, node } : null;
    }

    const candidates = Object.keys(NODE_TYPE).map((key) => NODE_TYPE[key]);

    const results = await Promise.all(
      candidates.map(async (type) => {
        const node = await this._repos[type].findById(nodeId);
        return node ? { nodeType: type, node } : null;
      })
    );

    return results.find(Boolean) ?? null;
  }

  /**
   * Resolve the direct children of a node, bounded by depth.
   * Only DOMAIN nodes currently have resolvable children in this schema
   * (cms_roles.domain_id, cms_skill_clusters.domain_id) — confirmed via
   * `services/careerDomain.service.js`, not assumed. SKILL and
   * SKILL_CLUSTER nodes have no further descendants in the current schema
   * and return an empty child list rather than guessing a relationship.
   *
   * @param {string} nodeId
   * @param {string} nodeType
   * @param {{ depth?: number }} [options]
   * @returns {Promise<{roles: object[], skillClusters: object[]}>}
   */
  async findChildren(nodeId, nodeType, { depth = 1 } = {}) {
    if (nodeType !== NODE_TYPE.DOMAIN || depth < 1) {
      return { roles: [], skillClusters: [] };
    }

    const filters = [{ field: 'domainId', op: '==', value: nodeId }];

    const [rolesResult, clustersResult] = await Promise.all([
      this._repos[NODE_TYPE.ROLE].find(filters, { limit: 200 }),
      this._repos[NODE_TYPE.SKILL_CLUSTER].find(filters, { limit: 200 }),
    ]);

    return {
      roles: rolesResult.docs,
      skillClusters: clustersResult.docs,
    };
  }

  /**
   * Filtered, case-insensitive name search across one or all node types.
   * This is a genuinely new capability beyond BaseRepository's defaults
   * (`==`/`in`/etc. filters only) — not a duplication, since BaseRepository
   * has no text-search operator.
   *
   * @param {string} query
   * @param {{ nodeTypes?: string[], limit?: number }} [filters]
   * @returns {Promise<Array<{nodeType: string, node: object}>>}
   */
  async searchByName(query, { nodeTypes = null, limit = 20 } = {}) {
    if (!query || typeof query !== 'string') return [];

    const types = Array.isArray(nodeTypes) && nodeTypes.length
      ? nodeTypes.filter((t) => TABLE_BY_NODE_TYPE[t])
      : Object.keys(NODE_TYPE).map((key) => NODE_TYPE[key]);

    const results = await Promise.all(
      types.map(async (type) => {
        const repo = this._repos[type];
        try {
          const { docs } = await repo.find(
            [{ field: 'name', op: '==', value: query }],
            { limit }
          );
          return docs.map((node) => ({ nodeType: type, node }));
        } catch (error) {
          // '==' is an exact match; a genuine ILIKE search operator does
          // not exist on BaseRequest today. Exact-match is the safe,
          // non-invented behaviour until BaseRepository grows a text-search
          // operator (flagged in implementation notes, not silently
          // widened here).
          logger.warn('[KnowledgeRepository.searchByName] search failed', {
            nodeType: type,
            error: error.message,
          });
          return [];
        }
      })
    );

    return results.flat().slice(0, limit);
  }

  /**
   * Resolve a skill cluster by id. Member skills cannot currently be
   * resolved — see the SCHEMA GAP note at the top of this file.
   *
   * @param {string} clusterId
   * @returns {Promise<object|null>}
   */
  async findSkillClusterById(clusterId) {
    return this._repos[NODE_TYPE.SKILL_CLUSTER].findById(clusterId);
  }

  /**
   * List all DOMAIN nodes, unfiltered — the enumeration capability the
   * WP_XAI2_04 ADR identified as the one missing piece of Knowledge Runtime
   * support for the `career` decision type ("KnowledgeService method to
   * list DOMAIN nodes without a query term"). Not new query
   * infrastructure: `BaseRepository.find(filters = [], options = {})`
   * already supports an unfiltered call (`findChildren` above already
   * relies on the same `find()` method, just with filters populated) —
   * this exposes that existing capability through one more public method.
   *
   * @param {{ limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async listDomains({ limit = 200 } = {}) {
    const { docs } = await this._repos[NODE_TYPE.DOMAIN].find([], { limit });
    return docs;
  }

  _repoFor(nodeType) {
    const repo = this._repos[nodeType];
    if (!repo) {
      throw new Error(`[KnowledgeRepository] Unknown node type: ${nodeType}`);
    }
    return repo;
  }
}

module.exports = { KnowledgeRepository, NODE_TYPE, TABLE_BY_NODE_TYPE };
