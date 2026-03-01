import { getAuth } from 'firebase-admin/auth';
import { logger } from '../../../shared/logger/index.js';

const PUBLIC_PATHS = new Set(['/health', '/health/ready', '/health/live']);

export function authenticate(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing Bearer token' });
  }

  const token = authHeader.slice(7);

  getAuth()
    .verifyIdToken(token, true) // checkRevoked = true
    .then((decoded) => {
      req.user = {
        uid: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: decoded.email_verified ?? false,
        roles: decoded.roles ?? [],
      };
      next();
    })
    .catch((err) => {
      logger.warn('Token verification failed', {
        err,
        ip: req.ip,
        path: req.path,
        errorCode: err.code,
      });

      const isExpired = err.code === 'auth/id-token-expired';
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: isExpired ? 'Token expired' : 'Invalid token',
      });
    });
}

export function requireEmailVerified(req, res, next) {
  if (!req.user?.emailVerified) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Email verification required' });
  }
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user?.roles?.includes(role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: `Role '${role}' required` });
    }
    next();
  };
}
