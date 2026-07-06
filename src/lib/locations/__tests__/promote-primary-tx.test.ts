// src/lib/locations/__tests__/promote-primary-tx.test.ts
//
// TDD assertions for src/lib/locations/promote-primary-tx.ts.
// Tests: promotePrimaryTransaction.
//
// Feature spec:
//   - Primary promotion changes is_primary atomically from old to new
//   - Exactly one primary per active account maintained by partial unique index
//   - Audit log records the promotion event

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  // Identity .json stub: the module now binds jsonb via the injected client's
  // tx.json(...) (byte-identical to the old jsonb() helper).
  sqlFn.json = (v: unknown) => v;
  return { mockSql: sqlFn };
});

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7-promote-000000000001'),
}));

import type { Sql } from 'postgres';
import {
  promotePrimaryTransaction,
  type PromotePrimaryTxInput,
} from '../promote-primary-tx';

// The injected sql client IS the mock — assertions still read mockSql.mock.calls.
const sql = mockSql as unknown as Sql;

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OLD_PRIMARY_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const NEW_PRIMARY_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkInput(overrides: Partial<PromotePrimaryTxInput> = {}): PromotePrimaryTxInput {
  return {
    accountId: ACCOUNT_ID,
    newPrimaryId: NEW_PRIMARY_ID,
    actorUserId: ACTOR_USER_ID,
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
});

// ══════════════════════════════════════════════════════════════════════════
// promotePrimaryTransaction
// ══════════════════════════════════════════════════════════════════════════

describe('promotePrimaryTransaction', () => {
  // Helper: set up mocks for a successful promote transaction.
  // All validation happens INSIDE the tx, under the locks: account lock,
  // target row lock (filters archived), demotion UPDATE RETURNING,
  // promotion UPDATE RETURNING, audit INSERT.
  function setupPromoteMocks() {
    mockSql.mockResolvedValueOnce([{ id: ACCOUNT_ID }]); // account lock
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      is_primary: false,
    }]); // target row lock
    mockSql.mockResolvedValueOnce([{ id: OLD_PRIMARY_ID }]); // demotion UPDATE RETURNING
    mockSql.mockResolvedValueOnce([{ id: NEW_PRIMARY_ID }]); // promotion UPDATE RETURNING
    mockSql.mockResolvedValueOnce([]); // audit INSERT
  }

  // Atomically changes is_primary from old to new
  it('sets is_primary = FALSE on old primary and is_primary = TRUE on new primary atomically', async () => {
    setupPromoteMocks();

    const result = await promotePrimaryTransaction(sql, mkInput());

    expect(result.oldPrimaryId).toBe(OLD_PRIMARY_ID);
    expect(result.newPrimaryId).toBe(NEW_PRIMARY_ID);
    expect(mockSql.begin).toHaveBeenCalled();
  });

  // Zero-primary repair: promoting an active location heals an account with no
  // current primary. The demotion UPDATE returns 0 rows; this must NOT throw.
  it('repairs a zero-primary account: demotion returns 0 rows, oldPrimaryId is null', async () => {
    mockSql.mockResolvedValueOnce([{ id: ACCOUNT_ID }]); // account lock
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      is_primary: false,
    }]); // target row lock
    mockSql.mockResolvedValueOnce([]); // demotion UPDATE RETURNING — zero-primary account
    mockSql.mockResolvedValueOnce([{ id: NEW_PRIMARY_ID }]); // promotion UPDATE RETURNING
    mockSql.mockResolvedValueOnce([]); // audit INSERT

    const result = await promotePrimaryTransaction(sql, mkInput());

    expect(result.oldPrimaryId).toBeNull();
    expect(result.newPrimaryId).toBe(NEW_PRIMARY_ID);

    // Promotion + audit still run (zero-primary is a valid, healed state)
    const auditCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
  });

  // Both UPDATEs happen inside the same transaction
  it('both UPDATEs run in the same sql.begin() call', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(sql, mkInput());

    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // Inside the tx: UPDATE old primary, UPDATE new primary, INSERT audit
    const txCalls = mockSql.mock.calls;
    const updateCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    // Should have at least 2 UPDATEs (old primary → FALSE, new primary → TRUE)
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  // Sets is_primary = FALSE on the old primary
  it('first UPDATE sets is_primary = FALSE on the old primary', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls;
    const updateCall = txCalls.find(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('UPDATE businesses') && template.includes('FALSE');
      },
    );
    expect(updateCall).toBeDefined();
  });

  // Sets is_primary = TRUE on the new primary
  it('second UPDATE sets is_primary = TRUE on the new primary', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls;
    const updateCall = txCalls.find(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('UPDATE businesses') && template.includes('TRUE');
      },
    );
    expect(updateCall).toBeDefined();
  });

  // Rejects if new primary doesn't exist or doesn't belong to account
  it('throws location_not_found if new primary does not exist or does not belong to account', async () => {
    mockSql.mockResolvedValueOnce([{ id: ACCOUNT_ID }]); // account lock
    mockSql.mockResolvedValueOnce([]); // in-tx target lock returns no rows

    await expect(promotePrimaryTransaction(sql, mkInput())).rejects.toThrow(
      'location_not_found',
    );
  });

  // Rejects if new primary is already the primary
  it('throws already_primary if new primary is already the primary', async () => {
    mockSql.mockResolvedValueOnce([{ id: ACCOUNT_ID }]); // account lock
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      is_primary: true, // already primary
    }]); // in-tx target lock

    await expect(promotePrimaryTransaction(sql, mkInput())).rejects.toThrow(
      'already_primary',
    );
  });

  // An archived target never matches the in-tx locked SELECT (it filters
  // archived_at IS NULL), so it surfaces as location_not_found — there is
  // no separate "archived" error in the tx vocabulary.
  it('archived target surfaces as location_not_found (in-tx SELECT filters archived)', async () => {
    mockSql.mockResolvedValueOnce([{ id: ACCOUNT_ID }]); // account lock
    mockSql.mockResolvedValueOnce([]); // archived target filtered out by archived_at IS NULL

    await expect(promotePrimaryTransaction(sql, mkInput())).rejects.toThrow(
      'location_not_found',
    );
  });

  // Inserts audit log with event_type 'primary_promoted'
  it('inserts audit log with event_type primary_promoted', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const template = (auditCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('primary_promoted');
  });

  // Audit payload includes old and new primary IDs
  it('audit payload includes old_primary_id and new_primary_id', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
  });

  // Transaction rolls back on failure
  it('rolls back entire transaction if any step fails', async () => {
    // Make the transaction throw
    mockSql.begin = vi.fn(async (_cb: (tx: any) => Promise<unknown>) => {
      throw new Error('audit INSERT failed');
    });

    await expect(promotePrimaryTransaction(sql, mkInput())).rejects.toThrow(
      'audit INSERT failed',
    );
  });

  it('throws location_not_found and skips demote/audit when the target archives before the in-tx lock', async () => {
    mockSql.mockResolvedValueOnce([{ id: ACCOUNT_ID }]); // account lock
    mockSql.mockResolvedValueOnce([]); // target archived under the lock → filtered out

    await expect(promotePrimaryTransaction(sql, mkInput())).rejects.toThrow(
      'location_not_found',
    );

    const demoteCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('SET is_primary = FALSE'),
    );
    const auditCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(demoteCall).toBeUndefined();
    expect(auditCall).toBeUndefined();
  });
});
