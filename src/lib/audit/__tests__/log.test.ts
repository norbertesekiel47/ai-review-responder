import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
import { writeAccountAuditLog, writeAdminAuditLog } from '../log';

vi.mock('uuid', () => ({
  v7: vi.fn(() => '019dc366-29ce-7000-a000-000000000043'),
}));

describe('writeAccountAuditLog', () => {
  // Two separate harnesses model the function's two real call shapes: the
  // base client (standalone, best-effort writes — e.g. the MFA challenge
  // route) and a transaction client (the SAME transaction as the caller's
  // state change — CLAUDE.md's documented contract for account-status writes).
  let sqlHarness: MockSqlHarness;
  let txHarness: MockSqlHarness;

  beforeEach(() => {
    sqlHarness = createMockSql();
    txHarness = createMockSql();
  });

  it('writes required fields against the base sql client', async () => {
    await writeAccountAuditLog(sqlHarness.mockSql as unknown as Sql, {
      accountId: 'acct-1',
      eventType: 'subscription_status_changed',
      payload: { fromStatus: 'active', toStatus: 'past_due' },
    });

    expect(sqlHarness.sqlCalls).toHaveLength(1);
    expect(sqlHarness.sqlCalls[0]!.text).toMatch(/INSERT INTO account_audit_log/i);
    expect(sqlHarness.sqlCalls[0]!.text).toMatch(/event_type/i);
    expect(sqlHarness.sqlCalls[0]!.values).toContain('acct-1');
    expect(sqlHarness.sqlCalls[0]!.values).toContain('subscription_status_changed');
    expect(sqlHarness.sqlCalls[0]!.values).toContainEqual({
      fromStatus: 'active',
      toStatus: 'past_due',
    });
    expect(txHarness.sqlCalls).toHaveLength(0);
  });

  it('uses an injected transaction client', async () => {
    await writeAccountAuditLog(txHarness.mockSql as unknown as TransactionSql, {
      accountId: 'acct-1',
      eventType: 'subscription_status_changed',
      payload: { fromStatus: 'past_due', toStatus: 'active' },
    });

    expect(sqlHarness.sqlCalls).toHaveLength(0);
    expect(txHarness.sqlCalls).toHaveLength(1);
  });

  it('writes optional metadata fields', async () => {
    await writeAccountAuditLog(sqlHarness.mockSql as unknown as Sql, {
      accountId: 'acct-1',
      locationId: 'biz-location-1',
      actorUserId: 'user-1',
      eventType: 'csv_bulk_import',
      entityType: 'business',
      entityId: 'entity-business-1',
      ip: '203.0.113.10',
      userAgent: 'Vitest',
      requestId: 'req-123',
      payload: { created: 3 },
    });

    const values = sqlHarness.sqlCalls[0]!.values;
    expect(values).toContain('biz-location-1');
    expect(values).toContain('user-1');
    expect(values).toContain('business');
    expect(values).toContain('entity-business-1');
    expect(values).toContain('203.0.113.10');
    expect(values).toContain('Vitest');
    expect(values).toContain('req-123');
  });
});

describe('writeAdminAuditLog', () => {
  let sqlHarness: MockSqlHarness;

  beforeEach(() => {
    sqlHarness = createMockSql();
  });

  it('writes an admin_audit_log row keyed on the actor, with no account column at all', async () => {
    await writeAdminAuditLog(sqlHarness.mockSql as unknown as Sql, {
      actorUserId: 'admin-1',
      eventType: 'mfa_factor_unenrolled',
      payload: { factor_id: 'factor-1' },
    });

    expect(sqlHarness.sqlCalls).toHaveLength(1);
    const call = sqlHarness.sqlCalls[0]!;
    expect(call.text).toMatch(/INSERT INTO admin_audit_log/i);
    expect(call.text).not.toMatch(/account_id/i);
    expect(call.values).toContain('admin-1');
    expect(call.values).toContain('mfa_factor_unenrolled');
    expect(call.values).toContainEqual({ factor_id: 'factor-1' });
  });

  it('writes optional metadata fields', async () => {
    await writeAdminAuditLog(sqlHarness.mockSql as unknown as TransactionSql, {
      actorUserId: 'admin-1',
      eventType: 'mfa_factor_enrolled',
      payload: {},
      entityType: 'mfa_factor',
      entityId: 'factor-9',
      ip: '203.0.113.10',
      userAgent: 'Vitest',
      requestId: 'req-468',
    });

    const values = sqlHarness.sqlCalls[0]!.values;
    expect(values).toContain('mfa_factor');
    expect(values).toContain('factor-9');
    expect(values).toContain('203.0.113.10');
    expect(values).toContain('Vitest');
    expect(values).toContain('req-468');
  });
});
