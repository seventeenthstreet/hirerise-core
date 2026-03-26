function calculatePromotionProbability(readinessScore) {
  if (readinessScore <= 0) return 0;

  // Non-linear dampening curve
  let probability;

  if (readinessScore < 0.5) {
    probability = readinessScore * 0.7;
  } else if (readinessScore < 0.8) {
    probability = readinessScore * 0.85;
  } else {
    probability = readinessScore * 0.95;
  }

  return Math.round(probability * 100);
}

module.exports = {
  calculatePromotionProbability
};









