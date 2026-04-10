'use strict';

/**
 * src/modules/analysis/repositories/chiSnapshots.repository.js
 *
 * Wave 3 Priority #4.1 — domain naming hardening
 *
 * IMPORTANT
 * ----------
 * This repository stores data in `resume_analyses`.
 * It is NOT the canonical Career Health Index longitudinal
 * snapshot repository (`chi_snapshots`).
 *
 * This file remains as the backward-compatible legacy path
 * while also exposing a canonical alias for future migration.
 *
 * Safe guarantees:
 * - zero runtime behavior changes
 * - preserves all existing imports
 * - preserves all RPC contracts
 * - preserves telemetry patch flow
 * - enables phased migration to resumeAnalysis.repository.js
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const RPC = Object.freeze({
  CREATE_SNAPSHOT: 'create_resume_analysis_snapshot',
  GET_LATEST_BY_RESUME: 'get_latest_resume_analysis',
  GET_BY_USER: 'get_user_resume_analyses',
  GET_BY_HASH: 'get_resume_analysis_by_hash',
  UPDATE_TELEMETRY: 'update_resume_analysis_telemetry',
});

class ResumeAnalysisRepository {
  constructor() {
    this.table = 'resume_analyses';
  }

  async executeRpc(fn, params = {}, { allowFallback = false } = {}) {
    const startedAt = Date.now();

    try {
      const { data, error } = await supabase.rpc(fn, params);

      if (error) {
        error.rpc = fn;
        throw error;
      }

      logger.debug('[ResumeAnalysisRepository][RPC] success', {
        rpc: fn,
        latency_ms: Date.now() - startedAt,
      });

      return data;
    } catch (error) {
      logger.warn('[ResumeAnalysisRepository][RPC] failed', {
        rpc: fn,
        latency_ms: Date.now() - startedAt,
        error: error?.message || 'Unknown RPC error',
        fallback_enabled: allowFallback,
      });

      if (!allowFallback) throw error;
      return null;
    }
  }

  normalizeSingleResult(result) {
    return Array.isArray(result) ? result[0] || null : result || null;
  }

  normalizeArrayResult(result) {
    return Array.isArray(result) ? result : [];
  }

  buildSnapshotRow(payload) {
    return {
      resume_id: payload.resumeId,
      user_id: payload.userId,
      engine: payload.engine || 'premium',
      analysis_hash: payload.analysisHash,
      score: payload.score ?? null,
      tier: payload.tier ?? null,
      summary: payload.summary ?? null,
      breakdown: payload.breakdown ?? null,
      strengths: payload.strengths ?? null,
      improvements: payload.improvements ?? null,
      top_skills: Array.isArray(payload.topSkills)
        ? payload.topSkills
        : [],
      estimated_experience_years:
        payload.estimatedExperienceYears ?? null,
      chi_score: payload.chiScore ?? null,
      dimensions: payload.dimensions ?? null,
      market_position: payload.marketPosition ?? null,
      peer_comparison: payload.peerComparison ?? null,
      growth_insights: payload.growthInsights ?? null,
      salary_estimate: payload.salaryEstimate ?? null,
      roadmap: payload.roadmap ?? null,
      ai_model_version: payload.aiModelVersion ?? null,
      projected_level_up_months:
        payload.projectedLevelUpMonths ?? null,
      current_estimated_salary_lpa:
        payload.currentEstimatedSalaryLpa ?? null,
      next_level_estimated_salary_lpa:
        payload.nextLevelEstimatedSalaryLpa ?? null,
      career_roadmap: payload.careerRoadmap ?? null,
      weighted_career_context:
        payload.weightedCareerContext ?? null,
      token_input_count: payload.tokenInputCount ?? null,
      token_output_count: payload.tokenOutputCount ?? null,
      ai_cost_usd: payload.aiCostUsd ?? null,
      cache_hit: payload.cacheHit ?? false,
      cache_source: payload.cacheSource ?? null,
      latency_ms: payload.latencyMs ?? null,
      operation_type:
        payload.operationType ?? 'resume_analysis',
    };
  }

  async createSnapshot(payload) {
    try {
      const row = this.buildSnapshotRow(payload);

      const rpcResult = await this.executeRpc(
        RPC.CREATE_SNAPSHOT,
        { p_payload: row },
        { allowFallback: true }
      );

      const normalized = this.normalizeSingleResult(rpcResult);
      if (normalized) return normalized;

      const { data, error } = await supabase
        .from(this.table)
        .insert(row)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Resume analysis snapshot insert failed', {
        table: this.table,
        error: error.message,
        resumeId: payload.resumeId,
        userId: payload.userId,
      });
      throw error;
    }
  }

  async getLatestByResumeId(resumeId) {
    try {
      const rpcResult = await this.executeRpc(
        RPC.GET_LATEST_BY_RESUME,
        { p_resume_id: resumeId },
        { allowFallback: true }
      );

      const normalized = this.normalizeSingleResult(rpcResult);
      if (normalized) return normalized;

      const { data, error } = await supabase
        .from(this.table)
        .select('*')
        .eq('resume_id', resumeId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    } catch (error) {
      logger.error('Resume analysis latest fetch failed', {
        table: this.table,
        error: error.message,
        resumeId,
      });
      throw error;
    }
  }

  async getLatestByUserId(userId, limit = 10) {
    try {
      const rpcResult = await this.executeRpc(
        RPC.GET_BY_USER,
        { p_user_id: userId, p_limit: limit },
        { allowFallback: true }
      );

      const normalized = this.normalizeArrayResult(rpcResult);
      if (normalized.length) return normalized;

      const { data, error } = await supabase
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Resume analysis user fetch failed', {
        table: this.table,
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  async getByAnalysisHash(userId, analysisHash) {
    try {
      const rpcResult = await this.executeRpc(
        RPC.GET_BY_HASH,
        {
          p_user_id: userId,
          p_analysis_hash: analysisHash,
        },
        { allowFallback: true }
      );

      const normalized = this.normalizeSingleResult(rpcResult);
      if (normalized) return normalized;

      const { data, error } = await supabase
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .eq('analysis_hash', analysisHash)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    } catch (error) {
      logger.error('Resume analysis hash lookup failed', {
        table: this.table,
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  async updateTelemetry(id, telemetry) {
    try {
      const patch = {
        token_input_count: telemetry.tokenInputCount ?? null,
        token_output_count: telemetry.tokenOutputCount ?? null,
        ai_cost_usd: telemetry.aiCostUsd ?? null,
        latency_ms: telemetry.latencyMs ?? null,
        cache_hit: telemetry.cacheHit ?? false,
        cache_source: telemetry.cacheSource ?? null,
        ai_model_version: telemetry.aiModelVersion ?? null,
        updated_at: new Date().toISOString(),
      };

      const rpcResult = await this.executeRpc(
        RPC.UPDATE_TELEMETRY,
        { p_id: id, p_patch: patch },
        { allowFallback: true }
      );

      const normalized = this.normalizeSingleResult(rpcResult);
      if (normalized) return normalized;

      const { data, error } = await supabase
        .from(this.table)
        .update(patch)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Resume analysis telemetry update failed', {
        table: this.table,
        error: error.message,
        id,
      });
      throw error;
    }
  }
}

const repository = new ResumeAnalysisRepository();

module.exports = repository;
module.exports.ResumeAnalysisRepository = ResumeAnalysisRepository;