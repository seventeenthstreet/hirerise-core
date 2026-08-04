'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.metadata.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * Metadata Builder: computes the aggregate root's `createdAt`, `updatedAt`,
 * and `sourceSystemProvenance` fields at read time, per the Metadata
 * Strategy WP-STD-IMP-02 §16 designed — the central mechanical decision
 * that lets the Wrap persistence strategy (WP-STD-IMP-02 §10) require zero
 * new tables. `schemaContractVersion` is not computed here; it is the
 * module-level constant re-exported by studentProfile.schema.js.
 *
 * PURE FUNCTIONS ONLY — no I/O, no DB, no logging. Callers (aggregateBuilder.js)
 * pass in the timestamps already retrieved by the five subdomain reads;
 * this module performs no read of its own (WP-STD-IMP-02 §6.1's note that
 * "aggregate-root metadata is not a sixth read").
 */

const { SOURCE_SYSTEMS } = require('./studentProfile.constants');

/**
 * @typedef {Object} SourceTimestamps
 * @property {string|null} createdAt - ISO timestamp, or null if this source contributed no data
 * @property {string|null} updatedAt - ISO timestamp, or null if this source contributed no data
 */

/**
 * Computes `createdAt` as the min() of every wrapped source's own
 * creation timestamp, per WP-STD-IMP-02 §16 — an approximation of "first
 * write through this repository," disclosed there as such, since this
 * repository did not exist prior to this design and cannot know a true
 * first-write time for a student with pre-existing legacy data.
 *
 * @param {SourceTimestamps[]} sourceTimestamps
 * @returns {string|null}
 */
function computeCreatedAt(sourceTimestamps) {
  const values = (sourceTimestamps ?? [])
    .map((s) => s?.createdAt)
    .filter((v) => v !== null && v !== undefined)
    .map((v) => new Date(v).getTime())
    .filter((t) => !Number.isNaN(t));

  if (values.length === 0) return null;
  return new Date(Math.min(...values)).toISOString();
}

/**
 * Computes `updatedAt` as the max() of every wrapped source's own
 * update timestamp, per WP-STD-IMP-02 §16 — same disclosed approximation
 * as computeCreatedAt().
 *
 * @param {SourceTimestamps[]} sourceTimestamps
 * @returns {string|null}
 */
function computeUpdatedAt(sourceTimestamps) {
  const values = (sourceTimestamps ?? [])
    .map((s) => s?.updatedAt)
    .filter((v) => v !== null && v !== undefined)
    .map((v) => new Date(v).getTime())
    .filter((t) => !Number.isNaN(t));

  if (values.length === 0) return null;
  return new Date(Math.max(...values)).toISOString();
}

/**
 * Set-builder over which adapters returned any data, per WP-STD-IMP-02
 * §11's mapping rule: include `legacy_onboarding` if the legacy adapter
 * returned a row; include `onboarding_v2` if any v2 adapter
 * (academic/activity/cognitive) returned any row. `frontend_direct` is
 * never included by this design (WP-STD-IMP-02 §13.8 — no accommodation
 * designed; reserved for a future re-verification finding, not emitted
 * here).
 *
 * @param {object} flags
 * @param {boolean} flags.hasLegacyData - legacy adapter returned a row
 * @param {boolean} flags.hasV2Data - any of academic/activity/cognitive adapters returned any row
 * @returns {string[]} subset of SOURCE_SYSTEMS values
 */
function computeSourceSystemProvenance({ hasLegacyData, hasV2Data }) {
  const provenance = [];
  if (hasLegacyData) provenance.push(SOURCE_SYSTEMS.LEGACY_ONBOARDING);
  if (hasV2Data) provenance.push(SOURCE_SYSTEMS.ONBOARDING_V2);
  return provenance;
}

module.exports = {
  computeCreatedAt,
  computeUpdatedAt,
  computeSourceSystemProvenance,
};
