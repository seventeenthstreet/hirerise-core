'use strict';

/**
 * MIGRATION: db.collection() → supabase.from()
 *
 * All db.collection() shim calls in this file have been replaced with
 * direct supabase.from() calls. Result shapes mirror the Firestore shim:
 *   { data, error } from supabase  →  unwrapped to plain objects
 *   .maybeSingle()  for single-doc reads (returns null not error on 0 rows)
 *   .select('*')    for collection queries
 *
 * Batch writes → Promise.all([supabase.from(T).upsert(...), ...])
 * Transactions → sequential awaits (best-effort, same as shim behaviour)
 */

/**
 * skillGapEngine.js — Skill Gap AI Engine
 *
 * Identifies which skills a user must learn to reach their target role,
 * prioritises them by importance, and generates a prerequisite-aware
 * learning path using the skill_relationships graph in Firestore.
 *
 * Data sources (all read-only Firestore):
 *   role_skills          — required skills per role (importance_weight)
 *   skills               — skill metadata (name, category, difficulty_level)
 *   skill_relationships  — directed prerequisite/related edges between skills
 *
 * Public API:
 *   analyseSkillGap(profile)  → SkillGapResult
 *
 * SECURITY: Read-only. No writes. No auth mutations.
 */

const { db }   = require('../../config/supabase');
const logger   = require('../../utils/logger');

// ─── Priority Thresholds ──────────────────────────────────────────────────────

const PRIORITY = Object.freeze({
  HIGH:   { label: 'high_priority',   minWeight: 0.7  },
  MEDIUM: { label: 'medium_priority', minWeight: 0.35 },
  LOW:    { label: 'low_priority',    minWeight: 0     },
});

// Weeks to learn a skill by difficulty level (1–5 scale)
const WEEKS_BY_DIFFICULTY = Object.freeze({ 1: 2, 2: 4, 3: 6, 4: 10, 5: 16 });

// ─── Firestore Helpers ────────────────────────────────────────────────────────

/**
 * Fetch all required skills for a role from role_skills collection.
 * Returns enriched records with skill metadata joined from skills collection.
 */
async function fetchRoleSkills(roleDocId) {
  const { data: _rsdata, error: _rse } = await supabase.from('role_skills').select('*').eq('role_id', roleDocId);
  if (_rse) logger.warn('[SkillGap] role_skills error:', _rse.message);
  const snap = { empty: !_rsdata?.length, docs: (_rsdata||[]).map(r=>({data:()=>r})) };

  if (snap.empty) return [];

  // Batch-fetch skill metadata for all skill_ids
  const skillIds = [...new Set(
    snap.docs.map(d => d.data().skill_id).filter(Boolean)
  )];

  const skillMeta = {};
  if (skillIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < skillIds.length; i += 10) {
      chunks.push(skillIds.slice(i, i + 10));
    }
    const metaSnaps = await Promise.all(
      chunks.map(chunk => supabase.from('skills').select('*').in('skill_id', chunk).then(({data})=>({ docs: (data||[]).map(r=>({data:()=>r})) })))
    );
    metaSnaps.forEach(s =>
      s.docs.forEach(d => { skillMeta[d.data().skill_id] = d.data(); })
    );
  }

  return snap.docs.map(d => {
    const data = d.data();
    const meta = skillMeta[data.skill_id] ?? {};
    return {
      skill_id:         data.skill_id,
      skill_name:       meta.skill_name  ?? data.skill_name  ?? data.skill_id,
      skill_category:   meta.skill_category ?? data.skill_category ?? 'technical',
      difficulty_level: Number(meta.difficulty_level ?? data.difficulty_level ?? 2),
      demand_score:     Number(meta.demand_score     ?? data.demand_score     ?? 5),
      importance_weight: Number(data.importance_weight ?? 1),
    };
  });
}

/**
 * Fetch prerequisite chain for a skill from skill_relationships.
 * Uses BFS over "prerequisite" edges: skill_id IS A PREREQUISITE OF related_skill_id.
 * Returns ordered list: foundations first → target last.
 */
async function fetchPrerequisiteChain(targetSkillId, userSkillSet) {
  const visited   = new Set([targetSkillId]);
  const prereqs   = [];
  const queue     = [targetSkillId];

  while (queue.length > 0) {
    const current = queue.shift();

    const { data: _srdata } = await supabase.from('skill_relationships').select('*').eq('related_skill_id', current).eq('relationship_type', 'prerequisite');
    const snap = { docs: (_srdata||[]).map(r=>({data:()=>r})) };

    for (const doc of snap.docs) {
      const prereqId = doc.data().skill_id;
      if (!prereqId || visited.has(prereqId)) continue;

      visited.add(prereqId);

      // Only include if the user doesn't already have it
      if (!userSkillSet.has(prereqId)) {
        prereqs.unshift(prereqId); // foundations go first
      }

      queue.push(prereqId);
    }
  }

  return prereqs;
}

/**
 * Fetch skill metadata for an array of skill IDs in one batched query.
 */
async function fetchSkillMeta(skillIds) {
  if (!skillIds || skillIds.length === 0) return {};

  const unique = [...new Set(skillIds)];
  const meta   = {};
  const chunks = [];
  for (let i = 0; i < unique.length; i += 10) chunks.push(unique.slice(i, i + 10));

  const snaps = await Promise.all(
    chunks.map(chunk => supabase.from('skills').select('*').in('skill_id', chunk).then(({data})=>({ docs: (data||[]).map(r=>({data:()=>r})) })))
  );
  snaps.forEach(s =>
    s.docs.forEach(d => { meta[d.data().skill_id] = d.data(); })
  );

  // Also try doc-ID lookup for any still missing
  const missing = unique.filter(id => !meta[id]);
  if (missing.length > 0) {
    await Promise.all(missing.map(async id => {
      const { data: _sd } = await supabase.from('skills').select('*').eq('id', id).maybeSingle();
      const doc = { exists: !!_sd, data: () => _sd };
      if (doc.exists) meta[id] = doc.data();
    }));
  }

  return meta;
}

// ─── Priority Categorisation ──────────────────────────────────────────────────

function categorizePriority(importanceWeight) {
  if (importanceWeight >= PRIORITY.HIGH.minWeight)   return 'high_priority';
  if (importanceWeight >= PRIORITY.MEDIUM.minWeight) return 'medium_priority';
  return 'low_priority';
}

// ─── Learning Path Builder ────────────────────────────────────────────────────

/**
 * Build a deduplicated, ordered global learning plan across all missing skills.
 * Prerequisites appear before the skills that depend on them.
 * Steps the user already has are excluded.
 */
async function buildLearningPath(missingSkills, userSkillSet) {
  if (missingSkills.length === 0) {
    return { steps: [], estimated_weeks: 0, estimated_months: 0 };
  }

  // Process high-priority skills first to anchor the plan
  const sorted = [...missingSkills].sort(
    (a, b) => (b.importance_weight || 0) - (a.importance_weight || 0)
  );

  const globalOrder  = [];  // ordered skill_ids (prerequisites deduplicated)
  const seen         = new Set(userSkillSet); // start with what user has

  for (const skill of sorted) {
    // Fetch prerequisite chain for this missing skill
    const chain = await fetchPrerequisiteChain(skill.skill_id, userSkillSet);

    for (const prereqId of chain) {
      if (!seen.has(prereqId)) {
        globalOrder.push({ skill_id: prereqId, reason: `Prerequisite for ${skill.skill_name}` });
        seen.add(prereqId);
      }
    }

    if (!seen.has(skill.skill_id)) {
      globalOrder.push({ skill_id: skill.skill_id, reason: 'Required skill for target role' });
      seen.add(skill.skill_id);
    }
  }

  // Batch-fetch metadata for all skills in the plan
  const allIds  = globalOrder.map(s => s.skill_id);
  const metaMap = await fetchSkillMeta(allIds);

  const steps = globalOrder.map((entry, i) => {
    const meta      = metaMap[entry.skill_id] ?? {};
    const difficulty = Number(meta.difficulty_level ?? 2);
    const weeks      = WEEKS_BY_DIFFICULTY[difficulty] ?? 4;

    return {
      step:             i + 1,
      skill_id:         entry.skill_id,
      skill_name:       meta.skill_name ?? entry.skill_id,
      skill_category:   meta.skill_category ?? 'technical',
      difficulty_level: difficulty,
      estimated_weeks:  weeks,
      reason:           entry.reason,
    };
  });

  const total_weeks = steps.reduce((s, st) => s + st.estimated_weeks, 0);

  return {
    steps,
    total_skills:     steps.length,
    estimated_weeks:  total_weeks,
    estimated_months: Math.ceil(total_weeks / 4),
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * analyseSkillGap(roleDocId, userSkills) → SkillGapResult
 *
 * @param {string}   roleDocId   - Resolved Firestore doc ID for target role
 * @param {string[]} userSkills  - User skill names or IDs
 * @returns {Promise<SkillGapResult>}
 */
async function analyseSkillGap(roleDocId, userSkills) {
  const start = Date.now();

  // Build normalised user skill set for O(1) matching
  const userSkillSet = new Set(
    (userSkills || []).map(s => String(s).toLowerCase().trim())
  );

  // 1. Fetch all required skills for the target role
  const requiredSkills = await fetchRoleSkills(roleDocId);

  if (requiredSkills.length === 0) {
    logger.warn('[SkillGapEngine] No skills found for role', { roleDocId });
    return {
      high_priority:   [],
      medium_priority: [],
      low_priority:    [],
      matched_skills:  [],
      missing_skills:  [],
      skill_coverage_pct: 0,
      learning_path:   { steps: [], estimated_weeks: 0, estimated_months: 0 },
      total_required:  0,
      total_missing:   0,
      total_matched:   0,
    };
  }

  // 2. Detect gaps — split into matched vs missing
  const matched = [];
  const missing = [];

  for (const skill of requiredSkills) {
    const normId   = skill.skill_id.toLowerCase().trim();
    const normName = skill.skill_name.toLowerCase().trim();
    const hasSkill = userSkillSet.has(normId) || userSkillSet.has(normName);

    if (hasSkill) matched.push(skill);
    else          missing.push(skill);
  }

  // 3. Prioritise missing skills by importance_weight
  const high_priority   = [];
  const medium_priority = [];
  const low_priority    = [];

  const sortedMissing = [...missing].sort(
    (a, b) => (b.importance_weight || 0) - (a.importance_weight || 0)
  );

  for (const skill of sortedMissing) {
    const bucket = categorizePriority(skill.importance_weight);
    if      (bucket === 'high_priority')   high_priority.push(skill);
    else if (bucket === 'medium_priority') medium_priority.push(skill);
    else                                   low_priority.push(skill);
  }

  // 4. Build learning path through prerequisite graph
  const learning_path = await buildLearningPath(sortedMissing, userSkillSet);

  const skill_coverage_pct = requiredSkills.length > 0
    ? Math.round((matched.length / requiredSkills.length) * 100)
    : 0;

  logger.debug('[SkillGapEngine] Analysis complete', {
    roleDocId,
    total_required: requiredSkills.length,
    total_missing:  missing.length,
    elapsed_ms:     Date.now() - start,
  });

  return {
    high_priority:    high_priority.map(s => ({ skill_id: s.skill_id, skill_name: s.skill_name, importance_weight: s.importance_weight, skill_category: s.skill_category })),
    medium_priority:  medium_priority.map(s => ({ skill_id: s.skill_id, skill_name: s.skill_name, importance_weight: s.importance_weight, skill_category: s.skill_category })),
    low_priority:     low_priority.map(s => ({ skill_id: s.skill_id, skill_name: s.skill_name, importance_weight: s.importance_weight, skill_category: s.skill_category })),
    matched_skills:   matched.map(s => ({ skill_id: s.skill_id, skill_name: s.skill_name })),
    missing_skills:   sortedMissing.map(s => ({ skill_id: s.skill_id, skill_name: s.skill_name, importance_weight: s.importance_weight })),
    skill_coverage_pct,
    learning_path,
    total_required: requiredSkills.length,
    total_missing:  missing.length,
    total_matched:  matched.length,
  };
}

module.exports = {
  analyseSkillGap,
  fetchRoleSkills,
  buildLearningPath,
  categorizePriority,
  PRIORITY,
};