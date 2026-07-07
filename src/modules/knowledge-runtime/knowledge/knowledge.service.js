'use strict';

/**
 * modules/knowledge-runtime/knowledge/knowledge.service.js
 *
 * Single entry point for reading, resolving, and versioning knowledge-graph
 * content (career domains, roles, skills, skill clusters) that AIC/HKP
 * defined at the architecture layer. First service implemented under
 * WP-IMP-02 (RUNTIME_CLASS_REFERENCE.md §1).
 *
 * Architecture constraints (carried over unchanged from
 * IntelligenceQualityService, the precedent this class follows):
 *   - Constructor-injected dependencies only — no top-level require() of
 *     repositories, Supabase, or other services inside this file.
 *   - No calls to other knowledge-runtime services (avoids a circular
 *     dependency between Knowledge/Recommendation/Student).
 *   - Cache-first reads via the injected `cacheClient`
 *     (`cacheManager.getClient()`), never a second cache implementation.
 *   - Read-only: taxonomy writes remain owned by `modules/admin/cms/*`.
 *
 * `careerRepository` and `skillRepository` are constructor dependencies
 * per RUNTIME_CLASS_REFERENCE.md, but are deliberately used narrowly:
 *   - `skillRepository.getByName()` is used as an alias-aware fast path in
 *     `searchKnowledge()` — a capability the CMS skills table itself
 *     doesn't provide (exact-name only).
 *   - `careerRepository` is accepted and stored, but intentionally not
 *     called by any method in this WP. `career.repository.js` operates on
 *     `career_graph_roles`, a different table from `cms_roles`, and
 *     whether `cms_roles.id` and `career_graph_roles.role_id` share an
 *     identifier space has not been confirmed anywhere in the frozen
 *     architecture docs. Wiring role-transition enrichment on an unverified
 *     identifier assumption would violate the WP's "never assume" mandate.
 *     This is flagged as an open follow-up, not silently resolved here.
 */

const CACHE_KEY_PREFIX = 'knowledge-runtime:';
const NODE_CACHE_TTL_BASE_SECONDS = 300;
const NODE_CACHE_JITTER_MAX_SECONDS = 30;
const VERSION_CACHE_KEY = `${CACHE_KEY_PREFIX}version`;

class KnowledgeService {
  /**
   * @param {object} deps
   * @param {import('./knowledge.repository').KnowledgeRepository} deps.knowledgeRepository
   * @param {object} deps.careerRepository — existing career.repository.js singleton (reused, not wrapped)
   * @param {object} deps.skillRepository — existing skillRepository.js instance (reused)
   * @param {object} [deps.cacheClient] — resolved client from cacheManager.getClient()
   * @param {object} deps.logger
   * @param {object} [deps.config] — optional threshold/TTL overrides
   */
  constructor({
    knowledgeRepository,
    careerRepository,
    skillRepository,
    cacheClient = null,
    logger,
    config = {},
  }) {
    if (!knowledgeRepository) {
      throw new Error('[KnowledgeService] knowledgeRepository is required');
    }
    if (!logger) {
      throw new Error('[KnowledgeService] logger is required');
    }

    this._knowledgeRepository = knowledgeRepository;
    this._careerRepository = careerRepository;
    this._skillRepository = skillRepository;
    this._cacheClient = cacheClient;
    this._logger = logger;
    this._config = config;

    this._ttlBaseSeconds = config.nodeCacheTtlSeconds ?? NODE_CACHE_TTL_BASE_SECONDS;
    this._ttlJitterMaxSeconds = config.nodeCacheJitterMaxSeconds ?? NODE_CACHE_JITTER_MAX_SECONDS;
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC API — RUNTIME_CLASS_REFERENCE.md §1
  // ─────────────────────────────────────────────────────────

  /**
   * Resolve a single taxonomy node (domain/role/skill/skill cluster) by id.
   * Cache-first.
   *
   * @param {string} nodeId
   * @param {string} [nodeType]
   * @returns {Promise<{nodeType: string, node: object}|null>}
   */
  async getTaxonomyNode(nodeId, nodeType = null) {
    const cacheKey = this._nodeCacheKey(nodeId, nodeType);

    const cached = await this._getCached(cacheKey);
    if (cached !== null) {
      this._logger.info('[KnowledgeRuntime.Knowledge] getTaxonomyNode cache hit', { nodeId, nodeType });
      return cached;
    }

    const result = await this._knowledgeRepository.findNodeById(nodeId, nodeType);

    if (result) {
      await this._setCached(this._nodeCacheKey(nodeId, result.nodeType), result);
    }

    return result;
  }

  /**
   * Resolve a node plus its descendants to a bounded depth. Cache-first.
   *
   * @param {string} nodeId
   * @param {{ depth?: number }} [options]
   * @returns {Promise<{nodeType: string, node: object, children: object}|null>}
   */
  async getTaxonomySubtree(nodeId, { depth = 1 } = {}) {
    const root = await this.getTaxonomyNode(nodeId);
    if (!root) return null;

    const cacheKey = this._subtreeCacheKey(nodeId, root.nodeType, depth);
    const cached = await this._getCached(cacheKey);
    if (cached !== null) {
      this._logger.info('[KnowledgeRuntime.Knowledge] getTaxonomySubtree cache hit', { nodeId, depth });
      return cached;
    }

    const children = await this._knowledgeRepository.findChildren(nodeId, root.nodeType, { depth });

    const subtree = { nodeType: root.nodeType, node: root.node, children };

    await this._setCached(cacheKey, subtree);

    return subtree;
  }

  /**
   * Delegate a filtered lookup across domains/roles/skills/skill clusters.
   * Not cached — search result sets are too varied for a fixed key space
   * to pay off, matching the read-heavy-but-uncached pattern already used
   * for filtered list endpoints elsewhere in this codebase (e.g.
   * `adminCmsRoles.repository.js#list`).
   *
   * @param {string} query
   * @param {{ nodeTypes?: string[], limit?: number }} [filters]
   * @returns {Promise<Array<{nodeType: string, node: object}>>}
   */
  async searchKnowledge(query, filters = {}) {
    const { nodeTypes, limit } = filters;
    const wantsSkills = !nodeTypes || nodeTypes.includes('SKILL');

    const results = await this._knowledgeRepository.searchByName(query, {
      nodeTypes,
      limit,
    });

    // Alias-aware fast path: if an exact skill/alias match exists via the
    // existing skillRepository and isn't already in the result set, surface
    // it too. This reuses skillRepository's existing capability rather than
    // reimplementing alias resolution against cms_skills (Objective 3).
    if (wantsSkills && this._skillRepository) {
      try {
        const aliasMatch = await this._skillRepository.getByName(query);
        if (aliasMatch) {
          const alreadyPresent = results.some(
            (r) => r.nodeType === 'SKILL' && r.node?.name === aliasMatch.name
          );
          if (!alreadyPresent) {
            results.unshift({
              nodeType: 'SKILL',
              node: aliasMatch,
              matchedVia: 'skillRepository.alias',
            });
          }
        }
      } catch (error) {
        this._logger.warn('[KnowledgeRuntime.Knowledge] skillRepository alias lookup failed', {
          query,
          error: error.message,
        });
      }
    }

    return results.slice(0, limit ?? results.length);
  }

  /**
   * Resolve a skill cluster and its member skills.
   *
   * NOTE: member skills cannot currently be resolved — there is no
   * join/membership table between cms_skills and cms_skill_clusters in the
   * present schema (confirmed by repository inspection). `memberSkills` is
   * returned as an empty array with `memberSkillsAvailable: false` rather
   * than guessing a relationship. See knowledge.repository.js header.
   *
   * @param {string} clusterId
   * @returns {Promise<{cluster: object, memberSkills: object[], memberSkillsAvailable: boolean}|null>}
   */
  async resolveSkillCluster(clusterId) {
    const cacheKey = `${CACHE_KEY_PREFIX}cluster:${clusterId}`;
    const cached = await this._getCached(cacheKey);
    if (cached !== null) return cached;

    const cluster = await this._knowledgeRepository.findSkillClusterById(clusterId);
    if (!cluster) return null;

    const result = {
      cluster,
      memberSkills: [],
      memberSkillsAvailable: false,
    };

    await this._setCached(cacheKey, result);

    return result;
  }

  /**
   * List all DOMAIN nodes, unfiltered. Cache-first, same pattern as every
   * other read in this service. WP-XAI2-04: this is the enumeration
   * capability the ADR identified as needed for the `career` decision
   * type's evidence-sparse fallback (a student/professional with no stated
   * career interests/goals still gets a full domain list rather than an
   * empty result — see `recommendation.service.js#_matchCareer`).
   *
   * @param {{ limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async listDomains(options = {}) {
    const cacheKey = `${CACHE_KEY_PREFIX}domains:list:${options.limit ?? 'default'}`;

    const cached = await this._getCached(cacheKey);
    if (cached !== null) {
      this._logger.info('[KnowledgeRuntime.Knowledge] listDomains cache hit');
      return cached;
    }

    const domains = await this._knowledgeRepository.listDomains(options);

    await this._setCached(cacheKey, domains);

    return domains;
  }

  /**
   * Explicit cache invalidation hook, called by admin CMS write paths after
   * a taxonomy mutation. Since the node's type isn't known at the call
   * site in every case, this clears the node-cache entry for all four node
   * types plus any subtree/cluster caches touching this id, and bumps the
   * taxonomy version so downstream consumers relying on `getVersion()`
   * observe the change.
   *
   * @param {string} nodeId
   * @returns {Promise<void>}
   */
  async invalidate(nodeId) {
    if (!nodeId) return;

    const keysToDelete = [
      this._nodeCacheKey(nodeId, 'DOMAIN'),
      this._nodeCacheKey(nodeId, 'ROLE'),
      this._nodeCacheKey(nodeId, 'SKILL'),
      this._nodeCacheKey(nodeId, 'SKILL_CLUSTER'),
      `${CACHE_KEY_PREFIX}cluster:${nodeId}`,
    ];

    await Promise.all(keysToDelete.map((key) => this._deleteCached(key)));
    await this._bumpVersion();

    this._logger.info('[KnowledgeRuntime.Knowledge] cache invalidated', { nodeId });
  }

  /**
   * Report the current taxonomy version/checksum for downstream consumers
   * (RecommendationService, StudentService). Backed by a cache-stored
   * counter bumped on every `invalidate()` call; if the cache has no
   * client available (e.g. MemoryCache fallback reset), a fresh version
   * token is minted rather than throwing, since version is advisory
   * (cache-busting), not a source of truth.
   *
   * @returns {Promise<{version: string}>}
   */
  async getVersion() {
    const cached = await this._getCached(VERSION_CACHE_KEY);
    if (cached !== null) return cached;

    const initial = { version: String(Date.now()) };
    await this._setCached(VERSION_CACHE_KEY, initial, { ttlSeconds: 0 });
    return initial;
  }

  // ─────────────────────────────────────────────────────────
  // CACHE HELPERS
  // Pattern reused verbatim from `dashboard.service.js`
  // (ENGINEERING_STANDARDS.md / Objective 8): resolve the raw client
  // defensively, TTL + jitter, get/set/del wrapped in try/catch, cache
  // failures are logged and swallowed — never thrown.
  // ─────────────────────────────────────────────────────────

  _resolveRawClient() {
    const client = this._cacheClient;
    if (!client) return null;

    return client?.client?.get
      ? client.client
      : client?.get
      ? client
      : null;
  }

  async _getCached(key) {
    const redis = this._resolveRawClient();
    if (!redis) return null;

    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Knowledge] Cache read failed', {
        key,
        error: error.message,
      });
      return null;
    }
  }

  async _setCached(key, value, { ttlSeconds } = {}) {
    const redis = this._resolveRawClient();
    if (!redis) return;

    try {
      const ttl = ttlSeconds ?? (
        this._ttlBaseSeconds + Math.floor(Math.random() * this._ttlJitterMaxSeconds)
      );

      if (ttl > 0) {
        await redis.set(key, JSON.stringify(value), 'EX', ttl);
      } else {
        await redis.set(key, JSON.stringify(value));
      }
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Knowledge] Cache write failed', {
        key,
        error: error.message,
      });
    }
  }

  async _deleteCached(key) {
    const redis = this._resolveRawClient();
    if (!redis) return;

    try {
      await redis.del(key);
    } catch (error) {
      this._logger.warn('[KnowledgeRuntime.Knowledge] Cache invalidation failed', {
        key,
        error: error.message,
      });
    }
  }

  async _bumpVersion() {
    const next = { version: String(Date.now()) };
    await this._setCached(VERSION_CACHE_KEY, next, { ttlSeconds: 0 });
  }

  _nodeCacheKey(nodeId, nodeType) {
    return `${CACHE_KEY_PREFIX}node:${nodeType ?? 'ANY'}:${nodeId}`;
  }

  _subtreeCacheKey(nodeId, nodeType, depth) {
    return `${CACHE_KEY_PREFIX}subtree:${nodeType}:${nodeId}:${depth}`;
  }
}

module.exports = KnowledgeService;
