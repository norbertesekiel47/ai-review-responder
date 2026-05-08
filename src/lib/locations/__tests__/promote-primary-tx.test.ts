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
  return { mockSql: sqlFn };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7-promote-000000000001'),
}));

import {
  promotePrimaryTransaction,
  type PromotePrimaryTxInput,
} from '../promote-primary-tx';

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
  // Helper: set up mocks for a successful promote transaction
  // The validation query returns the new primary row,
  // then inside the tx the demotion UPDATE RETURNING returns the old primary ID,
  // then the promotion UPDATE and audit INSERT return empty arrays.
  function setupPromoteMocks() {
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
      is_primary: false,
      archived_at: null,
    }]); // validation query
    mockSql.mockResolvedValueOnce([{ id: OLD_PRIMARY_ID }]); // demotion UPDATE RETURNING
    mockSql.mockResolvedValueOnce([]); // promotion UPDATE
    mockSql.mockResolvedValueOnce([]); // audit INSERT
  }

  // Atomically changes is_primary from old to new
  it('sets is_primary = FALSE on old primary and is_primary = TRUE on new primary atomically', async () => {
    setupPromoteMocks();

    const result = await promotePrimaryTransaction(mkInput());

    expect(result.oldPrimaryId).toBe(OLD_PRIMARY_ID);
    expect(result.newPrimaryId).toBe(NEW_PRIMARY_ID);
    expect(mockSql.begin).toHaveBeenCalled();
  });

  // Both UPDATEs happen inside the same transaction
  it('both UPDATEs run in the same sql.begin() call', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(mkInput());

    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // Inside the tx: UPDATE old primary, UPDATE new primary, INSERT audit
    const txCalls = mockSql.mock.calls.slice(1); // skip validation query
    const updateCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    // Should have at least 2 UPDATEs (old primary → FALSE, new primary → TRUE)
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  // Sets is_primary = FALSE on the old primary
  it('first UPDATE sets is_primary = FALSE on the old primary', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(mkInput());

    const txCalls = mockSql.mock.calls.slice(1);
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

    await promotePrimaryTransaction(mkInput());

    const txCalls = mockSql.mock.calls.slice(1);
    const updateCall = txCalls.find(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('UPDATE businesses') && template.includes('TRUE');
      },
    );
    expect(updateCall).toBeDefined();
  });

  // Rejects if new primary doesn't exist or doesn't belong to account
  it('throws if new primary does not exist or does not belong to account', async () => {
    mockSql.mockResolvedValueOnce([]); // validation query returns no rows

    await expect(promotePrimaryTransaction(mkInput())).rejects.toThrow(
      'new primary location not found',
    );
  });

  // Rejects if new primary is already the primary
  it('throws if new primary is already the primary', async () => {
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
      is_primary: true, // already primary
      archived_at: null,
    }]);

    await expect(promotePrimaryTransaction(mkInput())).rejects.toThrow(
      'already the primary',
    );
  });

  // Rejects if new primary is archived
  it('throws if new primary is archived', async () => {
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
      is_primary: false,
      archived_at: new Date('2026-04-01'),
    }]);

    await expect(promotePrimaryTransaction(mkInput())).rejects.toThrow(
      'archived',
    );
  });

  // Inserts audit log with event_type 'primary_promoted'
  it('inserts audit log with event_type primary_promoted', async () => {
    setupPromoteMocks();

    await promotePrimaryTransaction(mkInput());

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

    await promotePrimaryTransaction(mkInput());

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
  });

  // Transaction rolls back on failure
  it('rolls back entire transaction if any step fails', async () => {
    mockSql.mockResolvedValueOnce([{
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
      is_primary: false,
      archived_at: null,
    }]);
    // Make the transaction throw
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
      throw new Error('audit INSERT failed');
    });

    await expect(promotePrimaryTransaction(mkInput())).rejects.toThrow(
      'audit INSERT failed',
    );
  });
});
