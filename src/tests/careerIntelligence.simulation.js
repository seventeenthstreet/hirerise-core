process.env.NODE_ENV = "test";
require("dotenv").config();

const careerService = require("../services/careerIntelligence.service");

function generateMockResume() {
  return {
    roleFit: "software_engineer",
    overallScore: 72,
    skillOverlap: 70,
    experienceMatch: 65,
    marketDemand: 80,
    skillVelocity: 60
  };
}

function generateMockSalary() {
  return {
    currentEstimatedSalaryBand: {
      minSalaryINR: 1200000,
      maxSalaryINR: 1800000,
      currency: "INR"
    },
    max5YearPotentialINR: 5000000,
    bandProgressionCAGR: 0.09
  };
}

function generateMockCareerGraph() {
  return {
    nextRoles: ["senior_software_engineer", "tech_lead"]
  };
}

function generateMockLLMResponse() {
  return {
    resumeStrength: {},
    skillGapAnalysis: {},
    marketCompetitiveness: {},
    growthProjection: {
      projection: {
        "1Year": {
          probability: 75,
          projectedSalaryRange: {
            minSalaryINR: 1500000,
            maxSalaryINR: 2200000,
            currency: "INR"
          }
        },
        "3Year": {
          probability: 60,
          projectedSalaryRange: {
            minSalaryINR: 2200000,
            maxSalaryINR: 3200000,
            currency: "INR"
          }
        },
        "5Year": {
          probability: 45,
          projectedSalaryRange: {
            minSalaryINR: 3200000,
            maxSalaryINR: 5000000,
            currency: "INR"
          }
        }
      }
    },
    salaryForecast: {
      currentEstimatedSalaryBand: {
        minSalaryINR: 1200000,
        maxSalaryINR: 1800000,
        currency: "INR"
      },
      max5YearPotentialINR: 5000000,
      bandProgressionCAGR: 0.09
    },
    accelerationPlan: {
      prioritySkills: [
        {
          roiScore: 85,
          roiScale: "0-100 relative acceleration index",
          impactModelRef: "salary_engine::skill_premium_model_v2"
        }
      ]
    },
    careerRiskAssessment: {
      careerRiskScore: 30,
      riskLevel: "Low",
      riskScaleDefinition: {
        low: "0-35",
        medium: "36-65",
        high: "66-100"
      }
    }
  };
}

async function runSimulation() {
  console.log("🚀 Running Enterprise Simulation...\n");

  let success = 0;
  let failed = 0;

  for (let i = 1; i <= 5; i++) {
    try {
      const result = await careerService.generateCareerIntelligence({
        userId: `test-user-${i}`,
        advancedMode: false,
        overrides: {
          resumeScore: generateMockResume(),
          salaryBand: generateMockSalary(),
          careerGraph: generateMockCareerGraph(),
          mockLLMResponse: generateMockLLMResponse()
        }
      });

      if (result.success) {
        console.log(`✅ test-user-${i} passed`);
        success++;
      } else {
        console.log(`❌ test-user-${i} failed`);
        failed++;
      }

    } catch (err) {
      console.error(`❌ test-user-${i} crashed:`, err.message);
      failed++;
    }
  }

  console.log("\n📊 Simulation Results:");
  console.log({ success, failed });
}

runSimulation();
