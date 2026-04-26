'use strict';

/**
 * src/monitoring/alerts.js
 *
 * Production alert dispatcher.
 * Currently logs to the application logger.
 * Wire ALERT_WEBHOOK_URL (Slack incoming webhook) or
 * PAGERDUTY_ROUTING_KEY to enable real delivery.
 */

const SEVERITY = Object.freeze({
  LOW:      'low',
  HIGH:     'high',
  CRITICAL: 'critical',
});

let _logger = null;

function getLogger() {
  if (_logger) return _logger;
  try {
    _logger = require('../utils/logger').logger || require('../utils/logger');
  } catch {
    _logger = console;
  }
  return _logger;
}

/**
 * Fire-and-forget alert.
 * Never throws — callers use `.catch(() => {})` patterns.
 *
 * @param {object}  payload
 * @param {string}  payload.message     - Human-readable description
 * @param {string}  payload.severity    - SEVERITY constant value
 * @param {Error}   [payload.error]     - Original error if available
 * @param {string}  [payload.alertKey]  - Dedup key (e.g. 'core:500:POST:/analyze')
 * @param {object}  [payload.context]   - Extra structured data
 */
async function sendAlert(payload = {}) {
  try {
    const logger = getLogger();
    const level  = payload.severity === SEVERITY.CRITICAL ? 'error'
                 : payload.severity === SEVERITY.HIGH     ? 'warn'
                 : 'info';

    logger[level]('[Alert]', {
      severity:  payload.severity  || SEVERITY.LOW,
      message:   payload.message   || 'No message provided',
      alertKey:  payload.alertKey  || null,
      error:     payload.error?.message || null,
      context:   payload.context   || null,
    });

    // ── Slack webhook (optional) ─────────────────────────────────────
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      // HARDENING: Validate webhook URL format before attempting delivery.
      // A misconfigured URL (e.g. placeholder value) would silently fail;
      // this guard surfaces the misconfiguration immediately at alert-send time.
      const isValidWebhook =
        typeof webhookUrl === 'string' &&
        (webhookUrl.startsWith('https://hooks.slack.com/') ||
         webhookUrl.startsWith('https://discord.com/api/webhooks/') ||
         webhookUrl.startsWith('https://'));

      if (!isValidWebhook) {
        getLogger().warn('[Alert] ALERT_WEBHOOK_URL is set but does not look like a valid webhook URL — skipping delivery', {
          hint: 'Expected https://hooks.slack.com/... or similar',
        });
      } else {
        const body = JSON.stringify({
          text: `[${(payload.severity || 'low').toUpperCase()}] ${payload.message || ''}`,
          attachments: payload.context
            ? [{ text: JSON.stringify(payload.context, null, 2) }]
            : undefined,
        });

        // Best-effort — do not await to avoid blocking callers.
        // On failure: log a structured warning so ops can diagnose delivery issues
        // without the process crashing or the alert silently disappearing.
        fetch(webhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal:  AbortSignal.timeout(3000),
        }).then((res) => {
          if (!res.ok) {
            // Non-2xx from Slack — log with status so it appears in structured logs
            getLogger().warn('[Alert] Webhook delivery rejected by server', {
              httpStatus: res.status,
              severity:   payload.severity,
              alertKey:   payload.alertKey || null,
            });
          }
        }).catch((err) => {
          // Network/timeout failure — guaranteed fallback log so the alert is never lost
          getLogger().warn('[Alert] Webhook delivery failed — alert logged only', {
            error:    err.message,
            severity: payload.severity,
            message:  payload.message,
            alertKey: payload.alertKey || null,
          });
        });
      }
    }
  } catch {
    // Absorb all errors — alerts must never crash the process
  }
}

module.exports = { sendAlert, SEVERITY };
