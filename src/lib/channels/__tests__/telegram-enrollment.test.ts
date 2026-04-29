// src/lib/channels/__tests__/telegram-enrollment.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      'a'.repeat(64),
      expiresAt,
    );
    expect(result.kind).toBe('ok');
    expect(tx).toHaveBeenCalledTimes(2);
  });

  it('updates an existing pending row to a fresh hash', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'pending_verification' }]);
    tx.mockResolvedValueOnce([]); // UPDATE
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'b'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('updates an unsubscribed row to pending', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'unsubscribed' }]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'c'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('updates a disabled row to pending', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'disabled' }]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'd'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('returns already_verified when row.status is verified', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'verified' }]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'e'.repeat(64), new Date());
    expect(result.kind).toBe('already_verified');
    expect(tx).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
  });

  it('throws MultipleMobileChannelsError on 23505 + matching constraint', async () => {
    const err = new Error('duplicate key') as Error & { code: string; constraint_name: string };
    err.code = '23505';
    err.constraint_name = 'channel_enrollments_one_mobile_per_biz';
    tx.mockResolvedValueOnce([]); // SELECT
    tx.mockRejectedValueOnce(err); // INSERT throws
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const { MultipleMobileChannelsError } = await import('../unique-violation');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'f'.repeat(64), new Date()),
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
      startTelegramEnrollment(tx as never, 'biz-123', 'g'.repeat(64), new Date()),
    ).rejects.toThrow(EnrollmentDatabaseError);
  });

  it('rethrows non-23505 errors unchanged', async () => {
    const err = new Error('serialization failure') as Error & { code: string };
    err.code = '40001';
    tx.mockResolvedValueOnce([]);
    tx.mockRejectedValueOnce(err);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'h'.repeat(64), new Date()),
    ).rejects.toThrow('serialization failure');
  });

  it('SELECTs the enrollment row with FOR UPDATE (serializes against webhook)', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await startTelegramEnrollment(tx as never, 'biz-123', 'j'.repeat(64), new Date());
    const selectSql = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(selectSql).toContain('FOR UPDATE');
  });

  it('does NOT emit pg_advisory_xact_lock SQL (caller responsibility)', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await startTelegramEnrollment(tx as never, 'biz-123', 'i'.repeat(64), new Date());
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
    const result = await cancelTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('ok');
  });

  it('returns not_found when UPDATE affects 0 rows', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await cancelTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('not_found');
  });

  it('does NOT open sql.begin (single-statement)', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    // sql does not have a `begin` method on the mock — if the helper called
    // sql.begin, the test would throw TypeError. Verify by attempting
    // a plain call afterward.
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    await expect(cancelTelegramEnrollment(sql as never, 'biz-123')).resolves.toBeDefined();
  });

  it('SQL sets status = disabled and disabled_at = NOW()', async () => {
    const sql = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    await cancelTelegramEnrollment(sql as never, 'biz-123');
    // Introspect the template-strings array from the single tagged-template call.
    const firstCall = sql.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sqlText = (firstCall![0] as TemplateStringsArray).join('?');
    expect(sqlText).toContain("status = 'disabled'");
    expect(sqlText).toContain('disabled_at = NOW()');
  });

  it('after cancel a subsequent startTelegramEnrollment on the same business succeeds (disabled → pending branch)', async () => {
    // Mock sequence: startTelegramEnrollment does a SELECT that returns the
    // disabled row left by the cancel, then an UPDATE to pending_verification.
    const tx = vi.fn()
      .mockResolvedValueOnce([{ id: 'row-1', status: 'disabled' }]) // SELECT
      .mockResolvedValueOnce([]);                                      // UPDATE
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(
      tx as never,
      'biz-123',
      'a'.repeat(64),
      new Date('2026-04-28T14:00:00.000Z'),
    );
    expect(result.kind).toBe('ok');
    // Two calls: SELECT + UPDATE (the UPDATE branch for existing disabled row).
    expect(tx).toHaveBeenCalledTimes(2);
  });
});

describe('disableTelegramEnrollment', () => {
  it('returns ok when UPDATE affects rows', async () => {
    const sql = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('ok');
  });

  it('returns not_found when UPDATE affects 0 rows', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('not_found');
  });
});
