'use strict';

/**
 * adminPending.routes.js — Contributor Submission Workflow (Supabase)
 *
 * MIGRATED: Firestore pendingEntries → Supabase pending_entries table
 * Same API contract — no frontend changes needed.
 *
 * Approve flow: pending_entries → cms_* Supabase tables (via CMS repositories)
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate }           = require('../../middleware/requestValidator');
const { requireAdmin }       = require('../../middleware/auth.middleware');
const { requireContributor } = require('../../middleware/requireContributor.middleware');
const { asyncHandler }       = require('../../utils/helpers');
const logger                 = require('../../utils/logger');

function getSupabase() { return require('../../config/supabase'); }

const router = express.Router();
const SUPPORTED_ENTITY_TYPES = ['skill', 'role', 'jobFamily', 'educationLevel', 'salaryBenchmark'];

function isMasterOrAdmin(req) {
  const role = req.user?.role ?? '';
  return (
    req.user?.admin === true ||
    ['admin', 'super_admin', 'MASTER_ADMIN'].includes(role) ||
    (req.user?.roles ?? []).some(r => ['admin', 'super_admin', 'MASTER_ADMIN'].includes(r))
  );
}

// ── POST / — contributor submits entry ────────────────────────────────────────
router.post('/', requireContributor,
  validate([
    body('entityType').isIn(SUPPORTED_ENTITY_TYPES)
      .withMessage(`entityType must be one of: ${SUPPORTED_ENTITY_TYPES.join(', ')}`),
    body('payload').isObject().withMessage('payload must be an object'),
    body('payload.name').isString().trim().notEmpty().withMessage('payload.name is required'),
    body('submittedByUid').not().exists(),
    body('status').not().exists(),
  ]),
  asyncHandler(async (req, res) => {
    const { entityType, payload } = req.body;
    const supabase = getSupabase();

    const { data, error } = await supabase.from('pending_entries').insert({
      entity_type:     entityType,
      payload,
      status:          'pending',
      submitted_by:    req.user.uid,
      submitted_at:    new Date().toISOString(),
    }).select().single();

    if (error) throw new Error(`Failed to submit entry: ${error.message}`);

    logger.info('[Pending] Entry submitted', { id: data.id, entityType, uid: req.user.uid });
    return res.status(201).json({ success: true, data: _toCamel(data) });
  })
);

// ── GET / — list entries ──────────────────────────────────────────────────────
router.get('/', requireContributor,
  validate([
    query('status').optional().isIn(['pending', 'approved', 'rejected']),
    query('entityType').optional().isIn(SUPPORTED_ENTITY_TYPES),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    const { status, entityType, limit = '50' } = req.query;
    const supabase  = getSupabase();
    const isAdmin   = isMasterOrAdmin(req);
    const maxRows   = parseInt(limit, 10);

    let q = supabase.from('pending_entries').select('*')
      .order('submitted_at', { ascending: false }).limit(maxRows);

    if (!isAdmin) q = q.eq('submitted_by', req.user.uid);
    if (status)   q = q.eq('status', status);
    if (entityType) q = q.eq('entity_type', entityType);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const items = (data || []).map(_toCamel);
    return res.json({ success: true, data: { items, total: items.length } });
  })
);

// ── GET /:id — single entry ───────────────────────────────────────────────────
router.get('/:id', requireContributor,
  validate([param('id').isUUID()]),
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('pending_entries')
      .select('*').eq('id', req.params.id).single();

    if (error || !data) return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Entry not found.' });

    if (!isMasterOrAdmin(req) && data.submitted_by !== req.user.uid) {
      return res.status(403).json({ success: false, errorCode: 'FORBIDDEN', message: 'Access denied.' });
    }
    return res.json({ success: true, data: _toCamel(data) });
  })
);

// ── POST /:id/approve — master admin approves ─────────────────────────────────
router.post('/:id/approve', requireAdmin,
  validate([param('id').isUUID()]),
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: entry, error } = await supabase.from('pending_entries')
      .select('*').eq('id', req.params.id).single();

    if (error || !entry) return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Entry not found.' });
    if (entry.status !== 'pending') return res.status(409).json({
      success: false, errorCode: 'ALREADY_REVIEWED',
      message: `Entry has already been ${entry.status}.`,
    });

    const now      = new Date().toISOString();
    const adminUid = req.user.uid;

    // Write approved payload to correct live CMS Supabase table
    const liveTableMap = {
      skill:           'cms_skills',
      role:            'cms_roles',
      jobFamily:       'cms_job_families',
      educationLevel:  'cms_education_levels',
      salaryBenchmark: 'cms_salary_benchmarks',
    };
    const liveTable = liveTableMap[entry.entity_type];
    if (!liveTable) return res.status(400).json({ success: false, errorCode: 'INVALID_ENTITY_TYPE' });

    // Use the CMS repository so normalizedName etc are computed correctly
    let liveId;
    try {
      const { normalizeText } = require('../../shared/utils/normalizeText');
      const payload = entry.payload;
      const { data: live, error: liveErr } = await supabase.from(liveTable).insert({
        ...Object.fromEntries(
          Object.entries(payload).map(([k, v]) => [
            k.replace(/([A-Z])/g, '_$1').toLowerCase(), v  // camelCase → snake_case
          ])
        ),
        normalized_name:      normalizeText(payload.name || ''),
        created_by_admin_id:  adminUid,
        updated_by_admin_id:  adminUid,
        approved_from_pending_id: req.params.id,
        soft_deleted:         false,
        status:               'active',
      }).select('id').single();

      if (liveErr) throw new Error(liveErr.message);
      liveId = live.id;
    } catch (err) {
      logger.error('[Pending] Failed to write to live table', { error: err.message, liveTable });
      return res.status(500).json({ success: false, message: `Failed to promote entry: ${err.message}` });
    }

    // Update pending entry to approved
    await supabase.from('pending_entries').update({
      status:       'approved',
      reviewed_by:  adminUid,
      reviewed_at:  now,
      live_id:      liveId,
    }).eq('id', req.params.id);

    logger.info('[Pending] Entry approved', { pendingId: req.params.id, liveId, liveTable, adminUid });
    return res.json({ success: true, data: { pendingId: req.params.id, liveId, table: liveTable } });
  })
);

// ── POST /:id/reject — master admin rejects ───────────────────────────────────
router.post('/:id/reject', requireAdmin,
  validate([
    param('id').isUUID(),
    body('reason').isString().trim().notEmpty().isLength({ max: 500 })
      .withMessage('A rejection reason is required (max 500 chars)'),
  ]),
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: entry, error } = await supabase.from('pending_entries')
      .select('status').eq('id', req.params.id).single();

    if (error || !entry) return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Entry not found.' });
    if (entry.status !== 'pending') return res.status(409).json({
      success: false, errorCode: 'ALREADY_REVIEWED',
      message: `Entry has already been ${entry.status}.`,
    });

    await supabase.from('pending_entries').update({
      status:       'rejected',
      reviewed_by:  req.user.uid,
      reviewed_at:  new Date().toISOString(),
      review_notes: req.body.reason,
    }).eq('id', req.params.id);

    logger.info('[Pending] Entry rejected', { pendingId: req.params.id, adminUid: req.user.uid });
    return res.json({ success: true, data: { id: req.params.id, status: 'rejected' } });
  })
);

// ── DELETE /:id — contributor withdraws submission ────────────────────────────
router.delete('/:id', requireContributor,
  validate([param('id').isUUID()]),
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: entry, error } = await supabase.from('pending_entries')
      .select('*').eq('id', req.params.id).single();

    if (error || !entry) return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Entry not found.' });
    if (!isMasterOrAdmin(req) && entry.submitted_by !== req.user.uid) {
      return res.status(403).json({ success: false, errorCode: 'FORBIDDEN', message: 'You can only withdraw your own submissions.' });
    }
    if (entry.status === 'approved') {
      return res.status(409).json({ success: false, errorCode: 'ALREADY_APPROVED', message: 'Approved entries cannot be withdrawn.' });
    }

    await supabase.from('pending_entries').delete().eq('id', req.params.id);
    return res.json({ success: true, data: { id: req.params.id, deleted: true } });
  })
);

// ── Shape helper ──────────────────────────────────────────────────────────────
function _toCamel(row) {
  if (!row) return null;
  return {
    id:              row.id,
    entityType:      row.entity_type,
    payload:         row.payload,
    status:          row.status,
    submittedByUid:  row.submitted_by,
    submittedAt:     row.submitted_at,
    reviewedByUid:   row.reviewed_by,
    reviewedAt:      row.reviewed_at,
    rejectionReason: row.review_notes,
    liveId:          row.live_id,
  };
}

module.exports = router;








