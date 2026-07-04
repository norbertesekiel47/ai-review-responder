import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
  type RecordedSqlCall,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { createApprovalLink } from '../create-link';

vi.mock('uuid', () => ({ v7: () => 'uuid-v7-fixture' }));

let harness: MockSqlHarness;
let mockSql: Sql;

function updateCalls(): RecordedSqlCall[] {
  return harness.sqlCalls.filter((call) => /UPDATE approval_links/i.test(call.text));
}

function insertCalls(): RecordedSqlCall[] {
  return harness.sqlCalls.filter((call) => /INSERT INTO approval_links/i.test(call.text));
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('createApprovalLink — channel-aware', () => {
  it('inserts approval_links row with the provided channel', async () => {
    harness.sqlReturnQueue.push([]); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push([]); // existingDelivery SELECT — no prior delivery

    const { rawToken, tokenHash, approvalLinkId } = await createApprovalLink(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'telegram',
    });

    expect(rawToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenHash).toHaveLength(64);
    expect(approvalLinkId).toBe('uuid-v7-fixture');
    expect(insertCalls()).toHaveLength(1);
    const insertQuery = harness.sqlCalls.find((call) => /INSERT INTO approval_links/i.test(call.text))!;
    expect(insertQuery.text).toMatch(/INSERT INTO approval_links/);
    expect(insertQuery.values).toContain('telegram');
  });

  it('orphaned_only revokes ONLY same-channel non-consumed links', async () => {
    harness.sqlReturnQueue.push([]); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push([]); // existingDelivery SELECT — no prior delivery → shouldRevoke

    await createApprovalLink(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'telegram',
      revokeMode: 'orphaned_only',
    });

    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0]!.text).toMatch(/channel\s*=/i);
  });

  it('orphaned_only does NOT revoke when a prior same-channel delivery exists', async () => {
    harness.sqlReturnQueue.push([]); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push([{ id: 'prior-delivery-id' }]); // existingDelivery SELECT — prior delivery exists

    await createApprovalLink(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'email',
      revokeMode: 'orphaned_only',
    });

    expect(updateCalls()).toHaveLength(0);
    expect(insertCalls()).toHaveLength(1);
  });

  it('always-mode revokes same-channel links unconditionally', async () => {
    harness.sqlReturnQueue.push([]); // pg_advisory_xact_lock

    await createApprovalLink(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'email',
      revokeMode: 'always',
    });

    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0]!.text).toMatch(/channel\s*=/i);
  });
});
