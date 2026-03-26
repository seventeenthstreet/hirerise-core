'use strict';

/**
 * modules/daily-engagement/services/alerts.service.js
 *
 * Career Opportunity Alerts — Module 3
 *
 * Creates actionable alerts when opportunities or risks are detected.
 * All alert creation goes through this service so deduplication, priority
 * scoring, and cache invalidation are centralised.
 *
 * Alert types and their triggers:
 *   job_match          → NEW_JOB_MATCH event
 *   skill_demand       → MARKET_TREND_UPDATED event (skill spike)
 *   career_opportunity → OPPORTUNITY_DETECTED event
 *   salary_trend       → MARKET_TREND_UPDATED event (salary movement)
 *   risk_warning       → CV_PARSED / SKILL_GAP_UPDATED events
 *   market_shift       → MARKET_TREND_UPDATED event (sector change)
 *
 * Deduplication:
 *   Each alert is assigned a dedup_key so the same signal can't fire
 *   more than once per 24-hour window. The key format is:
 *     {userId}:{alertType}:{signalIdentifier}:{YYYY-MM-DD}
 */

'use strict';

const logger     = require('../../../utils/logger');
const cacheManager = require('../../../core/cache/cache.manager');

const repo = require('../models/engagement.repository');
const {
  ALERT_TYPES,
  ALERT_PRIORITY,
  CacheKeys,
  CACHE_TTL_SEC,
} = require('../models/engagement.constants');

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function _cacheGet(key) {
  try {
    const raw = await cacheManager.getClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _cacheSet(key, value) {
  try {
    await cacheManager.getClient().set(key, JSON.stringify(value), CACHE_TTL_SEC);
  } catch { /* non-fatal */ }
}

async function _cacheDel(key) {
  try { await cacheManager.getClient().delete(key); } catch { /* non-fatal */ }
}

// ─── Dedup key builder ────────────────────────────────────────────────────────

/**
 * Build a deduplication key that is stable for one calendar day.
 *
 * @param {string} userId
 * @param {string} alertType
 * @param {string} signalId   — e.g. job_id, skill name, opportunity id
 * @returns {string}
 */
function _dedupKey(userId, alertType, signalId) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const slug  = String(signalId || 'general').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  return `${userId}:${alertType}:${slug}:${today}`;
}

// ─── Priority resolver ────────────────────────────────────────────────────────

/**
 * Determine alert priority from score/signal strength.
 *
 * @param {string} alertType
 * @param {number} [score]
 * @returns {number}
 */
function _resolvePriority(alertType, score = 0) {
  if (alertType === ALERT_TYPES.RISK_WARNING)        return ALERT_PRIORITY.HIGH;
  if (alertType === ALERT_TYPES.JOB_MATCH) {
    if (score >= 85) return ALERT_PRIORITY.CRITICAL;
    if (score >= 70) return ALERT_PRIORITY.HIGH;
    return ALERT_PRIORITY.MEDIUM;
  }
  if (alertType === ALERT_TYPES.CAREER_OPPORTUNITY) return ALERT_PRIORITY.HIGH;
  if (alertType === ALERT_TYPES.SKILL_DEMAND) {
    if (score >= 30) return ALERT_PRIORITY.HIGH;
    return ALERT_PRIORITY.MEDIUM;
  }
  if (alertType === ALERT_TYPES.SALARY_TREND)       return ALERT_PRIORITY.MEDIUM;
  if (alertType === ALERT_TYPES.MARKET_SHIFT)       return ALERT_PRIORITY.LOW;
  return ALERT_PRIORITY.INFORMATIONAL;
}

// ─── Alert factory functions ──────────────────────────────────────────────────

/**
 * createJobMatchAlert({ userId, jobTitle, company, matchScore, jobId? })
 */
async function createJobMatchAlert({ userId, jobTitle, company, matchScore, jobId }) {
  const signalId = jobId || `${jobTitle}_${company || 'unknown'}`.replace(/\s/g, '_');
  const priority = _resolvePriority(ALERT_TYPES.JOB_MATCH, matchScore);

  const alert = await repo.insertAlert({
    user_id:        userId,
    alert_type:     ALERT_TYPES.JOB_MATCH,
    title:          `New job match found: ${jobTitle}`,
    description:    `A ${jobTitle} role${company ? ` at ${company}` : ''} matches your profile ` +
                    `with a score of ${matchScore}%. ${matchScore >= 80 ? 'This is a strong match — act quickly.' : 'Review the role to see if it fits your goals.'}`,
    alert_priority: priority,
    action_url:     jobId ? `/jobs/${jobId}` : '/jobs',
    dedup_key:      _dedupKey(userId, ALERT_TYPES.JOB_MATCH, signalId),
    payload: {
      job_title:   jobTitle,
      company:     company    || null,
      match_score: matchScore || null,
      job_id:      jobId      || null,
    },
  });

  if (alert) {
    await _cacheDel(CacheKeys.alerts(userId));
    await _cacheDel(CacheKeys.unread(userId));
  }
  return alert;
}

/**
 * createSkillDemandAlert({ userId, skill, growthRate })
 */
async function createSkillDemandAlert({ userId, skill, growthRate }) {
  const priority = _resolvePriority(ALERT_TYPES.SKILL_DEMAND, growthRate);

  const alert = await repo.insertAlert({
    user_id:        userId,
    alert_type:     ALERT_TYPES.SKILL_DEMAND,
    title:          `${skill} skill demand surging`,
    description:    `Demand for ${skill} has increased by ${Math.round(growthRate)}% this month. ` +
                    `This skill is trending in your industry — consider adding it to your profile.`,
    alert_priority: priority,
    action_url:     `/skills?highlight=${encodeURIComponent(skill)}`,
    dedup_key:      _dedupKey(userId, ALERT_TYPES.SKILL_DEMAND, skill),
    payload: {
      skill,
      growth_rate: growthRate,
    },
  });

  if (alert) {
    await _cacheDel(CacheKeys.alerts(userId));
    await _cacheDel(CacheKeys.unread(userId));
  }
  return alert;
}

/**
 * createOpportunityAlert({ userId, opportunityTitle, matchScore, opportunityId? })
 */
async function createOpportunityAlert({ userId, opportunityTitle, matchScore, opportunityId }) {
  const alert = await repo.insertAlert({
    user_id:        userId,
    alert_type:     ALERT_TYPES.CAREER_OPPORTUNITY,
    title:          `New career opportunity: ${opportunityTitle}`,
    description:    `A new ${opportunityTitle} opportunity matches your profile ` +
                    `with a score of ${matchScore}%. Review it in your Opportunity Radar.`,
    alert_priority: _resolvePriority(ALERT_TYPES.CAREER_OPPORTUNITY, matchScore),
    action_url:     '/career-opportunities',
    dedup_key:      _dedupKey(userId, ALERT_TYPES.CAREER_OPPORTUNITY, opportunityId || opportunityTitle),
    payload: {
      opportunity_title: opportunityTitle,
      match_score:       matchScore,
      opportunity_id:    opportunityId || null,
    },
  });

  if (alert) {
    await _cacheDel(CacheKeys.alerts(userId));
    await _cacheDel(CacheKeys.unread(userId));
  }
  return alert;
}

/**
 * createSalaryTrendAlert({ userId, role, salaryChange, direction })
 */
async function createSalaryTrendAlert({ userId, role, salaryChange, direction }) {
  const isPositive = direction === 'up' || salaryChange > 0;
  const pct        = Math.abs(Math.round(salaryChange));

  const alert = await repo.insertAlert({
    user_id:        userId,
    alert_type:     ALERT_TYPES.SALARY_TREND,
    title:          `${role} salaries ${isPositive ? 'increased' : 'decreased'} by ${pct}%`,
    description:    `Market salaries for ${role} have ${isPositive ? 'risen' : 'fallen'} ${pct}% this month. ` +
                    `${isPositive ? 'This could be a good time to negotiate or explore new roles.' : 'Review your career strategy for this role.'}`,
    alert_priority: ALERT_PRIORITY.LOW,
    action_url:     '/analytics',
    dedup_key:      _dedupKey(userId, ALERT_TYPES.SALARY_TREND, role),
    payload: { role, salary_change: salaryChange, direction },
  });

  if (alert) {
    await _cacheDel(CacheKeys.alerts(userId));
    await _cacheDel(CacheKeys.unread(userId));
  }
  return alert;
}

/**
 * createRiskWarningAlert({ userId, riskScore, topFactor })
 */
async function createRiskWarningAlert({ userId, riskScore, topFactor }) {
  const alert = await repo.insertAlert({
    user_id:        userId,
    alert_type:     ALERT_TYPES.RISK_WARNING,
    title:          'Career risk level has increased',
    description:    `Your career risk score is now ${riskScore}/100. ` +
                    `${topFactor ? `Primary concern: ${topFactor}.` : ''} ` +
                    'Take action to reduce exposure — review your skill plan.',
    alert_priority: riskScore >= 75 ? ALERT_PRIORITY.CRITICAL : ALERT_PRIORITY.HIGH,
    action_url:     '/career-health',
    dedup_key:      _dedupKey(userId, ALERT_TYPES.RISK_WARNING, `risk_${Math.floor(riskScore / 10) * 10}`),
    payload: { risk_score: riskScore, top_factor: topFactor || null },
  });

  if (alert) {
    await _cacheDel(CacheKeys.alerts(userId));
    await _cacheDel(CacheKeys.unread(userId));
  }
  return alert;
}

// ─── Query methods ────────────────────────────────────────────────────────────

/**
 * getAlertsFeed(userId, opts?)
 *
 * Returns alerts sorted by priority then recency, served from Redis cache.
 *
 * @param {string} userId
 * @param {Object} [opts]  { limit, offset, unreadOnly, alertType }
 * @returns {Promise<{ alerts: Object[], unread_count: number, cached: boolean }>}
 */
async function getAlertsFeed(userId, opts = {}) {
  const cacheKey = CacheKeys.alerts(userId);
  const isDefault = !opts.unreadOnly && !opts.alertType && !opts.offset;

  if (isDefault) {
    const cached = await _cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  const [alerts, unread_count] = await Promise.all([
    repo.getUserAlerts(userId, opts),
    repo.getUnreadAlertCount(userId),
  ]);

  const result = { alerts, unread_count, cached: false };

  if (isDefault) await _cacheSet(cacheKey, result);

  return result;
}

/**
 * markAlertsRead(userId, ids[])
 * Mark alerts as read, bust caches, return updated count.
 *
 * @param {string}   userId
 * @param {string[]} [ids]  — omit to mark all
 * @returns {Promise<{ updated: number, unread_count: number }>}
 */
async function markAlertsRead(userId, ids = []) {
  const updated = await repo.markAlertsRead(userId, ids);

  await Promise.all([
    _cacheDel(CacheKeys.alerts(userId)),
    _cacheDel(CacheKeys.unread(userId)),
  ]);

  const unread_count = await repo.getUnreadAlertCount(userId);

  return { updated, unread_count };
}

module.exports = {
  // Factories
  createJobMatchAlert,
  createSkillDemandAlert,
  createOpportunityAlert,
  createSalaryTrendAlert,
  createRiskWarningAlert,
  // Queries
  getAlertsFeed,
  markAlertsRead,
};









