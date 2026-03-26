'use strict';

/**
 * careerPathEngine.js — Career Path Recommendation Engine (CHI v2 adapter)
 *
 * ARCHITECTURE NOTE: The standalone engine lives at /engines/career-path.engine.js
 * and is exposed via POST /api/v1/career-path/predict.
 * This file retains Firestore BFS logic for CHI internal use.
 *
 * Finds the optimal career progression path from current_role to target_role
 * using BFS over the role_transitions Firestore graph. Returns the full path
 * with per-step timeline, required skills, and next-role recommendations.
 *
 * Data sources (all read-only Firestore):
 *   roles             — role metadata
 *   role_transitions  — graph edges (from_role_id, to_role_id, years_required, probability)
 *   role_skills       — required skills per step
 *
 * Reuses bfsCareerPath from chiV2.engine to avoid duplicating BFS logic.
 *
 * Public API:
 *   recommendCareerPath(currentRoleId, targetRoleId) → CareerPathResult
 *
 * SECURITY: Read-only. No writes. No auth mutations.
 */

const { db }                = require('../../config/supabase');
const { bfsCareerPath }     = require('./chiV2.engine');
const { predictCareerPath } = require('../../engines/career-path.engine');
const logger                = require('../../utils/logger');

// ─── Role Metadata Helpers ────────────────────────────────────────────────────

/**
 * Fetch role metadata for an array of role doc IDs in parallel.
 * Returns a map: roleDocId → roleData
 */
async function fetchRoleMeta(roleIds) {
  if (!roleIds || roleIds.length === 0) return {};

  const docs = await Promise.all(
    roleIds.map(id => db.collection('roles').doc(id).get())
  );

  const meta = {};
  docs.forEach((doc, i) => {
    if (doc.exists) meta[roleIds[i]] = { id: doc.id, ...doc.data() };
    else            meta[roleIds[i]] = { id: roleIds[i], role_name: roleIds[i] };
  });

  return meta;
}

/**
 * Fetch the transition document between two adjacent roles.
 * Returns transition metadata: years_required, probability, transition_type.
 */
async function fetchTransition(fromRoleId, toRoleId) {
  const snap = await db.collection('role_transitions')
    .where('from_role_id', '==', fromRoleId)
    .where('to_role_id',   '==', toRoleId)
    .limit(1)
    .get();

  if (snap.empty) return { years_required: 2, probability: null, transition_type: null };

  const data = snap.docs[0].data();
  return {
    years_required:  Number(data.years_required)  || 2,
    probability:     data.probability             ?? null,
    transition_type: data.transition_type         ?? null,
  };
}

/**
 * Fetch required skills for a role, returning concise name list.
 */
async function fetchRoleSkillNames(roleDocId, limit = 10) {
  const snap = await db.collection('role_skills')
    .where('role_id', '==', roleDocId)
    .get();

  if (snap.empty) return [];

  const records = snap.docs
    .map(d => ({
      skill_id:         d.data().skill_id,
      skill_name:       d.data().skill_name ?? d.data().skill_id,
      importance_weight: Number(d.data().importance_weight) || 1,
    }))
    .sort((a, b) => b.importance_weight - a.importance_weight)
    .slice(0, limit);

  // Enrich skill names from skills collection where missing
  const missingNames = records.filter(r => r.skill_name === r.skill_id);
  if (missingNames.length > 0) {
    const ids    = missingNames.map(r => r.skill_id).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

    const snaps = await Promise.all(
      chunks.map(chunk => db.collection('skills').where('skill_id', 'in', chunk).get())
    );
    const nameMap = {};
    snaps.forEach(s => s.docs.forEach(d => { nameMap[d.data().skill_id] = d.data().skill_name; }));

    records.forEach(r => {
      if (nameMap[r.skill_id]) r.skill_name = nameMap[r.skill_id];
    });
  }

  return records;
}

// ─── Path Enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich a BFS path (array of role doc IDs) with:
 *  - Role metadata per step
 *  - Transition metadata between each pair of steps
 *  - Required skills at each step
 *  - Cumulative years
 */
async function enrichPath(pathIds) {
  if (!pathIds || pathIds.length === 0) return [];

  // Parallel: role metadata + transition data for each edge
  const [roleMeta, transitions] = await Promise.all([
    fetchRoleMeta(pathIds),
    Promise.all(
      pathIds.slice(0, -1).map((id, i) => fetchTransition(id, pathIds[i + 1]))
    ),
  ]);

  // Fetch skills for each role in the path (parallel)
  const skillsPerRole = await Promise.all(
    pathIds.map(id => fetchRoleSkillNames(id, 8))
  );

  let cumulativeYears = 0;
  const steps = pathIds.map((roleId, i) => {
    const role       = roleMeta[roleId] ?? { id: roleId, role_name: roleId };
    const transition = i < transitions.length ? transitions[i] : null;

    if (transition) cumulativeYears += transition.years_required || 0;

    return {
      step:           i + 1,
      role_id:        roleId,
      role_name:      role.role_name   ?? roleId,
      role_family:    role.role_family ?? null,
      seniority_level: role.seniority_level ?? null,
      required_skills: skillsPerRole[i] ?? [],
      transition_to_next: transition
        ? {
            years_required:  transition.years_required,
            probability:     transition.probability,
            transition_type: transition.transition_type,
          }
        : null,
      cumulative_years: cumulativeYears,
      is_current_role: i === 0,
      is_target_role:  i === pathIds.length - 1,
    };
  });

  return steps;
}

// ─── Alternate Paths ─────────────────────────────────────────────────────────

/**
 * Find up to `maxAlternatives` alternate paths of depth ≤ shortestSteps + 2.
 * Uses a bounded DFS to avoid excessive Firestore reads.
 */
async function findAlternatePaths(fromId, toId, shortestSteps, maxAlternatives = 2) {
  const maxDepth  = shortestSteps + 2;
  const results   = [];
  const stack     = [{ path: [fromId], visited: new Set([fromId]) }];

  while (stack.length > 0 && results.length < maxAlternatives) {
    const { path, visited } = stack.pop();
    const current           = path[path.length - 1];

    if (path.length > maxDepth + 1) continue;

    const snap = await db.collection('role_transitions')
      .where('from_role_id', '==', current)
      .get();

    for (const doc of snap.docs) {
      const nextId = doc.data().to_role_id;
      if (!nextId || visited.has(nextId)) continue;

      const newPath = [...path, nextId];

      if (nextId === toId && newPath.length - 1 > shortestSteps) {
        results.push(newPath);
        if (results.length >= maxAlternatives) break;
        continue;
      }

      if (newPath.length <= maxDepth) {
        const newVisited = new Set(visited);
        newVisited.add(nextId);
        stack.push({ path: newPath, visited: newVisited });
      }
    }
  }

  return results;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * recommendCareerPath(currentRoleId, targetRoleId) → CareerPathResult
 *
 * @param {string|null} currentRoleId  - Firestore doc ID of current role (null = skip path)
 * @param {string}      targetRoleId   - Firestore doc ID of target role
 * @returns {Promise<CareerPathResult>}
 */
async function recommendCareerPath(currentRoleId, targetRoleId) {
  const start = Date.now();

  // ── Case: no current role — just return target role info ──────────────────
  if (!currentRoleId) {
    const targetSkills = await fetchRoleSkillNames(targetRoleId, 10);
    const targetMeta   = await fetchRoleMeta([targetRoleId]);
    const target       = targetMeta[targetRoleId];

    return {
      found:           false,
      career_path:     [],
      role_names:      [target?.role_name ?? targetRoleId],
      steps:           0,
      estimated_years: 0,
      next_role:       null,
      next_role_skills: targetSkills,
      alternate_paths: [],
      message:         'No current role provided — showing target role requirements only',
    };
  }

  // ── Case: already in target role ─────────────────────────────────────────
  if (currentRoleId === targetRoleId) {
    const targetSkills = await fetchRoleSkillNames(targetRoleId, 10);
    return {
      found:           true,
      career_path:     [],
      role_names:      [],
      steps:           0,
      estimated_years: 0,
      next_role:       null,
      next_role_skills: targetSkills,
      alternate_paths: [],
      message:         'You are already in the target role',
    };
  }

  // ── BFS: find shortest path ───────────────────────────────────────────────
  const bfsResult = await bfsCareerPath(currentRoleId, targetRoleId);

  if (!bfsResult.found) {
    logger.info('[CareerPathEngine] No path found', { currentRoleId, targetRoleId });
    return {
      found:           false,
      career_path:     [],
      role_names:      [],
      steps:           0,
      estimated_years: 0,
      next_role:       null,
      next_role_skills: [],
      alternate_paths: [],
      message:         'No career path found between these roles in the graph — data may be incomplete',
    };
  }

  // ── Enrich primary path ───────────────────────────────────────────────────
  const enrichedSteps = await enrichPath(bfsResult.path);

  const totalYears = enrichedSteps.reduce((sum, step) => {
    return sum + (step.transition_to_next?.years_required ?? 0);
  }, 0);

  // ── Next role recommendation ──────────────────────────────────────────────
  const nextStep       = enrichedSteps[1] ?? null; // index 1 = first move
  const nextRoleSkills = nextStep ? await fetchRoleSkillNames(nextStep.role_id, 8) : [];

  // ── Alternate paths (bounded — max 2) ────────────────────────────────────
  const alternatePaths = [];
  try {
    const altRaw = await findAlternatePaths(
      currentRoleId, targetRoleId, bfsResult.steps, 2
    );
    for (const altPath of altRaw) {
      const altSteps = await enrichPath(altPath);
      const altYears = altSteps.reduce((s, st) => s + (st.transition_to_next?.years_required ?? 0), 0);
      alternatePaths.push({
        role_names:      altSteps.map(s => s.role_name),
        steps:           altPath.length - 1,
        estimated_years: altYears,
      });
    }
  } catch (err) {
    // Alternate paths are best-effort — never fail the main response
    logger.warn('[CareerPathEngine] Alternate path search failed', { err: err.message });
  }

  logger.info('[CareerPathEngine] Path found', {
    steps: bfsResult.steps,
    estimated_years: totalYears,
    elapsed_ms: Date.now() - start,
  });

  // ── CSV-based prediction enrichment (standalone engine) ─────────────────
  // Appended to the result so callers get both Firestore BFS path (accurate
  // when role graph is seeded) AND CSV-based prediction (always available).
  let csvPrediction = null;
  try {
    const firstRoleName = enrichedSteps[0]?.role_name;
    if (firstRoleName) {
      csvPrediction = await predictCareerPath({ role: firstRoleName });
    }
  } catch (err) {
    logger.warn('[CareerPathEngine] CSV enrichment failed (non-fatal)', { err: err.message });
  }

  return {
    found:           true,
    career_path:     enrichedSteps,
    role_names:      enrichedSteps.map(s => s.role_name),
    steps:           bfsResult.steps,
    estimated_years: totalYears,
    next_role:       nextStep
      ? { role_id: nextStep.role_id, role_name: nextStep.role_name }
      : null,
    next_role_skills: nextRoleSkills,
    alternate_paths: alternatePaths,
    message:         null,
    // CSV-based prediction from standalone engine (always populated)
    career_path_prediction: csvPrediction,
  };
}

module.exports = {
  recommendCareerPath,
  fetchRoleMeta,
  fetchRoleSkillNames,
  enrichPath,
};








