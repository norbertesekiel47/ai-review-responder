// src/lib/channels/__tests__/telegram-enrollment.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { WriteAccountAuditLogInput } from '@/lib/audit/log';

const mockWriteAccountAuditLog = vi.fn(async (_input: WriteAccountAuditLogInput) => {});
vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: (input: WriteAccountAuditLogInput) => mockWriteAccountAuditLog(input),
}));

// Module-under-test imports go below the mock.
const mockTx = vi.fn();
function makeTx(): typeof mockTx {
  // Postgres.js's tagged-template-callable signature: tx(strings, ...values) → Promise<rows>.
  return Object.assign(vi.fn(), {});
}

describe('startTelegramEnrollment', () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    tx = makeTx();
  });

  it('inserts a new row when no enrollment exists', async () => {
    tx.mockResolvedValueOnce([]); // SELECT existing → none
    tx.mockResolvedValueOnce([]); // INSERT
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const expiresAt = new Date('2026-04-28T13:00:00.000Z');
    const result = await startTelegramEnrollment(
      tx as never,
      'biz-123',
      'acct-456',
      'a'.repeat(64),
      expiresAt,
    );
    expect(result.kind).toBe('ok');
    expect(tx).toHaveBeenCalledTimes(2);
    // Verify the INSERT includes both account_id and business_id
    const insertCall = tx.mock.calls[1];
    const insertSql = (insertCall?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('account_id');
    expect(insertSql).toContain('business_id');
  });

  it('updates an existing pending row to a fresh hash', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'pending_verification' }]);
    tx.mockResolvedValueOnce([]); // UPDATE
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'b'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('updates an unsubscribed row to pending', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'unsubscribed' }]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'c'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('updates a disabled row to pending', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'disabled' }]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'd'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('returns already_verified when row.status is verified', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'verified' }]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'e'.repeat(64), new Date());
    expect(result.kind).toBe('already_verified');
    expect(tx).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
  });

  it('throws MultipleMobileChannelsError on 23505 + matching constraint (old name)', async () => {
    const err = new Error('duplicate key') as Error & { code: string; constraint_name: string };
    err.code = '23505';
    err.constraint_name = 'channel_enrollments_one_mobile_per_biz';
    tx.mockResolvedValueOnce([]); // SELECT
    tx.mockRejectedValueOnce(err); // INSERT throws
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const { MultipleMobileChannelsError } = await import('../unique-violation');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'f'.repeat(64), new Date()),
    ).rejects.toThrow(MultipleMobileChannelsError);
  });

  it('throws MultipleMobileChannelsError on 23505 + new constraint name (channel_enrollments_one_mobile_per_scope)', async () => {
    const err = new Error('duplicate key') as Error & { code: string; constraint_name: string };
    err.code = '23505';
    err.constraint_name = 'channel_enrollments_one_mobile_per_scope';
    tx.mockResolvedValueOnce([]); // SELECT
    tx.mockRejectedValueOnce(err); // INSERT throws
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const { MultipleMobileChannelsError } = await import('../unique-violation');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'f2'.repeat(64), new Date()),
    ).rejects.toThrow(MultipleMobileChannelsError);
  });

  it('throws EnrollmentDatabaseError on 23505 + other constraint', async () => {
    const err = new Error('duplicate key') as Error & { code: string; constraint_name: string };
    err.code = '23505';
    err.constraint_name = 'some_other_index';
    tx.mockResolvedValueOnce([]);
    tx.mockRejectedValueOnce(err);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const { EnrollmentDatabaseError } = await import('../unique-violation');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'g'.repeat(64), new Date()),
    ).rejects.toThrow(EnrollmentDatabaseError);
  });

  it('rethrows non-23505 errors unchanged', async () => {
    const err = new Error('serialization failure') as Error & { code: string };
    err.code = '40001';
    tx.mockResolvedValueOnce([]);
    tx.mockRejectedValueOnce(err);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'h'.repeat(64), new Date()),
    ).rejects.toThrow('serialization failure');
  });

  it('SELECTs the org-default enrollment row by account_id + location_id IS NULL with FOR UPDATE', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'j'.repeat(64), new Date());
    const selectSql = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(selectSql).toContain('FOR UPDATE');
    expect(selectSql).toContain('account_id =');
    expect(selectSql).toContain('location_id IS NULL');
  });

  it('does NOT emit pg_advisory_xact_lock SQL (caller responsibility)', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await startTelegramEnrollment(tx as never, 'biz-123', 'acct-456', 'i'.repeat(64), new Date());
    // Inspect the SQL templates passed to tx — concatenate the strings array
    // from each call and assert no pg_advisory.
    const allSql = tx.mock.calls
      .map((call) => (call[0] as TemplateStringsArray | undefined)?.join('?') ?? '')
      .join('\n');
    expect(allSql).not.toContain('pg_advisory_xact_lock');
  });
});

describe('cancelTelegramEnrollment', () => {
  it('returns ok when UPDATE affects rows', async () => {
    const sql = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await cancelTelegramEnrollment(sql as never, 'acct-1');
    expect(result.kind).toBe('ok');
  });

  it('returns not_found when UPDATE affects 0 rows', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await cancelTelegramEnrollment(sql as never, 'acct-1');
    expect(result.kind).toBe('not_found');
  });

  it('does NOT open sql.begin (single-statement)', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    // sql does not have a `begin` method on the mock — if the helper called
    // sql.begin, the test would throw TypeError. Verify by attempting
    // a plain call afterward.
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    await expect(cancelTelegramEnrollment(sql as never, 'acct-1')).resolves.toBeDefined();
  });

  it('SQL sets status = disabled, disabled_at = NOW(), filters by account_id + location_id IS NULL', async () => {
    const sql = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    await cancelTelegramEnrollment(sql as never, 'acct-1');
    const firstCall = sql.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sqlText = (firstCall![0] as TemplateStringsArray).join('?');
    expect(sqlText).toContain("status = 'disabled'");
    expect(sqlText).toContain('disabled_at = NOW()');
    expect(sqlText).toContain('account_id =');
    expect(sqlText).toContain('location_id IS NULL');
    expect(sqlText).toContain("channel = 'telegram'");
    expect(sqlText).toContain("status = 'pending_verification'");
    expect(sqlText).toContain('archived_at IS NULL');
  });

  it('after cancel a subsequent startTelegramEnrollment on the same account succeeds (disabled → pending branch)', async () => {
    // Mock sequence: startTelegramEnrollment does a SELECT that returns the
    // disabled row left by the cancel, then an UPDATE to pending_verification.
    const tx = vi.fn()
      .mockResolvedValueOnce([{ id: 'row-1', status: 'disabled' }]) // SELECT
      .mockResolvedValueOnce([]);                                      // UPDATE
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(
      tx as never,
      'biz-123',
      'acct-456',
      'a'.repeat(64),
      new Date('2026-04-28T14:00:00.000Z'),
    );
    expect(result.kind).toBe('ok');
    // Two calls: SELECT + UPDATE (the UPDATE branch for existing disabled row).
    expect(tx).toHaveBeenCalledTimes(2);
  });
});

describe('disableTelegramEnrollment', () => {
  beforeEach(() => {
    mockWriteAccountAuditLog.mockClear();
  });

  // Call 0 = org-default UPDATE (location_id IS NULL); call 1 = override UPDATE.
  function makeDisableTx(orgDefaultRows: unknown[], overrideRows: unknown[]): ReturnType<typeof makeTx> {
    const tx = makeTx();
    tx.mockResolvedValueOnce(orgDefaultRows);
    tx.mockResolvedValueOnce(overrideRows);
    return tx;
  }

  it('returns ok when only the org-default UPDATE affects rows', async () => {
    const tx = makeDisableTx([{ id: 'row-1' }], []);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(tx as unknown as postgres.TransactionSql, { accountId: 'acct-1' });
    expect(result.kind).toBe('ok');
  });

  it('returns not_found only when BOTH the org-default and override UPDATEs affect 0 rows', async () => {
    const tx = makeDisableTx([], []);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(tx as unknown as postgres.TransactionSql, { accountId: 'acct-1' });
    expect(result.kind).toBe('not_found');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('cascades + audits overrides even when the org-default is already disabled (0 org rows)', async () => {
    const tx = makeDisableTx([], [{ id: 'ov-1', location_id: 'loc-1' }, { id: 'ov-2', location_id: 'loc-2' }]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(tx as unknown as postgres.TransactionSql, { accountId: 'acct-1' });
    expect(result.kind).toBe('ok'); // something changed → NOT 404

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(2);
    const inputs = mockWriteAccountAuditLog.mock.calls.map((call) => call[0]);
    expect(inputs.map((input) => input.eventType)).toEqual(['channel_override_disabled', 'channel_override_disabled']);
    expect(inputs.map((input) => input.locationId)).toEqual(['loc-1', 'loc-2']);
  });

  it('full cascade: audits the org-default AND each override row', async () => {
    const tx = makeDisableTx([{ id: 'org-1' }], [{ id: 'ov-1', location_id: 'loc-1' }, { id: 'ov-2', location_id: 'loc-2' }]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(tx as unknown as postgres.TransactionSql, {
      accountId: 'acct-1',
      actorUserId: 'user-9',
      ip: '1.2.3.4',
      userAgent: 'jest',
      requestId: 'req-7',
    });
    expect(result.kind).toBe('ok');

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(3);
    const calls = mockWriteAccountAuditLog.mock.calls.map((call) => call[0]);

    const orgDefaultAudit = calls.find((input) => input.eventType === 'channel_disabled');
    expect(orgDefaultAudit).toBeDefined();
    expect(orgDefaultAudit!.locationId).toBeNull();
    expect(orgDefaultAudit!.actorUserId).toBe('user-9');

    const overrideAudits = calls.filter((input) => input.eventType === 'channel_override_disabled');
    expect(overrideAudits).toHaveLength(2);
    expect(overrideAudits.map((input) => input.locationId)).toEqual(['loc-1', 'loc-2']);
    expect(overrideAudits[0]!.entityType).toBe('channel_enrollment');
    expect(overrideAudits[0]!.entityId).toBe('ov-1');
    expect(overrideAudits[0]!.payload).toEqual({ channel: 'telegram' });

    // actor context threads through to the audit writes
    for (const input of calls) {
      expect(input.actorUserId).toBe('user-9');
      expect(input.ip).toBe('1.2.3.4');
      expect(input.userAgent).toBe('jest');
      expect(input.requestId).toBe('req-7');
    }
  });

  it('org-default UPDATE sets status=disabled, handle=NULL, filters account_id + location_id IS NULL', async () => {
    const tx = makeDisableTx([{ id: 'row-1' }], []);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    await disableTelegramEnrollment(tx as unknown as postgres.TransactionSql, { accountId: 'acct-1' });
    const orgSql = (tx.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    expect(orgSql).toContain("status = 'disabled'");
    expect(orgSql).toContain('handle = NULL');
    expect(orgSql).toContain('account_id =');
    expect(orgSql).toContain('location_id IS NULL');
    expect(orgSql).toContain("channel = 'telegram'");
    expect(orgSql).toContain("status = 'verified'");
    expect(orgSql).toContain('archived_at IS NULL');
  });

  it('override cascade UPDATE filters account_id + location_id IS NOT NULL + verified', async () => {
    const tx = makeDisableTx([], [{ id: 'ov-1', location_id: 'loc-1' }]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    await disableTelegramEnrollment(tx as unknown as postgres.TransactionSql, { accountId: 'acct-1' });
    const overrideSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray).join('?');
    expect(overrideSql).toContain('account_id =');
    expect(overrideSql).toContain('location_id IS NOT NULL');
    expect(overrideSql).toContain("channel = 'telegram'");
    expect(overrideSql).toContain("status = 'verified'");
    expect(overrideSql).toContain('archived_at IS NULL');
    expect(overrideSql).toContain('location_id'); // RETURNING id, location_id
  });

  it('no enroll/verify path re-enables override rows on reconnect (absence assertion)', async () => {
    // Reconnect = startTelegramEnrollment, which only touches the org-default
    // (location_id IS NULL) row. It must NEVER emit an UPDATE that flips an
    // override (location_id IS NOT NULL) row back to verified/pending.
    const tx = makeTx();
    tx.mockResolvedValueOnce([]); // SELECT
    tx.mockResolvedValueOnce([]); // INSERT
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await startTelegramEnrollment(tx as never, 'biz-1', 'acct-1', 'a'.repeat(64), new Date());
    const allSql = tx.mock.calls.map((call) => (call[0] as TemplateStringsArray).join('?')).join('\n');
    expect(allSql).not.toContain('location_id IS NOT NULL');
  });
});
