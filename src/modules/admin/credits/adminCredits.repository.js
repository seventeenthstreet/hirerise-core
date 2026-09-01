'use strict';

/**
 * adminCredits.repository.js — Usage / Credits — Admin Data Access
 *
 * Phase 4 Usage/Credits Contract Lock — Step 6 (/admin/credits backend).
 *
 * Reads:
 *   - findUserByIdOrEmail(idOrEmail)  — minimum identity fields only
 *     (mirrors adminUsers.repository.js's LIST_COLUMNS precedent: never
 *     select '*' on public.users).
 *   - getBalance(userId)             — users.ai_credits_remaining
 *     (authoritative balance — Phase 3 Contract §22, never derived from
 *     the ledger).
 *   - getQuotaState(userId)          — both quota systems, kept separate
 *     (Phase 3 Contract §21):
 *       System A: userProfiles.monthlyAiUsageCount / aiUsageResetDate
 *                 (see increment_ai_usage RPC, 000_initial_schema.sql)
 *       System B: user_quota rows for the current month (see
 *                 tierQuota.middleware.js's identical table/shape)
 *   - listLedger(userId, {...})      — paginated, filterable ledger read.
 *
 * Writes (both via the atomic SECURITY DEFINER RPCs added in
 * 20260831000001_phase4_usage_credits_ledger.sql — balance + ledger +
 * admin_logs happen inside those RPCs, not here):
 *   - grant(...)  -> admin_grant_credits RPC
 *   - adjust(...) -> admin_adjust_credits RPC
 *
 * This repository never UPDATEs or DELETEs credit_ledger rows directly,
 * and never mutates users.ai_credits_remaining directly — every balance
 * mutation goes through an RPC (Phase 3 Contract §7, §27).
 */

function getSupabase() { return require('../../../config/supabase').supabase; }

const USERS_TABLE = 'users';
const LEDGER_TABLE = 'credit_ledger';
const USER_PROFILES_TABLE = 'userProfiles';
const USER_QUOTA_TABLE = 'user_quota';

// Never select '*' on public.users — minimum identity fields needed to
// identify the target user (Phase 3 Contract §20).
const USER_IDENTITY_COLUMNS = 'id, email, display_name, role, ai_credits_remaining';

const MAX_LEDGER_PAGE_LIMIT = 200;

const LEDGER_TRANSACTION_TYPES = Object.freeze(['CONSUME', 'GRANT', 'ADJUST', 'REFUND']);

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

class AdminCreditsRepository {
  /**
   * User lookup by ID or email (Phase 3 Contract §20). Deliberately not a
   * general-purpose search — exact match only, single target user.
   */
  async findUserByIdOrEmail(idOrEmail) {
    const supabase = getSupabase();
    const term = String(idOrEmail || '').trim();
    if (!term) return null;

    let query = supabase.from(USERS_TABLE).select(USER_IDENTITY_COLUMNS);

    query = isUuidLike(term) ? query.eq('id', term) : query.eq('email', term);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? this._toCamelUser(data) : null;
  }

  async getUserById(userId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .select(USER_IDENTITY_COLUMNS)
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    return data ? this._toCamelUser(data) : null;
  }

  /**
   * Quota System A — src/services/aiUsage.service.js /
   * userProfiles.monthlyAiUsageCount. Read-only; never modified here
   * (Phase 3 Contract §21 — "Do NOT modify quota behavior").
   */
  async getUsageCounterState(userId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(USER_PROFILES_TABLE)
      .select('"monthlyAiUsageCount", "aiUsageResetDate"')
      .eq('id', userId)
      .maybeSingle();

    // A missing userProfiles row is a legitimate "never used AI features"
    // state, not an error — mirrors increment_ai_usage's own NOT FOUND ->
    // INSERT-on-first-use convention.
    if (error) throw error;

    return {
      monthlyAiUsageCount: data?.monthlyAiUsageCount ?? 0,
      aiUsageResetDate: data?.aiUsageResetDate ?? null,
    };
  }

  /**
   * Quota System B — src/middleware/tierQuota.middleware.js / user_quota.
   * Read-only, current month only, all per-feature rows for this user.
   */
  async getFeatureQuotaState(userId) {
    const supabase = getSupabase();
    const monthKey = currentMonthKey();

    const { data, error } = await supabase
      .from(USER_QUOTA_TABLE)
      .select('feature, count')
      .eq('user_id', userId)
      .eq('month_key', monthKey);

    if (error) throw error;

    return {
      monthKey,
      features: (data || []).map((row) => ({
        feature: row.feature,
        count: row.count ?? 0,
      })),
    };
  }

  /**
   * Ledger view (Phase 3 Contract §23) — pagination + transaction-type
   * filter + date-range filter. No cross-user analytics, no export.
   */
  async listLedger(userId, {
    limit = 25,
    offset = 0,
    transactionType,
    startDate,
    endDate,
  } = {}) {
    const supabase = getSupabase();
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), MAX_LEDGER_PAGE_LIMIT);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    let query = supabase
      .from(LEDGER_TABLE)
      .select(
        'id, transaction_type, amount, balance_after, source, actor_user_id, reference_id, reason, created_at, metadata',
        { count: 'exact' }
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (transactionType && LEDGER_TRANSACTION_TYPES.includes(transactionType)) {
      query = query.eq('transaction_type', transactionType);
    }
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', endDate);

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      items: (data || []).map((row) => this._toCamelLedgerRow(row)),
      total: count ?? 0,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  /**
   * MASTER_ADMIN Grant — atomic via admin_grant_credits RPC (balance +
   * ledger + admin_logs all written inside that single function
   * invocation). Returns the new balance and the created ledger row id.
   *
   * Error codes surfaced via error.code / error.message (Supabase maps
   * the RPC's ERRCODE onto error.code where available; the service layer
   * additionally string-matches error.message prefixes such as
   * DUPLICATE_REFERENCE / USER_NOT_FOUND / INVALID_AMOUNT /
   * REASON_REQUIRED / REFERENCE_REQUIRED, mirroring the existing
   * INSUFFICIENT_CREDITS matching convention in creditGuard.middleware.js
   * and coverLetter.service.js).
   */
  async grant({ targetUserId, amount, reason, referenceId, actorAdminId }) {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('admin_grant_credits', {
      p_target_user_id: targetUserId,
      p_amount: amount,
      p_reason: reason,
      p_reference_id: referenceId,
      p_actor_admin_id: actorAdminId,
    });

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    return {
      balanceAfter: row?.out_balance_after ?? null,
      ledgerId: row?.out_ledger_id ?? null,
    };
  }

  /**
   * MASTER_ADMIN Adjust — atomic via admin_adjust_credits RPC. Same
   * atomicity/idempotency/error-surfacing shape as grant() above.
   */
  async adjust({ targetUserId, adjustment, reason, referenceId, actorAdminId }) {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('admin_adjust_credits', {
      p_target_user_id: targetUserId,
      p_adjustment: adjustment,
      p_reason: reason,
      p_reference_id: referenceId,
      p_actor_admin_id: actorAdminId,
    });

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    return {
      balanceAfter: row?.out_balance_after ?? null,
      ledgerId: row?.out_ledger_id ?? null,
    };
  }

  // ── mappers ──────────────────────────────────────────────────────────

  _toCamelUser(row) {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? null,
      role: row.role,
      aiCreditsRemaining: row.ai_credits_remaining ?? 0,
    };
  }

  _toCamelLedgerRow(row) {
    return {
      id: row.id,
      transactionType: row.transaction_type,
      amount: row.amount,
      balanceAfter: row.balance_after,
      source: row.source ?? null,
      actorUserId: row.actor_user_id ?? null,
      referenceId: row.reference_id ?? null,
      reason: row.reason ?? null,
      createdAt: row.created_at,
      metadata: row.metadata ?? null,
    };
  }
}

module.exports = {
  adminCreditsRepository: new AdminCreditsRepository(),
  LEDGER_TRANSACTION_TYPES,
};
