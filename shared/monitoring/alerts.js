'use strict';

/**
 * shared/monitoring/alerts.js
 * Production-ready alerting system
 */

const { logger } = require('../logger/index.js');

/* ---------------- SAFE FETCH ---------------- */

const fetch = global.fetch || require('node-fetch');

/* ---------------- CONSTANTS ---------------- */

const SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

const COOLDOWN_MS = 60_000;
const GLOBAL_THROTTLE_MS = 2000;
const TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS) || 5000;

const alertCooldowns = new Map();
let lastGlobalAlert = 0;

/* ---------------- HELPERS ---------------- */

function severityRank(sev) {
  return SEVERITY_RANK[sev?.toLowerCase()] ?? 0;
}

function isCoolingDown(key) {
  const last = alertCooldowns.get(key);
  return last && Date.now() - last < COOLDOWN_MS;
}

function markCooldown(key) {
  alertCooldowns.set(key, Date.now());

  if (alertCooldowns.size > 500) {
    const cutoff = Date.now() - COOLDOWN_MS;
    for (const [k, ts] of alertCooldowns.entries()) {
      if (ts < cutoff) alertCooldowns.delete(k);
    }
  }
}

function throttleGlobal() {
  if (Date.now() - lastGlobalAlert < GLOBAL_THROTTLE_MS) {
    return true;
  }
  lastGlobalAlert = Date.now();
  return false;
}

function getAlertConfig() {
  return {
    slackWebhookUrl: process.env.SLACK_ALERT_WEBHOOK_URL ?? null,
    genericWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? null,
    service: process.env.SERVICE_NAME ?? 'hirerise-core',
    environment: process.env.NODE_ENV ?? 'development',
    minExternalSeverity: process.env.ALERT_MIN_SEVERITY ?? 'high',
  };
}

function sanitizeError(error) {
  if (!error) return null;
  return {
    message: error.message ?? String(error),
    code: error.code ?? null,
  };
}

function createTimeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function retry(fn, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
    }
  }
}

/* ---------------- SLACK ---------------- */

async function sendSlackAlert(payload, webhookUrl) {
  const emoji = {
    low: ':information_source:',
    medium: ':warning:',
    high: ':rotating_light:',
    critical: ':sos:',
  }[payload.severity] || ':bell:';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *[${payload.severity.toUpperCase()}]* ${payload.message}`,
      },
    },
  ];

  if (payload.error) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* \`${payload.error.message}\``,
      },
    });
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `[${payload.service}/${payload.environment}] ${payload.message}`,
      blocks,
    }),
    signal: createTimeoutSignal(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook ${response.status}`);
  }
}

/* ---------------- GENERIC WEBHOOK ---------------- */

async function sendWebhookAlert(payload, webhookUrl) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
    }),
    signal: createTimeoutSignal(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Webhook ${response.status}`);
  }
}

/* ---------------- MAIN ---------------- */

async function sendAlert({
  message,
  error = null,
  severity = SEVERITY.HIGH,
  context = {},
  alertKey = null,
} = {}) {
  try {
    const cfg = getAlertConfig();
    const sev = severity.toLowerCase();
    const key = alertKey ?? `${sev}:${message}`;

    if (isCoolingDown(key) || throttleGlobal()) {
      logger.debug('Alert suppressed', { key });
      return;
    }

    markCooldown(key);

    const safeError = sanitizeError(error);

    const logMeta = {
      severity: sev,
      service: cfg.service,
      environment: cfg.environment,
      ...context,
      ...(safeError || {}),
    };

    if (sev === SEVERITY.CRITICAL || sev === SEVERITY.HIGH) {
      logger.error(`[ALERT] ${message}`, logMeta);
    } else {
      logger.warn(`[ALERT] ${message}`, logMeta);
    }

    const meetsThreshold =
      severityRank(sev) >= severityRank(cfg.minExternalSeverity);

    if (!meetsThreshold) return;

    const payload = {
      message,
      severity: sev,
      service: cfg.service,
      environment: cfg.environment,
      context,
      error: safeError,
    };

    const deliveries = [];

    if (cfg.slackWebhookUrl) {
      deliveries.push(
        retry(() => sendSlackAlert(payload, cfg.slackWebhookUrl)).catch((e) =>
          logger.warn('Slack alert failed', { error: e.message })
        )
      );
    }

    if (cfg.genericWebhookUrl) {
      deliveries.push(
        retry(() => sendWebhookAlert(payload, cfg.genericWebhookUrl)).catch((e) =>
          logger.warn('Webhook alert failed', { error: e.message })
        )
      );
    }

    if (deliveries.length) {
      await Promise.allSettled(deliveries);
    }
  } catch (err) {
    logger.error('Alert system failure', { error: err.message });
  }
}

/* ---------------- SHORTCUT API ---------------- */

const alert = {
  critical: (message, opts = {}) =>
    sendAlert({ ...opts, message, severity: SEVERITY.CRITICAL }),

  high: (message, opts = {}) =>
    sendAlert({ ...opts, message, severity: SEVERITY.HIGH }),

  medium: (message, opts = {}) =>
    sendAlert({ ...opts, message, severity: SEVERITY.MEDIUM }),

  low: (message, opts = {}) =>
    sendAlert({ ...opts, message, severity: SEVERITY.LOW }),
};

module.exports = { sendAlert, alert, SEVERITY };