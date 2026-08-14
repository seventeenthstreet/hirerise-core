'use strict';

/**
 * scripts/bootstrapMasterAdmin.js — WP-ADMIN-04F-18D
 *
 * One-time CLI for establishing the first Administrator on a fresh
 * HireRise deployment. All decision logic lives in
 * src/modules/admin/bootstrap/adminBootstrap.service.js — this file is
 * only argument/env parsing and process exit-code reporting.
 *
 * Usage:
 *   BOOTSTRAP_ADMIN_UID=<supabase-auth-uid> \
 *   BOOTSTRAP_ADMIN_EMAIL=<email, optional, audit-only> \
 *     node scripts/bootstrapMasterAdmin.js
 *
 *   node scripts/bootstrapMasterAdmin.js --uid <uid> [--email <email>]
 *
 * The uid must already exist in Supabase Auth (bootstrap grants
 * Administrator privileges to an existing authenticated principal — it
 * does not create an Auth user).
 *
 * Exit codes:
 *   0  bootstrap succeeded
 *   1  invalid input (missing uid)
 *   2  bootstrap refused — an Administrator already exists for this
 *      deployment, or a row already exists for this uid (NOT an error;
 *      this is the intended, safe outcome on re-run)
 *   3  unexpected failure (e.g. database unreachable)
 */

require('dotenv').config();

const {
  bootstrapMasterAdmin,
  BootstrapAlreadyCompletedError,
  BootstrapInputError,
} = require('../src/modules/admin/bootstrap/adminBootstrap.service');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--uid') out.uid = argv[i + 1];
    if (argv[i] === '--email') out.email = argv[i + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uid = args.uid || process.env.BOOTSTRAP_ADMIN_UID;
  const email = args.email || process.env.BOOTSTRAP_ADMIN_EMAIL || null;

  if (!uid) {
    console.error(
      '[bootstrapMasterAdmin] Missing target uid. Pass --uid <uid> or set BOOTSTRAP_ADMIN_UID.'
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await bootstrapMasterAdmin({ uid, email });
    console.info(
      `[bootstrapMasterAdmin] SUCCESS — uid=${result.uid} role=${result.role}. ` +
        'This Administrator can now sign in and manage further Administrators through the standard lifecycle.'
    );
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof BootstrapAlreadyCompletedError) {
      console.warn(`[bootstrapMasterAdmin] REFUSED — ${err.reason}`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof BootstrapInputError) {
      console.error(`[bootstrapMasterAdmin] INVALID INPUT — ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error('[bootstrapMasterAdmin] FAILED —', err);
    process.exitCode = 3;
  }
}

main();
