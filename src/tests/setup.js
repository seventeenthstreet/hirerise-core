'use strict';

process.env.NODE_ENV = 'test';

// Optionally mock logger to reduce noise
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));









