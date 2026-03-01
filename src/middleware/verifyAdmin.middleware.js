'use strict';

/**
 * verifyAdmin.middleware.js
 * Converted from verifyAdmin.middleware.ts
 */

function verifyAdmin(req, res, next) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, errorCode: 'UNAUTHORIZED', message: 'Authentication required.', timestamp: new Date().toISOString() });
  }
  const isAdmin =
    user.admin === true ||
    ['admin', 'super_admin'].includes(user.role ?? '') ||
    (user.roles ?? []).includes('admin');
  if (!isAdmin) {
    return res.status(403).json({ success: false, errorCode: 'FORBIDDEN', message: 'Admin privileges required.', timestamp: new Date().toISOString() });
  }
  return next();
}

function verifySuperAdmin(req, res, next) {
  const user = req.user;
  if (!user || user.role !== 'super_admin') {
    return res.status(403).json({ success: false, errorCode: 'FORBIDDEN', message: 'Super admin privileges required.', timestamp: new Date().toISOString() });
  }
  return next();
}

module.exports = { verifyAdmin, verifySuperAdmin };