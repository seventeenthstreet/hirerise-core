'use strict';

/**
 * src/modules/admin/mfa/mfa.service.js
 *
 * WP-ADMIN-02C — Enterprise Admin Step-Up Authentication (TOTP)
 *
 * RFC-6238 TOTP via otplib. Secrets encrypted at rest via the shared
 * utils/adminCrypto.js (same AES-256-GCM scheme as modules/secrets —
 * no second crypto implementation). Audit events written via the existing
 * utils/adminAuditLogger.js (admin_logs table) — no second audit table.
 *
 * Elevated sessions are independent of the Supabase auth session, per the
 * WP's explicit requirement. A session_token (opaque, random) is returned
 * to the client and must be sent back on subsequent /admin/* requests via
 * the X-Admin-Elevated-Session header; requireElevatedSession.middleware.js
 * validates it.
 */

const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { supabase } = require('../../../config/supabase');
const { encrypt, decrypt } = require('../../../utils/adminCrypto');
const { logAdminAction } = require('../../../utils/adminAuditLogger');
const logger = require('../../../utils/logger');

const TABLES = Object.freeze({
  SECRETS: 'admin_mfa_secrets',
  RECOVERY: 'admin_mfa_recovery_codes',
  SESSIONS: 'admin_elevated_sessions',
});

const ELEVATED_SESSION_TTL_MS = 30 * 60 * 1000; // 30 min inactivity timeout, per WP
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'HireRise Admin';

authenticator.options = { window: 1 }; // ±30s clock drift tolerance, standard for TOTP

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  // 10-char groups, easy to read/type: XXXX-XXXX
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getMfaRow(uid) {
  const { data, error } = await supabase
    .from(TABLES.SECRETS)
    .select('*')
    .eq('uid', uid)
    .maybeSingle();

  if (error) {
    throw Object.assign(new Error(`Failed to read MFA state: ${error.message}`), { status: 500 });
  }
  return data;
}

function isLocked(row) {
  return !!row?.locked_until && new Date(row.locked_until).getTime() > Date.now();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /mfa/status
// ─────────────────────────────────────────────────────────────────────────────

async function getStatus(uid) {
  const row = await getMfaRow(uid);
  return {
    enrolled: !!row?.activated,
    pendingEnrollment: !!row && !row.activated,
    locked: isLocked(row),
    lockedUntil: row?.locked_until ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mfa/enroll — generate a new (inactive) secret + QR code
// ─────────────────────────────────────────────────────────────────────────────

async function beginEnrollment(uid, email) {
  const existing = await getMfaRow(uid);
  if (existing?.activated) {
    throw Object.assign(new Error('MFA is already enrolled for this account.'), { status: 409 });
  }

  const secret = authenticator.generateSecret(); // Base32, RFC-6238 compliant
  const { ciphertext, iv, auth_tag } = encrypt(secret);

  const { error } = await supabase
    .from(TABLES.SECRETS)
    .upsert({
      uid,
      encrypted_secret: ciphertext,
      iv,
      auth_tag,
      activated: false,
      failed_attempts: 0,
      locked_until: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'uid' });

  if (error) {
    throw Object.assign(new Error(`Failed to start enrollment: ${error.message}`), { status: 500 });
  }

  const otpauthUri = authenticator.keyuri(email || uid, ISSUER, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

  await logAdminAction({ adminId: uid, action: 'MFA_ENROLLMENT_STARTED', entityType: 'admin_mfa' });

  return {
    manualSecret: secret, // shown once, during enrollment only — never returned again
    otpauthUri,
    qrCodeDataUrl,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mfa/verify — first successful code activates MFA + issues recovery codes
// ─────────────────────────────────────────────────────────────────────────────

async function verifyEnrollment(uid, code, ipAddress) {
  const row = await getMfaRow(uid);
  if (!row) {
    throw Object.assign(new Error('No enrollment in progress. Call /mfa/enroll first.'), { status: 400 });
  }
  if (row.activated) {
    throw Object.assign(new Error('MFA is already enrolled for this account.'), { status: 409 });
  }
  if (isLocked(row)) {
    throw Object.assign(new Error('Too many failed attempts. Try again later.'), { status: 423 });
  }

  const secret = decrypt(row.encrypted_secret, row.iv, row.auth_tag);
  const valid = authenticator.verify({ token: String(code), secret });

  if (!valid) {
    await registerFailedAttempt(uid, row);
    await logAdminAction({ adminId: uid, action: 'MFA_VERIFICATION_FAILED', entityType: 'admin_mfa', ipAddress });
    throw Object.assign(new Error('Invalid code.'), { status: 401 });
  }

  const recoveryCodes = generateRecoveryCodes();
  const recoveryRows = recoveryCodes.map((code) => ({
    uid,
    code_hash: hashRecoveryCode(code),
  }));

  const now = new Date().toISOString();

  const { error: activateError } = await supabase
    .from(TABLES.SECRETS)
    .update({
      activated: true,
      activated_at: now,
      last_verified_at: now,
      failed_attempts: 0,
      locked_until: null,
      updated_at: now,
    })
    .eq('uid', uid);

  if (activateError) {
    throw Object.assign(new Error(`Failed to activate MFA: ${activateError.message}`), { status: 500 });
  }

  const { error: recoveryError } = await supabase.from(TABLES.RECOVERY).insert(recoveryRows);
  if (recoveryError) {
    logger.error('[MFA] Failed to write recovery codes', { uid, error: recoveryError.message });
  }

  const session = await createElevatedSession(uid, 'totp');

  await logAdminAction({ adminId: uid, action: 'MFA_ENROLLMENT_COMPLETED', entityType: 'admin_mfa', ipAddress });

  return {
    activated: true,
    recoveryCodes, // shown once — plaintext never stored, only the hash
    elevatedSession: session,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mfa/challenge — subsequent logins, MFA already active
// ─────────────────────────────────────────────────────────────────────────────

async function challenge(uid, code, ipAddress) {
  const row = await getMfaRow(uid);
  if (!row?.activated) {
    throw Object.assign(new Error('MFA is not enrolled for this account.'), { status: 400 });
  }
  if (isLocked(row)) {
    throw Object.assign(new Error('Too many failed attempts. Try again later.'), { status: 423 });
  }

  const secret = decrypt(row.encrypted_secret, row.iv, row.auth_tag);
  const valid = authenticator.verify({ token: String(code), secret });

  if (!valid) {
    await registerFailedAttempt(uid, row);
    await logAdminAction({ adminId: uid, action: 'MFA_VERIFICATION_FAILED', entityType: 'admin_mfa', ipAddress });
    throw Object.assign(new Error('Invalid code.'), { status: 401 });
  }

  await supabase
    .from(TABLES.SECRETS)
    .update({ last_verified_at: new Date().toISOString(), failed_attempts: 0, locked_until: null })
    .eq('uid', uid);

  const session = await createElevatedSession(uid, 'totp');

  await logAdminAction({ adminId: uid, action: 'MFA_VERIFICATION_SUCCEEDED', entityType: 'admin_mfa', ipAddress });

  return { elevatedSession: session };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mfa/recovery — single-use recovery code, alternative to a TOTP code
// ─────────────────────────────────────────────────────────────────────────────

async function useRecoveryCode(uid, code, ipAddress) {
  const hash = hashRecoveryCode(code.trim().toUpperCase());

  const { data: row, error } = await supabase
    .from(TABLES.RECOVERY)
    .select('id, used_at')
    .eq('uid', uid)
    .eq('code_hash', hash)
    .maybeSingle();

  if (error) {
    throw Object.assign(new Error(`Failed to verify recovery code: ${error.message}`), { status: 500 });
  }
  if (!row || row.used_at) {
    await logAdminAction({ adminId: uid, action: 'MFA_RECOVERY_CODE_REJECTED', entityType: 'admin_mfa', ipAddress });
    throw Object.assign(new Error('Invalid or already-used recovery code.'), { status: 401 });
  }

  await supabase
    .from(TABLES.RECOVERY)
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id);

  const session = await createElevatedSession(uid, 'recovery_code');

  await logAdminAction({ adminId: uid, action: 'MFA_RECOVERY_CODE_USED', entityType: 'admin_mfa', ipAddress });

  const { count } = await supabase
    .from(TABLES.RECOVERY)
    .select('id', { count: 'exact', head: true })
    .eq('uid', uid)
    .is('used_at', null);

  return {
    elevatedSession: session,
    remainingRecoveryCodes: count ?? 0,
    lowRecoveryCodeWarning: (count ?? 0) <= 2,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Elevated session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function createElevatedSession(uid, createdVia) {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ELEVATED_SESSION_TTL_MS);

  const { error } = await supabase.from(TABLES.SESSIONS).insert({
    uid,
    session_token: token,
    verified_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_activity_at: now.toISOString(),
    created_via: createdVia,
  });

  if (error) {
    throw Object.assign(new Error(`Failed to create elevated session: ${error.message}`), { status: 500 });
  }

  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Validates an elevated session token and refreshes its inactivity window.
 * Used by requireElevatedSession.middleware.js on every gated /admin/* request.
 */
async function touchElevatedSession(uid, token) {
  if (!token) return { valid: false, reason: 'missing_token' };

  const { data: row, error } = await supabase
    .from(TABLES.SESSIONS)
    .select('*')
    .eq('session_token', token)
    .eq('uid', uid)
    .maybeSingle();

  if (error || !row) return { valid: false, reason: 'not_found' };
  if (row.revoked_at) return { valid: false, reason: 'revoked' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { valid: false, reason: 'expired' };

  const now = new Date();
  const newExpiry = new Date(now.getTime() + ELEVATED_SESSION_TTL_MS);

  await supabase
    .from(TABLES.SESSIONS)
    .update({ last_activity_at: now.toISOString(), expires_at: newExpiry.toISOString() })
    .eq('id', row.id);

  return { valid: true, expiresAt: newExpiry.toISOString() };
}

async function revokeElevatedSessions(uid) {
  await supabase
    .from(TABLES.SESSIONS)
    .update({ revoked_at: new Date().toISOString() })
    .eq('uid', uid)
    .is('revoked_at', null);

  await logAdminAction({ adminId: uid, action: 'MFA_SESSION_REVOKED', entityType: 'admin_mfa' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lockout tracking
// ─────────────────────────────────────────────────────────────────────────────

async function registerFailedAttempt(uid, row) {
  const attempts = (row.failed_attempts ?? 0) + 1;
  const patch = { failed_attempts: attempts, updated_at: new Date().toISOString() };

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    patch.locked_until = new Date(Date.now() + LOCKOUT_MS).toISOString();
  }

  await supabase.from(TABLES.SECRETS).update(patch).eq('uid', uid);
}

module.exports = {
  getStatus,
  beginEnrollment,
  verifyEnrollment,
  challenge,
  useRecoveryCode,
  touchElevatedSession,
  revokeElevatedSessions,
};
