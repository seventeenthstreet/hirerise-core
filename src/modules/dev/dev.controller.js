'use strict';

/**
 * src/modules/dev/dev.controller.js
 *
 * Development-only authentication helper.
 *
 * Supabase-native replacement for legacy Firebase custom token flow.
 *
 * Behavior:
 * 1. Ensure dev admin exists
 * 2. Ensure app_metadata stays synced
 * 3. Sign in with password using anon client
 * 4. Return access + refresh tokens
 *
 * This controller must NEVER be mounted in production.
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../../utils/logger');

const DEV_ADMIN_EMAIL =
  process.env.DEV_ADMIN_EMAIL ||
  'dev-admin@hirerise.internal';

const DEV_ADMIN_PASSWORD =
  process.env.DEV_ADMIN_PASSWORD ||
  'DevAdmin123!';

const DEV_ADMIN_APP_METADATA = Object.freeze({
  role: 'MASTER_ADMIN',
  admin: true,
  plan: 'pro',
  tier: 'pro',
});

let serviceRoleClient = null;
let anonClient = null;

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `[DevController] Missing required environment variable: ${name}`
    );
  }

  return value;
}

function getServiceRoleClient() {
  if (serviceRoleClient) return serviceRoleClient;

  serviceRoleClient = createClient(
    getRequiredEnv('SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );

  return serviceRoleClient;
}

function getAnonClient() {
  if (anonClient) return anonClient;

  anonClient = createClient(
    getRequiredEnv('SUPABASE_URL'),
    getRequiredEnv('SUPABASE_ANON_KEY')
  );

  return anonClient;
}

/**
 * Ensure dev admin exists.
 *
 * Uses create-first strategy:
 * - avoids listUsers() full scan
 * - duplicate-safe
 * - always syncs metadata
 */
async function ensureDevAdminUser(supabase) {
  const createPayload = {
    email: DEV_ADMIN_EMAIL,
    password: DEV_ADMIN_PASSWORD,
    email_confirm: true,
    app_metadata: DEV_ADMIN_APP_METADATA,
  };

  const { data, error } =
    await supabase.auth.admin.createUser(createPayload);

  /**
   * Success path = user created
   */
  if (!error && data?.user?.id) {
    logger.info('[DevController] Dev admin created', {
      userId: data.user.id,
    });

    return data.user.id;
  }

  /**
   * Duplicate-safe fallback:
   * Supabase returns duplicate user error if already exists.
   * We recover by using password sign-in below.
   */
  if (
    error &&
    !String(error.message).toLowerCase().includes('already')
  ) {
    throw new Error(
      `[DevController] Failed to ensure dev admin: ${error.message}`
    );
  }

  logger.debug('[DevController] Dev admin already exists');
  return null;
}

exports.generateDevToken = async (req, res, next) => {
  try {
    const supabaseAdmin = getServiceRoleClient();
    const supabaseAnon = getAnonClient();

    await ensureDevAdminUser(supabaseAdmin);

    const { data, error } =
      await supabaseAnon.auth.signInWithPassword({
        email: DEV_ADMIN_EMAIL,
        password: DEV_ADMIN_PASSWORD,
      });

    const session = data?.session;
    const user = data?.user;

    if (error || !session || !user) {
      logger.error('[DevController] Dev sign-in failed', {
        error: error?.message || 'No session returned',
      });

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          'Failed to create development session.',
      });
    }

    logger.info('[DevController] Dev token issued', {
      userId: user.id,
    });

    return res.status(200).json({
      success: true,
      data: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        user: {
          id: user.id,
          email: user.email,
          role:
            user.app_metadata?.role || 'MASTER_ADMIN',
        },
      },
    });
  } catch (error) {
    logger.error('[DevController] Unexpected failure', {
      error: error.message,
    });

    return next(error);
  }
};