'use strict';

/**
 * middleware/university.middleware.js
 *
 * Role guards for the University Integration Layer.
 *
 * requireUniversityMember — accepts university_admin or university_staff
 * requireUniversityAdmin  — accepts university_admin only
 *
 * Assumes authenticate middleware has already run (req.user.uid set).
 * universityId is sourced from req.params.universityId.
 */

const uniRepo = require('../repositories/university.repository');

function fail403(res, message = 'Forbidden.') {
  return res.status(403).json({ success: false, error: { message, code: 'UNIVERSITY_FORBIDDEN' } });
}

async function requireUniversityMember(req, res, next) {
  const { universityId } = req.params;
  if (!universityId) return fail403(res, 'University ID required.');

  const membership = await uniRepo.getUniversityUser(universityId, req.user.uid);
  if (!membership) return fail403(res, 'You are not a member of this university.');

  req.universityMembership = membership;
  return next();
}

async function requireUniversityAdmin(req, res, next) {
  const { universityId } = req.params;
  if (!universityId) return fail403(res, 'University ID required.');

  const membership = await uniRepo.getUniversityUser(universityId, req.user.uid);
  if (!membership || membership.role !== 'university_admin') {
    return fail403(res, 'University admin access required.');
  }

  req.universityMembership = membership;
  return next();
}

module.exports = { requireUniversityMember, requireUniversityAdmin };









