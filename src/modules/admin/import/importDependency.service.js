'use strict';

/**
 * importDependency.service.js — Import Order Validation (Supabase)
 * MIGRATED: Firestore collection counts → Supabase cms_* table counts
 * Same interface — adminImport.service.js needs no changes.
 */

const { AppError } = require('../../../middleware/errorHandler');
const logger       = require('../../../utils/logger');

function getSupabase() { return require('../../../core/supabaseClient'); }

const TABLES = {
  careerDomains:    'cms_career_domains',
  jobFamilies:      'cms_job_families',
  skillClusters:    'cms_skill_clusters',
  skills:           'cms_skills',
  roles:            'cms_roles',
  educationLevels:  'cms_education_levels',
  salaryBenchmarks: 'cms_salary_benchmarks',
};

const IMPORT_STEPS = [
  { step: 1, datasetType: 'careerDomains',    label: 'Career Domains',    deps: [] },
  { step: 2, datasetType: 'jobFamilies',       label: 'Job Families',       deps: [{ datasetType: 'careerDomains',   label: 'Career Domains',  table: TABLES.careerDomains,  message: 'Career Domains must be imported before Job Families.' }] },
  { step: 3, datasetType: 'skillClusters',     label: 'Skill Clusters',     deps: [{ datasetType: 'careerDomains',   label: 'Career Domains',  table: TABLES.careerDomains,  message: 'Career Domains must be imported before Skill Clusters.' }] },
  { step: 4, datasetType: 'skills',            label: 'Skills',             deps: [{ datasetType: 'skillClusters',   label: 'Skill Clusters',  table: TABLES.skillClusters,  message: 'Skill Clusters must be imported before Skills.' }] },
  { step: 5, datasetType: 'roles',             label: 'Roles',              deps: [{ datasetType: 'jobFamilies',     label: 'Job Families',    table: TABLES.jobFamilies,    message: 'Job Families must be imported before Roles.' }] },
  { step: null, datasetType: 'educationLevels',  label: 'Education Levels',  deps: [] },
  { step: null, datasetType: 'salaryBenchmarks', label: 'Salary Benchmarks', deps: [] },
];

const STEP_MAP = new Map(IMPORT_STEPS.map(s => [s.datasetType, s]));

async function _countActive(tableName) {
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from(tableName)
      .select('id', { count: 'exact', head: true })
      .eq('soft_deleted', false);
    if (error) throw new Error(error.message);
    return count ?? 0;
  } catch (err) {
    logger.warn(`[ImportDep] count failed for ${tableName}`, { error: err.message });
    return 0;
  }
}

async function checkDependencies(datasetType) {
  // skill-demand and role-skills go to Supabase directly — no dep checks needed
  if (datasetType === 'skillDemand' || datasetType === 'roleSkills') return;

  const stepConfig = STEP_MAP.get(datasetType);
  if (!stepConfig || stepConfig.deps.length === 0) return;

  const unmetDeps = [];
  for (const dep of stepConfig.deps) {
    const count = await _countActive(dep.table);
    if (count === 0) {
      unmetDeps.push(dep);
      logger.warn('[ImportDep] Dependency not met', { importing: datasetType, requires: dep.datasetType, count });
    }
  }

  if (unmetDeps.length > 0) {
    throw new AppError(
      unmetDeps[0].message,
      422,
      {
        importing: datasetType,
        unmetDeps: unmetDeps.map(d => ({ requires: d.datasetType, label: d.label, table: d.table, message: d.message })),
        hint: `Import in this order: ${IMPORT_STEPS.filter(s => s.step).map(s => s.label).join(' → ')}`,
      },
      'DEPENDENCY_NOT_MET'
    );
  }
}

async function getImportStatus() {
  const orderedSteps = IMPORT_STEPS.filter(s => s.step !== null);
  const counts = await Promise.all(orderedSteps.map(s => _countActive(TABLES[s.datasetType])));

  return orderedSteps.map((s, i) => ({
    step:        s.step,
    datasetType: s.datasetType,
    label:       s.label,
    count:       counts[i],
    completed:   counts[i] > 0,
    deps:        s.deps.map(d => d.label),
    depsUnmet:   s.deps.some(dep => {
      const depStep = orderedSteps.find(os => os.datasetType === dep.datasetType);
      if (!depStep) return false;
      return counts[orderedSteps.indexOf(depStep)] === 0;
    }),
  }));
}

function getNextStep(datasetType) {
  const orderedSteps = IMPORT_STEPS.filter(s => s.step !== null);
  const current = orderedSteps.find(s => s.datasetType === datasetType);
  if (!current) return null;
  const next = orderedSteps.find(s => s.step === current.step + 1);
  return next ? next.label : null;
}

module.exports = { checkDependencies, getImportStatus, getNextStep, IMPORT_STEPS, COLLECTIONS: TABLES };








