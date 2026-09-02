// Characterization test for rollbackProvisionedBusiness (A+ campaign 2c
// dedup). Before this change, the identical 4-DELETE provisioning-rollback
// transaction was inlined twice in admin-onboarding-service.ts — once in the
// inviteUserByEmail failure path, once in the auth_id link-failure path. This
// test pins the extracted helper's emitted SQL (text + bind order) so a
// future edit to one call site can't silently drift from the other.
//
// rollbackProvisionedBusiness is born-injected (sql is a parameter), so no
// module mocking is needed — the fragment-aware `createMockSql` harness
// (shared with worker suites) stands in for `sql`.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, AND WHY THAT MATTERED (D-8, 2026-09-02).
// Until 2026-09-02 these tests asserted the order job_outbox → users →
// accounts → businesses, and they PASSED — while the function could never
// remove a single row in production. `fk_businesses_account` has no
// ON DELETE CASCADE, so deleting `accounts` before `businesses` raises 23503
// and aborts the whole transaction. A mock `sql` has no foreign keys, so a
// characterization test over emitted SQL text pins the STATEMENTS and is blind
// to the CONSTRAINTS. It locked the bug in rather than catching it.
//
// The order assertion below is therefore necessary and NOT sufficient. The
// sufficient check is the live-DB sibling,
// `admin-onboarding-rollback.integration.test.ts`, which seeds real rows and
// asserts they are actually gone.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { rollbackProvisionedBusiness } from '../admin-onboarding-service';

const createdResult = {
  businessId: 'business-uuid-1',
  userId: 'user-uuid-1',
  accountId: 'account-uuid-1',
};

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('rollbackProvisionedBusiness', () => {
  it('runs all 4 DELETEs inside a single sql.begin transaction', async () => {
    await rollbackProvisionedBusiness(mockSql, createdResult);

    expect(harness.mockSql.begin).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls).toHaveLength(4);
  });

  it('emits the DELETEs in FK-significant order: job_outbox, users, businesses, accounts', async () => {
    await rollbackProvisionedBusiness(mockSql, createdResult);

    const statements = harness.sqlCalls.map((call) => call.text);
    expect(statements).toEqual([
      'DELETE FROM job_outbox WHERE aggregate_id = ?::uuid',
      'DELETE FROM users WHERE id = ?::uuid',
      'DELETE FROM businesses WHERE id = ?::uuid',
      'DELETE FROM accounts WHERE id = ?::uuid',
    ]);
  });

  it('deletes businesses BEFORE accounts — fk_businesses_account has no cascade (D-8)', async () => {
    await rollbackProvisionedBusiness(mockSql, createdResult);

    const statements = harness.sqlCalls.map((call) => call.text);
    const businessesAt = statements.findIndex((t) => t.includes('DELETE FROM businesses'));
    const accountsAt = statements.findIndex((t) => t.includes('DELETE FROM accounts'));

    expect(businessesAt).toBeGreaterThanOrEqual(0);
    expect(accountsAt).toBeGreaterThanOrEqual(0);
    // Reversing these two is the 2026-09-02 production defect: `accounts` first
    // raises 23503 against the still-present `businesses` row, which aborts the
    // enclosing sql.begin and rolls back EVERY delete in it.
    expect(businessesAt).toBeLessThan(accountsAt);
  });

  it('binds each DELETE to the matching id from createdResult', async () => {
    await rollbackProvisionedBusiness(mockSql, createdResult);

    expect(harness.sqlCalls.map((call) => call.values)).toEqual([
      [createdResult.businessId],
      [createdResult.userId],
      [createdResult.businessId],
      [createdResult.accountId],
    ]);
  });

  it('propagates a failure from inside the transaction (no swallowing)', async () => {
    const txError = new Error('synthetic tx failure');
    harness.mockSql.begin.mockRejectedValueOnce(txError);

    await expect(
      rollbackProvisionedBusiness(mockSql, createdResult),
    ).rejects.toThrow(txError);
  });
});
