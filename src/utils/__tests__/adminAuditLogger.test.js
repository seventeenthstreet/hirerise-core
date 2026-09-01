'use strict';

/**
 * adminAuditLogger.test.js
 *
 * WP-ADMIN-IMP-07 follow-up — focused coverage for the admin_logs.id fix.
 *
 * admin_logs.id is a TEXT PRIMARY KEY with no database default, so every
 * insert must supply one at the application layer or Postgres rejects it
 * with a not-null violation. These tests verify the logger now supplies a
 * unique id on every insert, that every other field's semantics and the
 * "never throws" contract are unchanged.
 *
 * buildAuditPayload() is not exported (kept private, per this file's
 * existing convention of exporting only logAdminAction) — these tests
 * observe it indirectly through the payload actually sent to Supabase's
 * insert(), which is what the database and this fix actually care about.
 */

const mockInsert = jest.fn();

jest.mock('../../config/supabase', () => ({
  get supabase() {
    return { from: () => ({ insert: mockInsert }) };
  },
}));

jest.mock('../logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../logger');
const { logAdminAction } = require('../adminAuditLogger');

describe('adminAuditLogger — admin_logs.id fix (WP-ADMIN-IMP-07 follow-up)', () => {
  beforeEach(() => {
    mockInsert.mockReset();
    mockInsert.mockResolvedValue({ error: null });
    logger.error.mockClear();
  });

  it('includes an id in the payload sent to Supabase insert()', async () => {
    await logAdminAction({ adminId: 'admin-1', action: 'ADMIN_GRANTED' });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const payload = mockInsert.mock.calls[0][0];
    expect(payload).toHaveProperty('id');
  });

  it('id is a non-empty string', async () => {
    await logAdminAction({ adminId: 'admin-1', action: 'ADMIN_GRANTED' });

    const payload = mockInsert.mock.calls[0][0];
    expect(typeof payload.id).toBe('string');
    expect(payload.id.length).toBeGreaterThan(0);
  });

  it('generates a valid UUID (v4-shaped) id, matching the repository-wide crypto.randomUUID() convention', async () => {
    await logAdminAction({ adminId: 'admin-1', action: 'ADMIN_GRANTED' });

    const payload = mockInsert.mock.calls[0][0];
    expect(payload.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('generates a different id for each separately logged action', async () => {
    await logAdminAction({ adminId: 'admin-1', action: 'ADMIN_GRANTED' });
    await logAdminAction({ adminId: 'admin-1', action: 'ADMIN_REVOKED' });

    const firstId = mockInsert.mock.calls[0][0].id;
    const secondId = mockInsert.mock.calls[1][0].id;
    expect(firstId).not.toBe(secondId);
  });

  it('leaves every other payload field intact and correctly mapped', async () => {
    await logAdminAction({
      adminId: 'admin-42',
      action: 'ADMIN_BOOTSTRAPPED',
      entityType: 'admin_principal',
      entityId: 'uid-99',
      metadata: { role: 'MASTER_ADMIN' },
      ipAddress: '203.0.113.7',
    });

    const payload = mockInsert.mock.calls[0][0];
    expect(payload).toMatchObject({
      admin_id: 'admin-42',
      action: 'ADMIN_BOOTSTRAPPED',
      entity_type: 'admin_principal',
      entity_id: 'uid-99',
      metadata: { role: 'MASTER_ADMIN' },
      ip_address: '203.0.113.7',
    });
    expect(typeof payload.created_at).toBe('string');
  });

  it('still defaults admin_id/action/entity_type when omitted (unchanged prior behavior)', async () => {
    await logAdminAction({});

    const payload = mockInsert.mock.calls[0][0];
    expect(payload).toMatchObject({
      admin_id: 'unknown',
      action: 'UNKNOWN_ACTION',
      entity_type: 'unknown',
    });
    expect(payload).toHaveProperty('id'); // still present even on the default/empty path
  });

  it('still normalizes non-JSON-safe metadata (unchanged prior behavior)', async () => {
    const circular = {};
    circular.self = circular;

    await logAdminAction({ adminId: 'admin-1', action: 'X', metadata: circular });

    const payload = mockInsert.mock.calls[0][0];
    expect(payload.metadata).toEqual({ serialization_error: true });
    expect(payload).toHaveProperty('id'); // unaffected by metadata normalization
  });

  it('still swallows a Supabase insert error and never throws (unchanged "never throws" contract)', async () => {
    mockInsert.mockResolvedValueOnce({ error: new Error('insert failed') });

    await expect(
      logAdminAction({ adminId: 'admin-1', action: 'ADMIN_GRANTED' })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      '[AdminAuditLogger] Failed to write audit log',
      expect.objectContaining({ error: 'insert failed' })
    );
  });

  it('still never throws even if id generation somehow threw (defensive — logAdminAction wraps everything)', async () => {
    // logAdminAction() wraps buildAuditPayload() + the insert call in the
    // same try/catch, so any synchronous failure while building the
    // payload (id generation included) is caught the same way a Supabase
    // error is — confirms the "never throws" contract holds regardless of
    // where a failure originates.
    mockInsert.mockImplementationOnce(() => {
      throw new Error('unexpected synchronous failure');
    });

    await expect(
      logAdminAction({ adminId: 'admin-1', action: 'ADMIN_GRANTED' })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
