'use strict';

/**
 * importDependency.service.js
 * Supabase-native import dependency validation
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');

const TABLES = {
  careerDomains: 'career_domains',
  jobFamilies: 'job_families',
  skillClusters: 'skill_clusters',
  skills: 'skills',
  roles: 'roles',
  educationLevels: 'education_levels',
  salaryBenchmarks: 'salary_benchmarks',
  skillDemand: 'skill_demand',
  roleSkills: 'role_skills',
};

const IMPORT_STEPS = [
  {
    step: 1,
    datasetType: 'careerDomains',
    label: 'Career Domains',
    deps: [],
  },
  {
    step: 2,
    datasetType: 'jobFamilies',
    label: 'Job Families',
    deps: ['careerDomains'],
  },
  {
    step: 3,
    datasetType: 'skillClusters',
    label: 'Skill Clusters',
    deps: ['careerDomains'],
  },
  {
    step: 4,
    datasetType: 'skills',
    label: 'Skills',
    deps: ['skillClusters'],
  },
  {
    step: 5,
    datasetType: 'roles',
    label: 'Roles',
    deps: ['jobFamilies'],
  },
  {
    step: 6,
    datasetType: 'educationLevels',
    label: 'Education Levels',
    deps: [],
  },
  {
    step: 7,
    datasetType: 'salaryBenchmarks',
    label: 'Salary Benchmarks',
    deps: [],
  },
  {
    step: 8,
    datasetType: 'skillDemand',
    label: 'Skill Demand',
    deps: [],
  },
  {
    step: 9,
    datasetType: 'roleSkills',
    label: 'Role Skills',
    deps: ['roles', 'skills'],
  },
];

const STEP_MAP = new Map(
  IMPORT_STEPS.map((step) => [step.datasetType, step])
);

async function countRows(tableName) {
  try {
    const { count, error } = await supabase
      .from(tableName)
      .select('*', {
        count: 'exact',
        head: true,
      });

    if (error) {
      throw error;
    }

    return count || 0;
  } catch (err) {
    logger.error('[ImportDependency] Count failed', {
      tableName,
      error: err.message,
    });
    return 0;
  }
}

async function checkDependencies(datasetType) {
  const step = STEP_MAP.get(datasetType);

  if (!step || !step.deps.length) {
    return;
  }

  const unmet = [];

  for (const depType of step.deps) {
    const table = TABLES[depType];
    const count = await countRows(table);

    if (count === 0) {
      unmet.push(depType);
    }
  }

  if (unmet.length > 0) {
    throw new AppError(
      `Import dependency not met for ${datasetType}. Missing: ${unmet.join(', ')}`,
      422,
      {
        datasetType,
        unmetDependencies: unmet,
      },
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

async function getImportStatus() {
  const results = [];

  for (const step of IMPORT_STEPS) {
    const table = TABLES[step.datasetType];
    const count = await countRows(table);

    const unmetDeps = [];

    for (const dep of step.deps) {
      const depCount = await countRows(TABLES[dep]);
      if (depCount === 0) {
        unmetDeps.push(dep);
      }
    }

    results.push({
      step: step.step,
      datasetType: step.datasetType,
      label: step.label,
      count,
      completed: count > 0,
      deps: step.deps,
      depsUnmet: unmetDeps.length > 0,
    });
  }

  return results;
}

function getNextStep(datasetType) {
  const current = STEP_MAP.get(datasetType);
  if (!current) return null;

  const next = IMPORT_STEPS.find(
    (step) => step.step === current.step + 1
  );

  return next?.label || null;
}

module.exports = {
  checkDependencies,
  getImportStatus,
  getNextStep,
  IMPORT_STEPS,
  TABLES,
};