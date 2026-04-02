/**
 * Resume Score Engine — v1.0 (Cleaned & Safe)
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

  score(parsed = {}) {
    const breakdown = {
      completeness: this.#scoreCompleteness(parsed),
      skills: this.#scoreSkills(parsed),
      experience: this.#scoreExperience(parsed),
      education: this.#scoreEducation(parsed),
      formatting: this.#scoreFormatting(parsed),
    };

    const overallScore = Math.round(
      Object.entries(breakdown).reduce(
        (sum, [dim, score]) => sum + score * (WEIGHTS[dim] || 0),
        0
      )
    );

    return {
      overallScore,
      tier: this.#mapTier(overallScore),
      breakdown,
      extractedSkills: parsed.skills ?? [],
      recommendations: this.#generateRecommendations(breakdown, parsed),
      rawData: { weightMap: WEIGHTS },
    };
  }

  #scoreCompleteness(parsed) {
    const sections = parsed.sections ?? {};

    const REQUIRED = ['experience', 'skills', 'contact'];
    const OPTIONAL = ['education', 'summary', 'certifications', 'projects'];

    const requiredScore =
      REQUIRED.filter((s) => (sections[s] ?? []).length > 0).length /
      REQUIRED.length;

    const optionalScore =
      OPTIONAL.filter((s) => (sections[s] ?? []).length > 0).length /
      OPTIONAL.length;

    return Math.round((requiredScore * 0.8 + optionalScore * 0.2) * 100);
  }

  #scoreSkills(parsed) {
    const skills = parsed.skills ?? [];
    if (!skills.length) return 0;

    const normalized = skills.map((s) => s.toLowerCase().trim());

    const highValueCount = normalized.filter((s) =>
      HIGH_VALUE_SKILLS.has(s)
    ).length;

    const uniqueCount = new Set(normalized).size;

    const countScore = Math.min(uniqueCount / 20, 1);
    const qualityScore = Math.min(highValueCount / 5, 1);

    return Math.round((countScore * 0.4 + qualityScore * 0.6) * 100);
  }

  #scoreExperience(parsed) {
    const experiences = parsed.sections?.experience ?? [];
    if (!experiences.length) return 10;

    const totalYears =
      parsed.metadata?.totalYearsExperience ??
      experiences.length * 1.5;

    const yearsScore = Math.min(totalYears / 10, 1);

    const seniorityScore = experiences.some((exp) =>
      SENIOR_SIGNALS.has((exp.title ?? '').toLowerCase())
    )
      ? 1
      : 0.5;

    const diversityScore = Math.min(experiences.length / 4, 1);

    return Math.round(
      yearsScore * 0.5 +
      seniorityScore * 0.3 +
      diversityScore * 0.2
    );
  }

  #scoreEducation(parsed) {
    const education = parsed.sections?.education ?? [];
    if (!education.length) return 30;

    const degreePoints = {
      phd: 100,
      masters: 85,
      bachelors: 70,
      associates: 50,
      other: 40,
    };

    let highest = 0;

    for (const edu of education) {
      const level = (edu.degree ?? '').toLowerCase();

      for (const [key, points] of Object.entries(degreePoints)) {
        if (level.includes(key)) {
          highest = Math.max(highest, points);
        }
      }
    }

    return highest || degreePoints.other;
  }

  #scoreFormatting(parsed) {
    const wordCount = parsed.metadata?.wordCount ?? 0;

    const lengthScore =
      wordCount >= 300 && wordCount <= 1200
        ? 100
        : wordCount < 300
        ? 40
        : 70;

    const structureScore =
      Object.keys(parsed.sections ?? {}).length >= 4 ? 100 : 60;

    return Math.round(lengthScore * 0.6 + structureScore * 0.4);
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
      recs.push({
        priority: 'high',
        dimension: 'completeness',
        message: 'Add summary and contact information',
      });
    }

    if (breakdown.skills < 60) {
      recs.push({
        priority: 'high',
        dimension: 'skills',
        message: 'Add in-demand technical skills',
      });
    }

    if (breakdown.experience < 60) {
      recs.push({
        priority: 'medium',
        dimension: 'experience',
        message: 'Quantify achievements with numbers',
      });
    }

    if (
      breakdown.education < 50 &&
      !(parsed.sections?.education ?? []).length
    ) {
      recs.push({
        priority: 'low',
        dimension: 'education',
        message: 'Add certifications or courses',
      });
    }

    if (breakdown.formatting < 60) {
      recs.push({
        priority: 'medium',
        dimension: 'formatting',
        message: 'Keep resume between 400–800 words',
      });
    }

    return recs;
  }
}