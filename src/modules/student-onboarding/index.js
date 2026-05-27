'use strict';

/**
 * src/modules/student-onboarding/index.js
 *
 * Module entry point. Exposes the router and key services for
 * use by server.js and any cross-module integrations.
 *
 * Phase 1–3D exports. Future phases extend this file.
 */

module.exports = {
  // ── Routing ────────────────────────────────────────────────────────────────
  routes:                require('./routes/studentOnboarding.routes'),
  intelligenceRoutes:    require('./routes/intelligence.routes'),

  // ── Phase 1 services ───────────────────────────────────────────────────────
  sessionService:        require('./services/session.service'),
  educationService:      require('./services/education.service'),

  // ── Phase 3D intelligence services ────────────────────────────────────────
  intelligenceService:   require('./services/intelligence.service'),

  // ── Constants ──────────────────────────────────────────────────────────────
  constants:             require('./constants'),
  intelligenceConstants: require('./constants/intelligence'),

  // ── Helpers ────────────────────────────────────────────────────────────────
  progression:           require('./helpers/progression'),
  completion:            require('./helpers/completion'),

  // ── Validators ─────────────────────────────────────────────────────────────
  intelligenceValidator: require('./validators/intelligence.validator'),

  // ── Signal layer ───────────────────────────────────────────────────────────
  domainNormalizers:     require('./signals/domain-normalizers'),
  crossDomainAggregator: require('./signals/cross-domain.aggregator'),
};
