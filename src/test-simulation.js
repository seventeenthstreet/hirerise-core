const simulationService = require("./services/simulation.service");

const userProfile = {
  skills: ["system_design", "ci_cd", "cloud"],
  experience_years: 5
};

const result = simulationService.simulateCareerPath("se_3", userProfile);

console.log("\n🚀 Multi-Step Career Simulation:\n");
console.log(JSON.stringify(result, null, 2));
