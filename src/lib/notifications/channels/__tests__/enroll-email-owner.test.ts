// enrollOwnerEmailChannel is born-injected (sql is a parameter), so no
// module mocking is needed — the fragment-aware `createMockSql` harness
// (shared with worker suites) stands in for `sql`.
//
// This suite pins the byte-sensitive ON CONFLICT predicate: it must match
// the post-migration-034 partial unique index on channel_enrollments
// verbatim, or Postgres silently fails to recognize the constraint.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../../worker/__tests__/helpers/mock-sql';
import { enrollOwnerEmailChannel } from '../enroll-email-owner';

const EXPECTED_ON_CONFLICT =
  "ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO NOTHING";

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('enrollOwnerEmailChannel', () => {
  it('issues a single INSERT INTO channel_enrollments with the expected columns/values', async () => {
    await enrollOwnerEmailChannel(mockSql, {
      accountId: 'acct-1',
      businessId: 'biz-1',
      ownerEmail: 'owner@example.com',
    });

    expect(harness.sqlCalls).toHaveLength(1);
    const query = harness.sqlCalls[0]!;
    expect(query.text).toContain('INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)');
    expect(query.text).toContain("'email'");
    expect(query.text).toContain("'verified'");
    expect(query.values).toContain('acct-1');
    expect(query.values).toContain('biz-1');
    expect(query.values).toContain('owner@example.com');
  });

  it('pins the ON CONFLICT predicate byte-for-byte against the post-migration-034 partial unique index', async () => {
    await enrollOwnerEmailChannel(mockSql, {
      accountId: 'acct-1',
      businessId: 'biz-1',
      ownerEmail: 'owner@example.com',
    });

    const query = harness.sqlCalls[0]!;
    expect(query.text).toContain(EXPECTED_ON_CONFLICT);
  });

  it('targets channel_enrollments with channel="email" and status="verified"', async () => {
    await enrollOwnerEmailChannel(mockSql, {
      accountId: 'acct-2',
      businessId: 'biz-2',
      ownerEmail: 'second-owner@example.com',
    });

    const query = harness.sqlCalls[0]!;
    expect(query.text.trim().startsWith('INSERT INTO channel_enrollments')).toBe(true);
    expect(query.text).toContain("'email', ?, 'verified', NOW()");
  });
});
