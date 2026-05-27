'use strict';

/**
 * security.middleware.js — HireRise Production Security Hardening
 *
 * Apply AFTER correlationMiddleware and BEFORE all routes.
 * Covers:
 *   - Helmet with strict CSP
 *   - Strict CORS (allowlist-only)
 *   - Request size limits
 *   - Trust proxy (Cloud Run / ECS / Nginx)
 *   - SSRF prevention for outbound fetches
 *   - Open redirect prevention
 *   - Auth abuse protection headers
 */

const helmet = require('helmet');
const cors = require('cors');

// ── Allowed origins (set from env) ────────────────────────────────────────────
function buildCorsOriginList() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = buildCorsOriginList();

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsMiddleware = cors({
  origin(origin, callback) {
    // Allow server-to-server (no Origin header) — rate limiter covers abuse
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    // Log and reject unknown origins
    return callback(
      Object.assign(new Error(`CORS: blocked origin ${origin}`), { status: 403 })
    );
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Correlation-ID',
    'X-Internal-Token',
    'X-Requested-With',
    'Stripe-Signature',
  ],
  exposedHeaders: ['X-Correlation-ID', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 600, // Cache preflight for 10 minutes
});

// ── Helmet ────────────────────────────────────────────────────────────────────
const helmetMiddleware = helmet({
  // Content-Security-Policy (backend API — strict; no inline scripts needed)
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  // HSTS — set by Nginx in production; keep here as defence-in-depth
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
  // Hide X-Powered-By
  hidePoweredBy: true,
  // Prevent IE from detecting MIME types
  ieNoOpen: true,
  // Don't allow cross-origin downloads
  crossOriginEmbedderPolicy: false, // disabled — API may serve binary resources
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-site' },
});

// ── Trust proxy ───────────────────────────────────────────────────────────────
// MUST be set when behind Nginx or a cloud load balancer.
// 1 = trust exactly one proxy hop (Nginx).
// Adjust to the actual number of trusted proxy hops in your infra.
function applyTrustProxy(app) {
  app.set('trust proxy', 1);
}

// ── SSRF prevention — validate outbound URLs ──────────────────────────────────
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local
  /^::1$/,
  /^fc00:/,
  /^fd/,
  /^localhost$/i,
  /\.internal$/i,
  /\.local$/i,
];

function isSsrfSafe(urlString) {
  try {
    const { hostname, protocol } = new URL(urlString);
    if (!['https:', 'http:'].includes(protocol)) return false;
    return !PRIVATE_IP_RANGES.some((r) => r.test(hostname));
  } catch {
    return false;
  }
}

// ── Open redirect prevention ──────────────────────────────────────────────────
const MAIN_DOMAIN = process.env.MAIN_DOMAIN || 'hirerise.com';

function isSafeRedirect(url) {
  if (!url) return false;
  // Allow relative paths
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === MAIN_DOMAIN ||
      parsed.hostname.endsWith(`.${MAIN_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

// ── Request size middleware factory ───────────────────────────────────────────
// Call this BEFORE the route handlers that need it.
// Stripe webhook route must parse raw body — exclude it here.
function requestSizeLimits({ jsonLimit = '1mb', urlencodedLimit = '1mb' } = {}) {
  const express = require('express');
  return [
    express.json({ limit: jsonLimit }),
    express.urlencoded({ limit: urlencodedLimit, extended: true }),
  ];
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  corsMiddleware,
  helmetMiddleware,
  applyTrustProxy,
  isSsrfSafe,
  isSafeRedirect,
  requestSizeLimits,
};
