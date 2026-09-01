'use strict';

/**
 * @file adminCredits.mount.test.js
 *
 * Pins that /admin/credits is mounted in server.js behind the identical
 * authenticate + requireAdmin + requireElevatedSession chain every other
 * Admin module uses (/admin/users, /admin/weights,
 * /admin/administrators) — this is what actually enforces "reads =
 * ADMIN/MASTER_ADMIN, denied below that" (Phase 3 Contract §19/§31),
 * since adminCredits.routes.js itself has no route-level guard on its GET
 * routes (see adminCredits.routes.authorization.test.js).
 *
 * A static source check rather than a live supertest mount, mirroring
 * this codebase's existing precedent of pinning server.js wiring by
 * inspection when spinning up the full app is out of scope for a focused
 * unit suite (see secrets.routes.ratelimit.test.js's module doc comment
 * for the same rationale applied to a different mount).
 */

const fs = require('fs');
const path = require('path');

describe('server.js — /admin/credits mount point', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../../../../server.js'), 'utf8');

  it('mounts adminCredits.routes behind authenticate + requireAdmin + requireElevatedSession', () => {
    const mountLineMatch = serverSource
      .split('\n')
      .find((line) => line.includes("admin/credits") && line.includes('adminCredits.routes'));

    expect(mountLineMatch).toBeDefined();
    expect(mountLineMatch).toEqual(expect.stringContaining('authenticate'));
    expect(mountLineMatch).toEqual(expect.stringContaining('requireAdmin'));
    expect(mountLineMatch).toEqual(expect.stringContaining('requireElevatedSession'));
  });
});
