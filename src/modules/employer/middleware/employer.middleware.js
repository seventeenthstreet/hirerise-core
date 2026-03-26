'use strict';

/**
 * middleware/employer.middleware.js
 *
 * Role guards for the Employer Integration Layer.
 *
 * requireEmployerMember — accepts employer_admin or employer_hr
 * requireEmployerAdmin  — accepts employer_admin only
 */

const empRepo = require('../repositories/employer.repository');

function fail403(res, message = 'Forbidden.') {
  return res.status(403).json({ success: false, error: { message, code: 'EMPLOYER_FORBIDDEN' } });
}

async function requireEmployerMember(req, res, next) {
  const { employerId } = req.params;
  if (!employerId) return fail403(res, 'Employer ID required.');

  const membership = await empRepo.getEmployerUser(employerId, req.user.uid);
  if (!membership) return fail403(res, 'You are not a member of this employer organisation.');

  req.employerMembership = membership;
  return next();
}

async function requireEmployerAdmin(req, res, next) {
  const { employerId } = req.params;
  if (!employerId) return fail403(res, 'Employer ID required.');

  const membership = await empRepo.getEmployerUser(employerId, req.user.uid);
  if (!membership || membership.role !== 'employer_admin') {
    return fail403(res, 'Employer admin access required.');
  }

  req.employerMembership = membership;
  return next();
}

module.exports = { requireEmployerMember, requireEmployerAdmin };









