'use strict';

async function getCreditConfig() {
  return {
    costs: {
      fullAnalysis: 10,
      generateCV: 5,
      jobMatchAnalysis: 8,
    },
  };
}

module.exports = { getCreditConfig };