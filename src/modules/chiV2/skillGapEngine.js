'use strict';

/**
 * skillGapEngine.js
 *
 * Fully Supabase-native production version.
 * Removes all Firestore snapshot shims and legacy assumptions.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY = Object.freeze({
  HIGH: { label: 'high_priority', minWeight: 0.7 },
  MEDIUM: { label: 'medium_priority', minWeight: 0.35 },
  LOW: { label: 'low_priority', minWeight: 0 }
});

const WEEKS_BY_DIFFICULTY = Object.freeze({
  1: 2,
  2: 4,
  3: 6,
  4: 10,
  5: 16
});

const SAFE_BATCH_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function chunkArray(items, size = SAFE_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Role Skills
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRoleSkills(roleId) {
  const { data: roleSkills, error } = await supabase
    .from('role_skills')
    .select(
      'skill_id, skill_name, skill_category, difficulty_level, demand_score, importance_weight'
    )
    .eq('role_id', roleId);

  if (error) {
    logger.warn('[SkillGap] role_skills degraded', {
      error: error.message
    });
    return [];
  }

  if (!roleSkills?.length) return [];

  const skillIds = [
    ...new Set(roleSkills.map(row => row.skill_id).filter(Boolean))
  ];

  const skillMeta = await fetchSkillMeta(skillIds);

  return roleSkills.map(row => {
    const meta = skillMeta[row.skill_id] || {};

    return {
      skill_id: row.skill_id,
      skill_name:
        meta.skill_name ??
        row.skill_name ??
        row.skill_id,
      skill_category:
        meta.skill_category ??
        row.skill_category ??
        'technical',
      difficulty_level: Number(
        meta.difficulty_level ??
          row.difficulty_level ??
          2
      ),
      demand_score: Number(
        meta.demand_score ??
          row.demand_score ??
          5
      ),
      importance_weight: Number(
        row.importance_weight ?? 1
      )
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Metadata
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSkillMeta(skillIds) {
  if (!skillIds?.length) return {};

  const uniqueIds = [...new Set(skillIds)];
  const meta = {};

  const results = await Promise.allSettled(
    chunkArray(uniqueIds).map(chunk =>
      supabase
        .from('skills')
        .select(
          'id, skill_id, skill_name, skill_category, difficulty_level, demand_score'
        )
        .in('skill_id', chunk)
    )
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;

    const { data } = result.value;

    for (const row of data || []) {
      meta[row.skill_id] = row;
    }
  }

  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prerequisite BFS (Level Batch Optimized)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPrerequisiteChain(targetSkillId, userSkillSet) {
  const visited = new Set([targetSkillId]);
  const ordered = [];
  let frontier = [targetSkillId];

  while (frontier.length) {
    const { data, error } = await supabase
      .from('skill_relationships')
      .select('skill_id, related_skill_id')
      .in('related_skill_id', frontier)
      .eq('relationship_type', 'prerequisite');

    if (error) {
      logger.warn('[SkillGap] prerequisite BFS degraded', {
        error: error.message
      });
      break;
    }

    const nextFrontier = [];

    for (const row of data || []) {
      const prereqId = row.skill_id;
      if (!prereqId || visited.has(prereqId)) continue;

      visited.add(prereqId);

      if (!userSkillSet.has(normalizeText(prereqId))) {
        ordered.unshift(prereqId);
      }

      nextFrontier.push(prereqId);
    }

    frontier = nextFrontier;
  }

  return ordered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority
// ─────────────────────────────────────────────────────────────────────────────

function categorizePriority(weight) {
  if (weight >= PRIORITY.HIGH.minWeight) {
    return PRIORITY.HIGH.label;
  }

  if (weight >= PRIORITY.MEDIUM.minWeight) {
    return PRIORITY.MEDIUM.label;
  }

  return PRIORITY.LOW.label;
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning Path
// ─────────────────────────────────────────────────────────────────────────────

async function buildLearningPath(missingSkills, userSkillSet) {
  if (!missingSkills?.length) {
    return {
      steps: [],
      estimated_weeks: 0,
      estimated_months: 0
    };
  }

  const sorted = [...missingSkills].sort(
    (a, b) =>
      (b.importance_weight || 0) -
      (a.importance_weight || 0)
  );

  const orderedSkills = [];
  const seen = new Set([...userSkillSet]);

  for (const skill of sorted) {
    const chain = await fetchPrerequisiteChain(
      skill.skill_id,
      userSkillSet
    );

    for (const prereqId of chain) {
      const key = normalizeText(prereqId);

      if (!seen.has(key)) {
        orderedSkills.push({
          skill_id: prereqId,
          reason: `Prerequisite for ${skill.skill_name}`
        });
        seen.add(key);
      }
    }

    const currentKey = normalizeText(skill.skill_id);

    if (!seen.has(currentKey)) {
      orderedSkills.push({
        skill_id: skill.skill_id,
        reason: 'Required skill for target role'
      });
      seen.add(currentKey);
    }
  }

  const metaMap = await fetchSkillMeta(
    orderedSkills.map(row => row.skill_id)
  );

  const steps = orderedSkills.map((entry, index) => {
    const meta = metaMap[entry.skill_id] || {};
    const difficulty = Number(
      meta.difficulty_level ?? 2
    );

    const weeks =
      WEEKS_BY_DIFFICULTY[difficulty] ?? 4;

    return {
      step: index + 1,
      skill_id: entry.skill_id,
      skill_name:
        meta.skill_name ?? entry.skill_id,
      skill_category:
        meta.skill_category ?? 'technical',
      difficulty_level: difficulty,
      estimated_weeks: weeks,
      reason: entry.reason
    };
  });

  const totalWeeks = steps.reduce(
    (sum, step) => sum + step.estimated_weeks,
    0
  );

  return {
    steps,
    total_skills: steps.length,
    estimated_weeks: totalWeeks,
    estimated_months: Math.ceil(totalWeeks / 4)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function analyseSkillGap(roleId, userSkills) {
  const start = Date.now();

  const userSkillSet = new Set(
    (userSkills || []).map(skill =>
      normalizeText(skill)
    )
  );

  const requiredSkills = await fetchRoleSkills(roleId);

  if (!requiredSkills.length) {
    logger.warn('[SkillGapEngine] No skills found', {
      roleId
    });

    return {
      high_priority: [],
      medium_priority: [],
      low_priority: [],
      matched_skills: [],
      missing_skills: [],
      skill_coverage_pct: 0,
      learning_path: {
        steps: [],
        estimated_weeks: 0,
        estimated_months: 0
      },
      total_required: 0,
      total_missing: 0,
      total_matched: 0
    };
  }

  const matched = [];
  const missing = [];

  for (const skill of requiredSkills) {
    const hasSkill =
      userSkillSet.has(normalizeText(skill.skill_id)) ||
      userSkillSet.has(normalizeText(skill.skill_name));

    if (hasSkill) matched.push(skill);
    else missing.push(skill);
  }

  const high_priority = [];
  const medium_priority = [];
  const low_priority = [];

  const sortedMissing = [...missing].sort(
    (a, b) =>
      (b.importance_weight || 0) -
      (a.importance_weight || 0)
  );

  for (const skill of sortedMissing) {
    const bucket = categorizePriority(
      skill.importance_weight
    );

    if (bucket === PRIORITY.HIGH.label) {
      high_priority.push(skill);
    } else if (bucket === PRIORITY.MEDIUM.label) {
      medium_priority.push(skill);
    } else {
      low_priority.push(skill);
    }
  }

  const learning_path = await buildLearningPath(
    sortedMissing,
    userSkillSet
  );

  const skill_coverage_pct = Math.round(
    (matched.length / requiredSkills.length) * 100
  );

  logger.debug('[SkillGapEngine] Complete', {
    roleId,
    total_required: requiredSkills.length,
    total_missing: missing.length,
    elapsed_ms: Date.now() - start
  });

  return {
    high_priority: high_priority.map(skill => ({
      skill_id: skill.skill_id,
      skill_name: skill.skill_name,
      importance_weight: skill.importance_weight,
      skill_category: skill.skill_category
    })),

    medium_priority: medium_priority.map(skill => ({
      skill_id: skill.skill_id,
      skill_name: skill.skill_name,
      importance_weight: skill.importance_weight,
      skill_category: skill.skill_category
    })),

    low_priority: low_priority.map(skill => ({
      skill_id: skill.skill_id,
      skill_name: skill.skill_name,
      importance_weight: skill.importance_weight,
      skill_category: skill.skill_category
    })),

    matched_skills: matched.map(skill => ({
      skill_id: skill.skill_id,
      skill_name: skill.skill_name
    })),

    missing_skills: sortedMissing.map(skill => ({
      skill_id: skill.skill_id,
      skill_name: skill.skill_name,
      importance_weight: skill.importance_weight
    })),

    skill_coverage_pct,
    learning_path,
    total_required: requiredSkills.length,
    total_missing: missing.length,
    total_matched: matched.length
  };
}

module.exports = {
  analyseSkillGap,
  fetchRoleSkills,
  buildLearningPath,
  categorizePriority,
  PRIORITY
};