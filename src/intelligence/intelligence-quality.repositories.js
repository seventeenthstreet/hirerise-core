'use strict';

/**
 * intelligence-quality.repositories.js
 *
 * Thin persistence repositories for Phase 4A intelligence quality tables.
 *
 * Tables:
 *   - signal_coverage_profiles
 *   - signal_reliability_scores
 *   - cluster_stability_profiles
 *   - cluster_drift_history
 *
 * Design:
 *   - Insert-only (immutable history)
 *   - No update/delete operations
 *   - Analytics-safe queries (no full table scans)
 *   - Supabase client injected — not imported
 *   - All methods return plain objects (no Supabase types leak)
 */

// ─────────────────────────────────────────────────────────────
// SIGNAL COVERAGE REPOSITORY
// ─────────────────────────────────────────────────────────────

class SignalCoverageRepository {
  constructor(supabase) {
    this._db = supabase;
  }

  /**
   * Inserts a new coverage profile (immutable — no upsert).
   */
  async insert(record) {
    const { error } = await this._db
      .from('signal_coverage_profiles')
      .insert({
        user_id:         record.userId,
        assessment_id:   record.assessmentId,
        coverage_score:  record.coverageScore,
        coverage_level:  record.coverageLevel,
        factors:         record.factors         ?? null,
        trait_gaps:      record.traitGaps       ?? null,
        coverage_notes:  record.coverageNotes   ?? null,
        engine_version:  record.engineVersion   ?? 'signal-coverage-v1',
        evaluated_at:    record.evaluatedAt     ?? new Date().toISOString(),
      });

    if (error) throw new Error(`[SignalCoverageRepository.insert] ${error.message}`);
  }

  /**
   * Fetches the most recent coverage profile for a user.
   */
  async getLatest(userId) {
    const { data, error } = await this._db
      .from('signal_coverage_profiles')
      .select('*')
      .eq('user_id', userId)
      .order('evaluated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`[SignalCoverageRepository.getLatest] ${error.message}`);
    return data ? _mapCoverageRow(data) : null;
  }

  /**
   * Fetches coverage history for longitudinal analysis.
   */
  async getHistory(userId, { limit = 10 } = {}) {
    const { data, error } = await this._db
      .from('signal_coverage_profiles')
      .select('coverage_score, coverage_level, evaluated_at, assessment_id')
      .eq('user_id', userId)
      .order('evaluated_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`[SignalCoverageRepository.getHistory] ${error.message}`);
    return (data ?? []).map(_mapCoverageRow);
  }
}

// ─────────────────────────────────────────────────────────────
// SIGNAL RELIABILITY REPOSITORY
// ─────────────────────────────────────────────────────────────

class SignalReliabilityRepository {
  constructor(supabase) {
    this._db = supabase;
  }

  /**
   * Inserts multiple reliability scores in a single operation.
   */
  async insertMany(records) {
    if (!records.length) return;

    const rows = records.map(r => ({
      user_id:           r.userId,
      assessment_id:     r.assessmentId,
      trait_key:         r.traitKey,
      raw_score:         r.rawScore,
      reliability_score: r.reliabilityScore,
      reliability_level: r.reliabilityLevel,
      factors:           r.factors        ?? null,
      sample_count:      r.sampleCount    ?? null,
      last_assessed_at:  r.lastAssessedAt ?? null,
      engine_version:    r.engineVersion  ?? 'signal-reliability-v1',
    }));

    const { error } = await this._db
      .from('signal_reliability_scores')
      .insert(rows);

    if (error) throw new Error(`[SignalReliabilityRepository.insertMany] ${error.message}`);
  }

  /**
   * Fetches all reliability scores for the most recent assessment.
   */
  async getLatestByUser(userId) {
    // Find latest assessment_id first
    const { data: latest, error: err1 } = await this._db
      .from('signal_reliability_scores')
      .select('assessment_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (err1) throw new Error(`[SignalReliabilityRepository.getLatestByUser] ${err1.message}`);
    if (!latest) return [];

    const { data, error: err2 } = await this._db
      .from('signal_reliability_scores')
      .select('*')
      .eq('user_id', userId)
      .eq('assessment_id', latest.assessment_id);

    if (err2) throw new Error(`[SignalReliabilityRepository.getLatestByUser] ${err2.message}`);
    return (data ?? []).map(_mapReliabilityRow);
  }

  /**
   * Fetches previous reliability level for a specific trait (for threshold-crossed detection).
   */
  async getPreviousTraitLevel(userId, traitKey) {
    const { data, error } = await this._db
      .from('signal_reliability_scores')
      .select('reliability_level, created_at')
      .eq('user_id', userId)
      .eq('trait_key', traitKey)
      .order('created_at', { ascending: false })
      .limit(2);

    if (error) throw new Error(`[SignalReliabilityRepository.getPreviousTraitLevel] ${error.message}`);
    // Index [0] is latest, [1] is previous
    return data?.[1]?.reliability_level ?? null;
  }
}

// ─────────────────────────────────────────────────────────────
// CLUSTER STABILITY REPOSITORY
// ─────────────────────────────────────────────────────────────

class ClusterStabilityRepository {
  constructor(supabase) {
    this._db = supabase;
  }

  /**
   * Inserts multiple cluster stability profiles.
   */
  async insertMany(records) {
    if (!records.length) return;

    const rows = records.map(r => ({
      user_id:           r.userId,
      cluster_id:        r.clusterId,
      cluster_label:     r.clusterLabel,
      stability_score:   r.stabilityScore,
      stability_level:   r.stabilityLevel,
      trend_direction:   r.trendDirection,
      appearance_count:  r.appearanceCount,
      average_score:     r.averageScore    ?? null,
      last_score:        r.lastScore       ?? null,
      factors:           r.factors         ?? null,
      total_assessments: r.totalAssessments ?? 0,
      first_seen_at:     r.firstSeenAt     ?? null,
      last_seen_at:      r.lastSeenAt      ?? null,
      engine_version:    r.engineVersion   ?? 'cluster-stability-v1',
      evaluated_at:      r.evaluatedAt     ?? new Date().toISOString(),
    }));

    const { error } = await this._db
      .from('cluster_stability_profiles')
      .insert(rows);

    if (error) throw new Error(`[ClusterStabilityRepository.insertMany] ${error.message}`);
  }

  /**
   * Fetches the latest stability profile per cluster for a user.
   * Uses a subquery to get the most recent evaluation for each cluster.
   */
  async getLatestByUser(userId) {
    const { data, error } = await this._db
      .from('cluster_stability_profiles')
      .select('*')
      .eq('user_id', userId)
      .order('evaluated_at', { ascending: false });

    if (error) throw new Error(`[ClusterStabilityRepository.getLatestByUser] ${error.message}`);

    // Deduplicate to latest per clusterId
    const seen = new Set();
    const deduped = (data ?? []).filter(row => {
      if (seen.has(row.cluster_id)) return false;
      seen.add(row.cluster_id);
      return true;
    });

    return deduped.map(_mapStabilityRow);
  }
}

// ─────────────────────────────────────────────────────────────
// CLUSTER DRIFT REPOSITORY
// ─────────────────────────────────────────────────────────────

class ClusterDriftRepository {
  constructor(supabase) {
    this._db = supabase;
  }

  /**
   * Inserts a cluster drift record.
   */
  async insert(record) {
    const { error } = await this._db
      .from('cluster_drift_history')
      .insert({
        user_id:                     record.userId,
        previous_assessment_id:      record.previousAssessmentId,
        current_assessment_id:       record.currentAssessmentId,
        previous_assessed_at:        record.previousAssessedAt    ?? null,
        current_assessed_at:         record.currentAssessedAt     ?? null,
        drift_score:                 record.driftScore,
        drift_level:                 record.driftLevel,
        cluster_swapped:             record.clusterSwapped        ?? false,
        primary_score_delta:         record.primaryScoreDelta     ?? null,
        previous_primary_cluster_id: record.previousPrimaryClusterId ?? null,
        previous_primary_label:      record.previousPrimaryLabel  ?? null,
        current_primary_cluster_id:  record.currentPrimaryClusterId  ?? null,
        current_primary_label:       record.currentPrimaryLabel   ?? null,
        cluster_deltas:              record.clusterDeltas         ?? null,
        explanation:                 record.explanation           ?? null,
        engine_version:              record.engineVersion         ?? 'cluster-drift-v1',
      });

    if (error) {
      // Ignore duplicate pair errors (idempotency-safe)
      if (error.code === '23505') return; // unique constraint violation
      throw new Error(`[ClusterDriftRepository.insert] ${error.message}`);
    }
  }

  /**
   * Fetches the most recent drift record for a user.
   */
  async getLatest(userId) {
    const { data, error } = await this._db
      .from('cluster_drift_history')
      .select('*')
      .eq('user_id', userId)
      .order('current_assessed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`[ClusterDriftRepository.getLatest] ${error.message}`);
    return data ? _mapDriftRow(data) : null;
  }

  /**
   * Fetches full drift history for longitudinal analysis.
   */
  async getHistory(userId, { limit = 20 } = {}) {
    const { data, error } = await this._db
      .from('cluster_drift_history')
      .select('*')
      .eq('user_id', userId)
      .order('current_assessed_at', { ascending: true })
      .limit(limit);

    if (error) throw new Error(`[ClusterDriftRepository.getHistory] ${error.message}`);
    return (data ?? []).map(_mapDriftRow);
  }

  /**
   * Fetches only significant drift events (for dashboard alerts).
   */
  async getSignificantEvents(userId) {
    const { data, error } = await this._db
      .from('cluster_drift_history')
      .select('drift_level, drift_score, cluster_swapped, current_assessed_at, current_primary_label, previous_primary_label')
      .eq('user_id', userId)
      .in('drift_level', ['Moderate', 'Significant'])
      .order('current_assessed_at', { ascending: false })
      .limit(5);

    if (error) throw new Error(`[ClusterDriftRepository.getSignificantEvents] ${error.message}`);
    return data ?? [];
  }
}

// ─────────────────────────────────────────────────────────────
// ROW MAPPERS (DB → domain object)
// ─────────────────────────────────────────────────────────────

function _mapCoverageRow(row) {
  return {
    id:             row.id,
    userId:         row.user_id,
    assessmentId:   row.assessment_id,
    coverageScore:  row.coverage_score,
    coverageLevel:  row.coverage_level,
    factors:        row.factors        ?? null,
    traitGaps:      row.trait_gaps     ?? null,
    coverageNotes:  row.coverage_notes ?? null,
    engineVersion:  row.engine_version,
    evaluatedAt:    row.evaluated_at,
  };
}

function _mapReliabilityRow(row) {
  return {
    id:               row.id,
    userId:           row.user_id,
    assessmentId:     row.assessment_id,
    traitKey:         row.trait_key,
    rawScore:         row.raw_score,
    reliabilityScore: row.reliability_score,
    reliabilityLevel: row.reliability_level,
    factors:          row.factors          ?? null,
    sampleCount:      row.sample_count     ?? null,
    lastAssessedAt:   row.last_assessed_at ?? null,
    engineVersion:    row.engine_version,
  };
}

function _mapStabilityRow(row) {
  return {
    id:               row.id,
    userId:           row.user_id,
    clusterId:        row.cluster_id,
    clusterLabel:     row.cluster_label,
    stabilityScore:   row.stability_score,
    stabilityLevel:   row.stability_level,
    trendDirection:   row.trend_direction,
    appearanceCount:  row.appearance_count,
    averageScore:     row.average_score    ?? null,
    lastScore:        row.last_score       ?? null,
    factors:          row.factors          ?? null,
    totalAssessments: row.total_assessments,
    firstSeenAt:      row.first_seen_at    ?? null,
    lastSeenAt:       row.last_seen_at     ?? null,
    engineVersion:    row.engine_version,
    evaluatedAt:      row.evaluated_at,
  };
}

function _mapDriftRow(row) {
  return {
    id:                       row.id,
    userId:                   row.user_id,
    previousAssessmentId:     row.previous_assessment_id,
    currentAssessmentId:      row.current_assessment_id,
    previousAssessedAt:       row.previous_assessed_at    ?? null,
    currentAssessedAt:        row.current_assessed_at     ?? null,
    driftScore:               row.drift_score,
    driftLevel:               row.drift_level,
    clusterSwapped:           row.cluster_swapped,
    primaryScoreDelta:        row.primary_score_delta     ?? null,
    previousPrimaryClusterId: row.previous_primary_cluster_id ?? null,
    previousPrimaryLabel:     row.previous_primary_label  ?? null,
    currentPrimaryClusterId:  row.current_primary_cluster_id  ?? null,
    currentPrimaryLabel:      row.current_primary_label   ?? null,
    clusterDeltas:            row.cluster_deltas          ?? null,
    explanation:              row.explanation             ?? null,
    engineVersion:            row.engine_version,
    createdAt:                row.created_at,
  };
}

module.exports = {
  SignalCoverageRepository,
  SignalReliabilityRepository,
  ClusterStabilityRepository,
  ClusterDriftRepository,
};
