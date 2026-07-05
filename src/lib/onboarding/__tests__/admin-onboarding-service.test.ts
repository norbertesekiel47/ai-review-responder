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

  it('emits the DELETEs in FK-cascade-significant order: job_outbox, users, accounts, businesses', async () => {
    await rollbackProvisionedBusiness(mockSql, createdResult);

    const statements = harness.sqlCalls.map((call) => call.text);
    expect(statements).toEqual([
      'DELETE FROM job_outbox WHERE aggregate_id = ?::uuid',
      'DELETE FROM users WHERE id = ?::uuid',
      'DELETE FROM accounts WHERE id = ?::uuid',
      'DELETE FROM businesses WHERE id = ?::uuid',
    ]);
  });

  it('binds each DELETE to the matching id from createdResult', async () => {
    await rollbackProvisionedBusiness(mockSql, createdResult);

    expect(harness.sqlCalls.map((call) => call.values)).toEqual([
      [createdResult.businessId],
      [createdResult.userId],
      [createdResult.accountId],
      [createdResult.businessId],
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
