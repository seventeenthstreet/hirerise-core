'use strict';

/**
 * @file test/careerIntelligence.simulation.js
 * @description
 * Enterprise simulation harness for career intelligence service.
 * Supabase-era, CI-safe, and import-safe.
 */

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: '.env.test' });

const careerService = require('../services/careerIntelligence.service');

function generateMockResume() {
  return {
    roleFit: 'software_engineer',
    overallScore: 72,
    skillOverlap: 70,
    experienceMatch: 65,
    marketDemand: 80,
    skillVelocity: 60,
  };
}

function generateMockSalary() {
  return {
    currentEstimatedSalaryBand: {
      minSalaryINR: 1200000,
      maxSalaryINR: 1800000,
      currency: 'INR',
    },
    max5YearPotentialINR: 5000000,
    bandProgressionCAGR: 0.09,
  };
}

function generateMockCareerGraph() {
  return {
    nextRoles: ['senior_software_engineer', 'tech_lead'],
  };
}

function generateMockLLMResponse() {
  return {
    resumeStrength: {},
    skillGapAnalysis: {},
    marketCompetitiveness: {},
    growthProjection: {
      projection: {
        '1Year': {
          probability: 75,
          projectedSalaryRange: {
            minSalaryINR: 1500000,
            maxSalaryINR: 2200000,
            currency: 'INR',
          },
        },
        '3Year': {
          probability: 60,
          projectedSalaryRange: {
            minSalaryINR: 2200000,
            maxSalaryINR: 3200000,
            currency: 'INR',
          },
        },
        '5Year': {
          probability: 45,
          projectedSalaryRange: {
            minSalaryINR: 3200000,
            maxSalaryINR: 5000000,
            currency: 'INR',
          },
        },
      },
    },
    salaryForecast: generateMockSalary(),
    accelerationPlan: {
      prioritySkills: [
        {
          roiScore: 85,
          roiScale: '0-100 relative acceleration index',
          impactModelRef:
            'salary_engine::skill_premium_model_v2',
        },
      ],
    },
    careerRiskAssessment: {
      careerRiskScore: 30,
      riskLevel: 'Low',
    },
  };
}

async function runSimulation(iterations = 5) {
  console.log('🚀 Running Enterprise Simulation...\n');

  let success = 0;
  let failed = 0;

  for (let i = 1; i <= iterations; i++) {
    const userId = `test-user-${i}`;

    try {
      const result =
        await careerService.generateCareerIntelligence({
          userId,
          advancedMode: false,
          overrides: {
            resumeScore: generateMockResume(),
            salaryBand: generateMockSalary(),
            careerGraph: generateMockCareerGraph(),
            mockLLMResponse: generateMockLLMResponse(),
          },
        });

      if (result?.success) {
        console.log(`✅ ${userId} passed`);
        success++;
      } else {
        console.log(`❌ ${userId} failed`);
        failed++;
      }
    } catch (error) {
      console.error(`❌ ${userId} crashed:`, error.message);
      failed++;
    }
  }

  console.log('\n📊 Simulation Results:');
  console.log({ success, failed });

  return { success, failed };
}

if (require.main === module) {
  runSimulation()
    .then(({ failed }) => {
      process.exitCode = failed > 0 ? 1 : 0;
    })
    .catch((error) => {
      console.error('Simulation harness failed:', error);
      process.exitCode = 1;
    });
}

module.exports = {
  runSimulation,
  generateMockResume,
  generateMockSalary,
  generateMockCareerGraph,
  generateMockLLMResponse,
};