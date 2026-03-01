function analyzeSkills(userSkills = [], requiredSkills = []) {
  const matched = [];
  const missing = [];

  requiredSkills.forEach(skill => {
    if (userSkills.includes(skill)) {
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  });

  const score = requiredSkills.length
    ? matched.length / requiredSkills.length
    : 1;

  return {
    skill_score: parseFloat(score.toFixed(2)),
    matched_skills: matched,
    missing_skills: missing
  };
}

function calculateExperienceScore(userYears, requiredYears) {
  if (!requiredYears) return 1;
  if (!userYears) return 0;

  const ratio = userYears / requiredYears;
  return parseFloat((ratio > 1 ? 1 : ratio).toFixed(2));
}

function calculateReadiness(userProfile, targetRole) {
  const skillAnalysis = analyzeSkills(
    userProfile.skills || [],
    targetRole.required_skills || []
  );

  const experienceScore = calculateExperienceScore(
    userProfile.experience_years,
    targetRole.min_experience_years
  );

  const readiness =
    (skillAnalysis.skill_score * 0.6) +
    (experienceScore * 0.4);

  return {
    readiness_score: parseFloat(readiness.toFixed(2)),
    skill_score: skillAnalysis.skill_score,
    experience_score: experienceScore,
    matched_skills: skillAnalysis.matched_skills,
    missing_skills: skillAnalysis.missing_skills
  };
}

module.exports = {
  calculateReadiness
};
