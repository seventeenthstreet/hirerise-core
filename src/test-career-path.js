const careerPathService = require("./services/careerPath.service");

const userProfile = {
  skills: ["system_design", "ci_cd", "cloud"],
  experience_years: 5
};

const result = careerPathService.getCareerPath("se_3", userProfile);

console.log(JSON.stringify(result, null, 2));









