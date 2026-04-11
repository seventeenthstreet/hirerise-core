function getSimilarityWeight({
  tenantVolume,
  targetVolume,
}) {
  const diff = Math.abs(tenantVolume - targetVolume);

  if (diff <= 10) return 1;
  if (diff <= 50) return 0.7;
  if (diff <= 100) return 0.4;

  return 0.2;
}

module.exports = {
  getSimilarityWeight,
};