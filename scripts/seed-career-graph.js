#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL?.trim(),
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  graphDataDir:
    process.env.GRAPH_DATA_DIR?.trim() ||
    path.resolve(process.cwd(), 'src', 'data', 'career-graph'),
  chunkSize: Math.max(
    1,
    Number.parseInt(process.env.SEED_CHUNK_SIZE || '500', 10)
  ),
  dryRun: process.argv.includes('--dry-run'),
  rollback: process.argv.includes('--rollback'),
};

function log(level, message, meta = null) {
  const ts     = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  const fn     = level === 'error' ? console.error
               : level === 'warn'  ? console.warn
               : console.log;
  fn(`[${ts}] [${level.toUpperCase()}] ${message}${suffix}`);
}

function validateEnv() {
  const missing = [];
  if (!CONFIG.supabaseUrl) missing.push('SUPABASE_URL');
  if (!CONFIG.supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

function buildClient() {
  return createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function toSlug(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function discoverRoleFiles(dir) {
  const files = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        entry.name !== 'skills_registry.json' &&
        entry.name !== 'role_transitions.json'
      ) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function batchUpsert(supabase, table, rows, conflictCols) {
  const stats = { attempted: rows.length, upserted: 0, errorCount: 0 };

  if (!rows.length) {
    log('info', `[${table}] No rows — skipping`);
    return stats;
  }

  const batches = chunk(rows, CONFIG.chunkSize);
  log('info', `[${table}] Upserting ${rows.length} rows in ${batches.length} batch(es)`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    if (CONFIG.dryRun) {
      log('info', `[DRY-RUN] [${table}] Batch ${i + 1}/${batches.length}`, { rows: batch.length });
      stats.upserted += batch.length;
      continue;
    }

    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: conflictCols.join(',') });

    if (error) {
      stats.errorCount++;
      log('error', `[${table}] Batch ${i + 1}/${batches.length} FAILED`, {
        code   : error.code,
        message: error.message,
        details: error.details,
        hint   : error.hint,
        sample : batch.slice(0, 2),
      });
    } else {
      stats.upserted += batch.length;
      log('info', `[${table}] Batch ${i + 1}/${batches.length} OK — ${batch.length} rows`);
    }
  }

  return stats;
}

async function rollback(supabase) {
  // FK-safe order: junction + edges first, then root nodes
  const ordered = [
    { table: 'career_role_skills',      pk: 'id'       },
    { table: 'career_role_transitions', pk: 'id'       },
    { table: 'career_roles',            pk: 'role_id'  },
    { table: 'career_skills_registry',  pk: 'skill_id' },
  ];

  log('warn', 'ROLLBACK MODE — deleting all rows from career graph tables');

  for (const { table, pk } of ordered) {
    log('info', `Clearing ${table}…`);
    const { error } = await supabase.from(table).delete().not(pk, 'is', null);
    if (error) {
      log('error', `Failed to clear ${table}`, { code: error.code, message: error.message });
    } else {
      log('info', `${table} cleared ✓`);
    }
  }

  log('info', 'Rollback complete');
}

async function main() {
  validateEnv();

  const supabase = buildClient();

  if (CONFIG.rollback) {
    await rollback(supabase);
    log('info', 'rollback complete');
    return;
  }

  // ── Phase 1: Skills Registry ──────────────────────────────────────────────
  log('info', '── Phase 1: Skills Registry ──');

  const VALID_SKILL_CATEGORIES = new Set(['technical','soft','domain','tool','certification','language','other']);

  const skillsPath    = path.join(CONFIG.graphDataDir, 'skills_registry.json');
  const skillRows     = [];
  const knownSkillIds = new Set();

  if (!fs.existsSync(skillsPath)) {
    log('warn', `skills_registry.json not found at ${skillsPath} — skills phase skipped`);
  } else {
    // Read ONCE — avoid the double-parse bug from previous version
    const rawSkillsFile = safeReadJson(skillsPath);
    const rawSkills = Array.isArray(rawSkillsFile)
      ? rawSkillsFile
      : Array.isArray(rawSkillsFile?.skills)
        ? rawSkillsFile.skills
        : [];

    log('info', `Skills file: ${rawSkills.length} raw entries`);
    let skipped = 0;
    const skillMap = new Map();

    for (const raw of rawSkills) {
      const skillName = raw?.skill_name?.trim?.();
      if (!skillName) { skipped++; continue; }

      const skillId = (typeof raw.skill_id === 'string' && raw.skill_id.trim())
        ? raw.skill_id.trim()
        : toSlug(skillName);
      if (!skillId) { skipped++; continue; }

      const rawCat       = typeof raw.skill_category === 'string' ? raw.skill_category.trim().toLowerCase() : '';
      const skill_category = VALID_SKILL_CATEGORIES.has(rawCat) ? rawCat : 'other';

      const difficulty_level = (() => { const v = parseFloat(raw.difficulty_level); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 50; })();
      const demand_score     = (() => { const v = parseFloat(raw.demand_score);     return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0;  })();

      skillMap.set(skillId, {
        skill_id         : skillId,
        skill_name       : skillName,
        normalized_name  : toSlug(skillName) || skillName.toLowerCase(),
        aliases          : Array.isArray(raw.aliases)          ? raw.aliases          : [],
        skill_category,
        skill_subcategory: typeof raw.skill_subcategory === 'string' && raw.skill_subcategory.trim()
                           ? raw.skill_subcategory.trim() : null,
        difficulty_level,
        demand_score,
        is_emerging      : raw.is_emerging   === true,
        is_deprecated    : raw.is_deprecated === true,
        adjacent_skills  : Array.isArray(raw.adjacent_skills) ? raw.adjacent_skills : [],
        source           : typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'career-graph-seed',
        soft_deleted     : false,
      });
      knownSkillIds.add(skillId);
    }

    skillRows.push(...skillMap.values());
    log('info', `Skills: ${skillRows.length} valid, ${skipped} skipped`);
  }

  // ── Phase 2: Roles ────────────────────────────────────────────────────────
  log('info', '── Phase 2: Roles ──');

  // Live career_roles columns (confirmed via information_schema):
  //   role_id, role_name, normalized_name, alternative_titles (text[]),
  //   role_family, track, seniority_level, seniority_rank (int),
  //   salary_data (jsonb), education_requirements (jsonb), demand_score,
  //   is_active, source, soft_deleted, version (int)

  const roleFiles = discoverRoleFiles(CONFIG.graphDataDir);
  log('info', `Discovered ${roleFiles.length} role file(s)`);

  const roleMap      = new Map();  // role_id → row (last-write-wins dedup)
  const roleSkillMap = new Map();  // `${role_id}:${skill_id}` → row (dedup)
  let   rolesSkipped = 0;

  const VALID_IMPORTANCE  = new Set(['required','preferred','nice_to_have']);
  const VALID_PROFICIENCY = new Set(['beginner','intermediate','advanced','expert']);

  for (const file of roleFiles) {
    const rawFile = safeReadJson(file);
    if (!rawFile) { rolesSkipped++; continue; }

    const entries = Array.isArray(rawFile) ? rawFile : [rawFile];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { rolesSkipped++; continue; }

      // role_name: prefer role_name, fall back to title
      const role_name = typeof entry.role_name === 'string' && entry.role_name.trim()
        ? entry.role_name.trim()
        : typeof entry.title === 'string' && entry.title.trim()
          ? entry.title.trim()
          : null;
      if (!role_name) { rolesSkipped++; continue; }

      const role_id = typeof entry.role_id === 'string' && entry.role_id.trim()
        ? entry.role_id.trim()
        : toSlug(role_name);
      if (!role_id) { rolesSkipped++; continue; }

      const normalized_name = toSlug(role_name) || role_name.toLowerCase();

      const alternative_titles = Array.isArray(entry.alternative_titles)
        ? entry.alternative_titles.filter(t => typeof t === 'string')
        : [];

      const role_family = typeof entry.role_family === 'string' && entry.role_family.trim()
        ? entry.role_family.trim()
        : (() => {
            const rel   = path.relative(CONFIG.graphDataDir, path.dirname(file));
            const first = rel.split(path.sep)[0];
            return first && first !== '.' ? first : 'general';
          })();

      const track = typeof entry.track === 'string' && entry.track.trim()
        ? entry.track.trim()
        : null;

      const seniority_level = typeof entry.seniority_level === 'string' && entry.seniority_level.trim()
        ? entry.seniority_level.trim()
        : typeof entry.career_level === 'string' && entry.career_level.trim()
          ? entry.career_level.trim()
          : null;

      const seniority_rank = (() => {
        const v = Number.parseInt(entry.seniority_rank ?? entry.level_order, 10);
        return Number.isFinite(v) ? v : 0;
      })();

      const salary_data = (() => {
        const s   = (entry.salary     && typeof entry.salary     === 'object' && !Array.isArray(entry.salary))     ? entry.salary     : null;
        const usd = (entry.salary_usd && typeof entry.salary_usd === 'object' && !Array.isArray(entry.salary_usd)) ? entry.salary_usd : null;
        if (s || usd) return { ...(s ? { inr: s } : {}), ...(usd ? { usd } : {}) };
        return {};
      })();

      const education_requirements = (entry.education_requirements && typeof entry.education_requirements === 'object' && !Array.isArray(entry.education_requirements))
        ? entry.education_requirements
        : {};

      const demand_score = (() => {
        const v = parseFloat(entry.demand_score);
        return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0;
      })();

      const is_active = entry.is_active === false ? false : true;

      const required_skills  = Array.isArray(entry.required_skills)  ? entry.required_skills  : [];
      const preferred_skills = Array.isArray(entry.preferred_skills) ? entry.preferred_skills : [];

      // ── confirmed live columns only ───────────────────────────────────────
      roleMap.set(role_id, {
        role_id,
        role_name,
        normalized_name,
        alternative_titles,
        role_family,
        track,
        seniority_level,
        seniority_rank,
        salary_data,
        education_requirements,
        demand_score,
        is_active,
        source      : 'career-graph-seed',
        soft_deleted: false,
        version     : 1,
      });

      // Build career_role_skills join rows
      const allSkills = [
        ...required_skills.map(s => ({ id: s, importance: 'required' })),
        ...preferred_skills.map(s => ({ id: s, importance: 'preferred' })),
      ];

      for (const { id: skillEntry, importance: defaultImportance } of allSkills) {
        let skillId, importance, proficiency_level, years_required;

        if (typeof skillEntry === 'string') {
          skillId = skillEntry.trim();
          importance = defaultImportance;
          proficiency_level = null;
          years_required = null;
        } else if (skillEntry && typeof skillEntry === 'object') {
          skillId = typeof skillEntry.skill_id === 'string' ? skillEntry.skill_id.trim() : toSlug(skillEntry.skill_name || '');
          importance = VALID_IMPORTANCE.has(skillEntry.importance) ? skillEntry.importance : defaultImportance;
          proficiency_level = VALID_PROFICIENCY.has(skillEntry.proficiency_level) ? skillEntry.proficiency_level : null;
          const v = parseFloat(skillEntry.years_required);
          years_required = Number.isFinite(v) && v >= 0 ? v : null;
        } else {
          continue;
        }

        if (!skillId || !knownSkillIds.has(skillId)) continue;

        const rsKey = `${role_id}:${skillId}`;
        if (!roleSkillMap.has(rsKey)) {
          roleSkillMap.set(rsKey, { role_id, skill_id: skillId, importance, proficiency_level, years_required });
        }
      }
    }
  }

  const roleRows      = [...roleMap.values()];
  const roleSkillRows = [...roleSkillMap.values()];
  log('info', `Roles: ${roleRows.length} valid, ${rolesSkipped} skipped`);
  log('info', `Role-skill join rows: ${roleSkillRows.length}`);

  // ── Phase 3: Transitions ──────────────────────────────────────────────────
  log('info', '── Phase 3: Transitions ──');

  // Build set of role_ids that were actually seeded — used for FK-safe transition filtering
  const seededRoleIds = new Set(roleRows.map(r => r.role_id));

  const VALID_TRANSITION_TYPES = new Set(['progression','lateral','pivot','promotion','specialization']);
  const VALID_CONFIDENCE       = new Set(['low','medium','high']);

  const transitionsPath = path.join(CONFIG.graphDataDir, 'role_transitions.json');
  const transitionRows  = [];

  if (!fs.existsSync(transitionsPath)) {
    log('warn', `role_transitions.json not found at ${transitionsPath} — transitions phase skipped`);
  } else {
    const rawTxFile = safeReadJson(transitionsPath);
    const rawTransitions = Array.isArray(rawTxFile)
      ? rawTxFile
      : Array.isArray(rawTxFile?.transitions)
        ? rawTxFile.transitions
        : [];

    log('info', `Transitions file: ${rawTransitions.length} raw entries`);
    let txSkipped = 0;
    const txMap   = new Map();  // `from:to` → row

    for (const raw of rawTransitions) {
      if (!raw || typeof raw !== 'object') { txSkipped++; continue; }

      const from_role_id = typeof raw.from_role_id === 'string' ? raw.from_role_id.trim() : null;
      const to_role_id   = typeof raw.to_role_id   === 'string' ? raw.to_role_id.trim()   : null;
      if (!from_role_id || !to_role_id || from_role_id === to_role_id) { txSkipped++; continue; }

      const key = `${from_role_id}:${to_role_id}`;
      if (txMap.has(key)) continue;  // first-write-wins dedup

      const rawType      = typeof raw.transition_type  === 'string' ? raw.transition_type.trim().toLowerCase()  : '';
      const rawConf      = typeof raw.data_confidence  === 'string' ? raw.data_confidence.trim().toLowerCase()  : '';

      const avg_transition_years = (() => {
        // avg_transition_years is the live column name; accept legacy years_required as source value only
        const v = parseFloat(raw.avg_transition_years ?? raw.years_required);
        return Number.isFinite(v) && v >= 0 ? v : null;
      })();

      const median_salary_delta_lpa = (() => {
        const v = parseFloat(raw.median_salary_delta_lpa);
        return Number.isFinite(v) ? v : null;
      })();

      // confirmed live columns — no probability, no years_required as column
      txMap.set(key, {
        from_role_id,
        to_role_id,
        transition_type        : VALID_TRANSITION_TYPES.has(rawType) ? rawType : 'progression',
        avg_transition_years,
        difficulty_score       : (() => { const v = parseFloat(raw.difficulty_score); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 50; })(),
        demand_score           : (() => { const v = parseFloat(raw.demand_score);     return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0;  })(),
        required_skills        : Array.isArray(raw.required_skills)  ? raw.required_skills  : [],
        bridging_skills        : Array.isArray(raw.bridging_skills)   ? raw.bridging_skills   : [],
        median_salary_delta_lpa,
        typical_companies      : Array.isArray(raw.typical_companies) ? raw.typical_companies : [],
        data_confidence        : VALID_CONFIDENCE.has(rawConf) ? rawConf : 'low',
        sample_size            : (() => { const v = Number.parseInt(raw.sample_size, 10); return Number.isFinite(v) && v >= 0 ? v : 0; })(),
        source                 : typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'career-graph-seed',
        soft_deleted           : false,
      });
    }

    // ── FK safety: drop any transition whose from/to role wasn't seeded ────────
    let txFkSkipped = 0;
    for (const row of txMap.values()) {
      if (!seededRoleIds.has(row.from_role_id) || !seededRoleIds.has(row.to_role_id)) {
        txFkSkipped++;
        log('warn', `[transitions] Skipping orphaned transition — role(s) not in seeded set`, {
          from_role_id: row.from_role_id,
          to_role_id  : row.to_role_id,
        });
        continue;
      }
      transitionRows.push(row);
    }
    log('info', `Transitions: ${transitionRows.length} valid, ${txSkipped} skipped, ${txFkSkipped} orphaned (FK-safe filtered)`);
  }

  log('info', '── Phase 4: Upsert ──');
  if (CONFIG.dryRun) log('info', '[DRY-RUN] No database writes will occur');

  const t0 = Date.now();

  // FK-safe order: roots first, then edges, then junction
  const s1 = await batchUpsert(supabase, 'career_skills_registry',  [...new Map(skillRows.map((r) => [r.skill_id, r])).values()],                                         ['skill_id']);
  const s2 = await batchUpsert(supabase, 'career_roles',            roleRows,                                                                                              ['role_id']);
  const s3 = await batchUpsert(supabase, 'career_role_transitions', transitionRows,                                                                                        ['from_role_id', 'to_role_id']);
  const s4 = await batchUpsert(supabase, 'career_role_skills',      [...new Map(roleSkillRows.map((r) => [`${r.role_id}:${r.skill_id}`, r])).values()],                    ['role_id', 'skill_id']);

  const totalErrors = s1.errorCount + s2.errorCount + s3.errorCount + s4.errorCount;
  const elapsed     = ((Date.now() - t0) / 1000).toFixed(2);

  log('info', '═══ Seed Summary ═══', {
    mode       : CONFIG.dryRun ? 'DRY-RUN' : 'LIVE',
    elapsed    : `${elapsed}s`,
    skills     : { attempted: s1.attempted, upserted: s1.upserted, errors: s1.errorCount },
    roles      : { attempted: s2.attempted, upserted: s2.upserted, errors: s2.errorCount },
    transitions: { attempted: s3.attempted, upserted: s3.upserted, errors: s3.errorCount },
    roleSkills : { attempted: s4.attempted, upserted: s4.upserted, errors: s4.errorCount },
    totalErrors,
  });

  if (totalErrors > 0) {
    log('warn', `Completed with ${totalErrors} batch error(s). Review logs above.`);
    process.exit(2);
  }

  log('info', 'Career graph seed complete ✓');
  process.exit(0);
}

main().catch((error) => {
  log('error', 'seed failed', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});