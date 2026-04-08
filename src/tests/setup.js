'use strict';

/**
 * @file jest.setup.js
 * @description
 * Global Jest bootstrap for Supabase-era test stability.
 */

process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
process.env.SUPABASE_URL =
  process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.TEST_JWT =
  process.env.TEST_JWT || 'test-jwt-token';

/**
 * Silence logger noise in test output.
 */
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Fail fast on unhandled async errors.
 */
process.on('unhandledRejection', (error) => {
  throw error;
});