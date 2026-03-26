function estimateTimeToPromotion(userProfile, targetRole, readinessDetails) {
  let experienceGapMonths = 0;
  let skillGapMonths = 0;

  // Experience gap calculation
  const requiredYears = targetRole.min_experience_years || 0;
  const userYears = userProfile.experience_years || 0;

  if (requiredYears > userYears) {
    const gapYears = requiredYears - userYears;
    experienceGapMonths = gapYears * 12;
  }

  // Skill gap calculation
  const missingSkills = readinessDetails?.missing_skills || [];
  const monthsPerSkill = 3;

  skillGapMonths = missingSkills.length * monthsPerSkill;

  const estimatedMonths = Math.max(experienceGapMonths, skillGapMonths);

  return {
    experience_gap_months: experienceGapMonths,
    skill_gap_months: skillGapMonths,
    estimated_months_to_promotion: estimatedMonths
  };
}

module.exports = {
  estimateTimeToPromotion
};









