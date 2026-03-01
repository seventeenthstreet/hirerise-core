/**
 * Resume Score Engine — v1.0
 *
 * Scoring dimensions:
 *   - completeness (25%): presence of required sections
 *   - skills        (30%): skill count, relevance, seniority signals
 *   - experience    (25%): years, role progression, company signals
 *   - education     (10%): degree level, institution tier signals
 *   - formatting    (10%): structure quality, length appropriateness
 *
 * Tier mapping:
 *   85–100 → elite
 *   70–84  → strong
 *   50–69  → developing
 *   0–49   → needs_work
 */

const WEIGHTS = Object.freeze({
  completeness: 0.25,
  skills: 0.30,
  experience: 0.25,
  education: 0.10,
  formatting: 0.10,
});

const SENIOR_SIGNALS = new Set([
  'led', 'managed', 'architected', 'founded', 'director', 'principal',
  'staff', 'vp', 'head of', 'senior', 'lead',
]);

const HIGH_VALUE_SKILLS = new Set([
  'python', 'typescript', 'kubernetes', 'terraform', 'react', 'node.js',
  'aws', 'gcp', 'azure', 'machine learning', 'system design', 'sql',
  'docker', 'graphql', 'rust', 'go',
]);

export class ResumeScoreEngineV1 {
  get version() {
    return 'resume_score_v1.0';
  }

  score(parsed) {
    const breakdown = {
      completeness: this.#scoreCompleteness(parsed),
      skills: this.#scoreSkills(parsed),
      experience: this.#scoreExperience(parsed),
      education: this.#scoreEducation(parsed),
      formatting: this.#scoreFormatting(parsed),
    };

    const overallScore = Math.round(
      Object.entries(breakdown).reduce(
        (sum, [dim, score]) => sum + score * WEIGHTS[dim],
        0
      )
    );

    return {
      overallScore,
      tier: this.#mapTier(overallScore),
      breakdown,
      extractedSkills: parsed.skills,
      recommendations: this.#generateRecommendations(breakdown, parsed),
      rawData: { weightMap: WEIGHTS },
    };
  }

  #scoreCompleteness(parsed) {
    const REQUIRED_SECTIONS = ['experience', 'skills', 'contact'];
    const OPTIONAL_SECTIONS = ['education', 'summary', 'certifications', 'projects'];

    const requiredScore =
      REQUIRED_SECTIONS.filter((s) => parsed.sections[s]?.length > 0).length /
      REQUIRED_SECTIONS.length;

    const optionalScore =
      OPTIONAL_SECTIONS.filter((s) => parsed.sections[s]?.length > 0).length /
      OPTIONAL_SECTIONS.length;

    return Math.round((requiredScore * 0.8 + optionalScore * 0.2) * 100);
  }

  #scoreSkills(parsed) {
    const skills = parsed.skills ?? [];
    if (skills.length === 0) return 0;

    const normalizedSkills = skills.map((s) => s.toLowerCase().trim());
    const highValueCount = normalizedSkills.filter((s) => HIGH_VALUE_SKILLS.has(s)).length;
    const uniqueCount = new Set(normalizedSkills).size;

    const countScore = Math.min(uniqueCount / 20, 1); // 20 skills = max
    const qualityScore = Math.min(highValueCount / 5, 1); // 5 high-value = max

    return Math.round((countScore * 0.4 + qualityScore * 0.6) * 100);
  }

  #scoreExperience(parsed) {
    const experiences = parsed.sections?.experience ?? [];
    if (experiences.length === 0) return 10;

    const totalYears = parsed.metadata?.totalYearsExperience ?? experiences.length * 1.5;
    const yearsScore = Math.min(totalYears / 10, 1); // 10 years = max

    const seniorityScore = experiences.some((exp) =>
      SENIOR_SIGNALS.has((exp.title ?? '').toLowerCase())
    )
      ? 1.0
      : 0.5;

    const diversityScore = Math.min(experiences.length / 4, 1); // 4 roles = max

    return Math.round((yearsScore * 0.5 + seniorityScore * 0.3 + diversityScore * 0.2) * 100);
  }

  #scoreEducation(parsed) {
    const education = parsed.sections?.education ?? [];
    if (education.length === 0) return 30; // no education is not fatal

    const degreePoints = { phd: 100, masters: 85, bachelors: 70, associates: 50, other: 40 };
    const highest = education.reduce((best, edu) => {
      const level = (edu.degree ?? '').toLowerCase();
      for (const [key, points] of Object.entries(degreePoints)) {
        if (level.includes(key)) return Math.max(best, points);
      }
      return Math.max(best, degreePoints.other);
    }, 0);

    return highest;
  }

  #scoreFormatting(parsed) {
    const wordCount = parsed.metadata?.wordCount ?? 0;
    const lengthScore = wordCount >= 300 && wordCount <= 1200 ? 100 : wordCount < 300 ? 40 : 70;
    const structureScore = Object.keys(parsed.sections ?? {}).length >= 4 ? 100 : 60;
    return Math.round((lengthScore * 0.6 + structureScore * 0.4));
  }

  #mapTier(score) {
    if (score >= 85) return 'elite';
    if (score >= 70) return 'strong';
    if (score >= 50) return 'developing';
    return 'needs_work';
  }

  #generateRecommendations(breakdown, parsed) {
    const recs = [];

    if (breakdown.completeness < 60) {
      recs.push({ priority: 'high', dimension: 'completeness', message: 'Add a professional summary and contact information' });
    }
    if (breakdown.skills < 60) {
      recs.push({ priority: 'high', dimension: 'skills', message: 'Expand technical skills section with in-demand technologies' });
    }
    if (breakdown.experience < 60) {
      recs.push({ priority: 'medium', dimension: 'experience', message: 'Quantify achievements in experience descriptions' });
    }
    if (breakdown.education < 50 && (parsed.sections?.education ?? []).length === 0) {
      recs.push({ priority: 'low', dimension: 'education', message: 'Consider adding certifications or courses if formal education is absent' });
    }
    if (breakdown.formatting < 60) {
      recs.push({ priority: 'medium', dimension: 'formatting', message: 'Aim for 400–800 words and ensure consistent section structure' });
    }

    return recs;
  }
}
