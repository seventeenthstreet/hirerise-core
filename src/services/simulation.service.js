const careerPathService = require("./careerPath.service");

function simulateCareerPath(startRoleId, userProfile, maxSteps = 5) {
  let currentRoleId = startRoleId;

  // Clone user profile so we don't mutate original
  let simulatedUser = {
    skills: [...(userProfile.skills || [])],
    experience_years: userProfile.experience_years || 0
  };

  let totalMonths = 0;
  let totalSalaryGrowth = 0;
  const path = [];

  for (let step = 0; step < maxSteps; step++) {
    const result = careerPathService.getCareerPath(
      currentRoleId,
      simulatedUser
    );

    if (!result.next_roles.length) break;

    // Choose highest probability next role
    const bestNextRole = result.next_roles.reduce((prev, curr) =>
      curr.promotion_probability_percent > prev.promotion_probability_percent
        ? curr
        : prev
    );

    if (!bestNextRole) break;

    const months =
      bestNextRole.time_to_promotion?.estimated_months_to_promotion || 0;

    totalMonths += months;
    totalSalaryGrowth +=
      bestNextRole.growth_projection?.adjusted_salary_delta || 0;

    path.push({
      role_id: bestNextRole.role_id,
      title: bestNextRole.title,
      promotion_probability_percent:
        bestNextRole.promotion_probability_percent,
      estimated_months_to_promotion: months,
      adjusted_salary_delta:
        bestNextRole.growth_projection?.adjusted_salary_delta
    });

    // 🔥 Update simulated user experience
    simulatedUser.experience_years += months / 12;

    // 🔥 Assume missing skills are learned during that time
    const missingSkills =
      bestNextRole.readiness_details?.missing_skills || [];

    simulatedUser.skills = [
      ...new Set([...simulatedUser.skills, ...missingSkills])
    ];

    currentRoleId = bestNextRole.role_id;

    if (result.is_terminal) break;
  }

  return {
    career_path: path,
    total_estimated_months: totalMonths,
    total_projected_salary_growth: totalSalaryGrowth,
    final_experience_years: parseFloat(
      simulatedUser.experience_years.toFixed(2)
    ),
    final_skills: simulatedUser.skills
  };
}

module.exports = {
  simulateCareerPath
};









