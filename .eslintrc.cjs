module.exports = {
  root: true,

  env: {
    node: true,
    es2022: true,
    jest: true,
  },

  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },

  extends: ['eslint:recommended'],

  plugins: ['local'],

  rules: {
    // Governance Rules
    'local/no-service-importing-service': 'error',
    'local/no-engine-importing-engine': 'error',

    // Temporary Noise Reduction During Adoption Phase
    'no-unused-vars': 'warn',
    'no-empty': 'warn',
    'no-undef': 'warn',
    'no-constant-condition': 'warn',
    'no-useless-escape': 'warn',
    'no-inner-declarations': 'warn',
    'no-async-promise-executor': 'warn',
    'no-unsafe-finally': 'warn',
    'no-const-assign': 'warn',
  },

  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
  ],
};