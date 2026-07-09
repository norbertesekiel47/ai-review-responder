// Unit coverage for vetoAutoPost (WS4 plan Task 8, spec §2.6): the owner veto
// of a scheduled auto-post. Collaborators (locks/audit/run-spine/outbox
// helpers) are mocked; the module's own three statements run against the
// shared fragment-aware Postgres.js mock so the guarded UPDATE shapes are
// pinned as text. The FIFO queue order mirrors the module's statement order:
//   1. SELECT … FROM responses … FOR UPDATE
//   2. UPDATE job_outbox … RETURNING id        (the atomic kill)
//   3. UPDATE responses … RETURNING id         (the guarded downgrade)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TransactionSql } from 'postgres';

import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

const {
  mockConsumeLink,
  mockInsertAuditLog,
  mockEnqueueSendNotification,
  mockFindActiveReviewRun,
  mockRecordOutcome,
} = vi.hoisted(() => ({
  mockConsumeLink: vi.fn(),
  mockInsertAuditLog: vi.fn(),
  mockEnqueueSendNotification: vi.fn(),
  mockFindActiveReviewRun: vi.fn(),
  mockRecordOutcome: vi.fn(),
}));

vi.mock('../locks', () => ({
  consumeLink: mockConsumeLink,
}));
vi.mock('../audit', () => ({
  insertAuditLog: mockInsertAuditLog,
}));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueueSendNotification: mockEnqueueSendNotification,
}));
vi.mock('@/lib/agents/run-spine', () => ({
  findActiveReviewRun: mockFindActiveReviewRun,
  recordOutcome: mockRecordOutcome,
}));

import { vetoAutoPost, AUTO_POST_VETOED_BY_OWNER } from '../veto';
import type { ApprovalLink } from '../types';

const LINK: ApprovalLink = {
  id: 'link-1',
  response_id: 'resp-1',
  business_id: 'biz-1',
  token_hash: 'hash-abc',
  channel: 'email',
  expires_at: new Date('2026-12-31T00:00:00Z'),
  consumed_at: null,
  revoked_at: null,
  device_cookie_hash: 'device-hash',
  created_at: new Date('2026-07-01T00:00:00Z'),
};

const AUDIT = {
  tokenHash: 'hash-abc',
  deviceCookieHash: 'device-hash',
  ipAddress: '203.0.113.7',
};

const SCHEDULED_RESPONSE = {
  status: 'approved',
  approval_method: 'auto_policy',
  posting_error: null,
  review_id: 'rev-1',
};

let harness: MockSqlHarness;

function tx(): TransactionSql {
  return harness.mockSql as unknown as TransactionSql;
}

beforeEach(() => {
  harness = createMockSql();
  vi.clearAllMocks();
  mockFindActiveReviewRun.mockResolvedValue({ id: 'run-1', account_id: 'acct-1' });
});

describe('vetoAutoPost — cancelled (happy path)', () => {
  beforeEach(() => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([SCHEDULED_RESPONSE]), // responses FOR UPDATE
      mkTaggedResult([{ id: 'outbox-1' }]), // job_outbox kill
      mkTaggedResult([{ id: 'resp-1' }]), // responses downgrade
    );
  });

  it('kills the pending publish row with the guarded UPDATE shape', async () => {
    await expect(vetoAutoPost(tx(), LINK, AUDIT, 'corr-1')).resolves.toBe('cancelled');

    const kill = harness.sqlCalls.find((c) => c.text.includes('UPDATE job_outbox'));
    expect(kill).toBeDefined();
    expect(kill!.text).toContain("SET status = 'completed'");
    expect(kill!.text).toContain('completed_at = NOW()');
    expect(kill!.text).toContain('last_error = ?');
    expect(kill!.text).toContain('WHERE topic = ?');
    expect(kill!.text).toContain('AND aggregate_id = ?');
    expect(kill!.text).toContain("AND status = 'pending'");
    expect(kill!.text).toContain('RETURNING id');
    expect(kill!.values).toEqual([AUTO_POST_VETOED_BY_OWNER, 'publish_response', 'resp-1']);
  });

  it('downgrades the response with the kill-switch-precedent guarded UPDATE', async () => {
    await vetoAutoPost(tx(), LINK, AUDIT, 'corr-1');

    const downgrade = harness.sqlCalls.find((c) => c.text.includes('UPDATE responses'));
    expect(downgrade).toBeDefined();
    expect(downgrade!.text).toContain("SET status = 'pending_approval'");
    expect(downgrade!.text).toContain('approval_method = NULL');
    expect(downgrade!.text).toContain('approved_at = NULL');
    expect(downgrade!.text).toContain('approved_text = NULL');
    expect(downgrade!.text).toContain('auto_post_scheduled_at = NULL');
    expect(downgrade!.text).toContain('posting_error = ?');
    // Guarded: only the still-auto-approved row downgrades.
    expect(downgrade!.text).toContain("AND status = 'approved'");
    expect(downgrade!.text).toContain('AND approval_method = ?');
    expect(downgrade!.values).toEqual([
      AUTO_POST_VETOED_BY_OWNER, 'resp-1', 'biz-1', 'auto_policy',
    ]);
  });

  it("writes the 'veto_cancel' audit row, records the outcome, re-notifies, and consumes the link", async () => {
    await vetoAutoPost(tx(), LINK, AUDIT, 'corr-1');

    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      tx(), 'resp-1', 'biz-1', 'veto_cancel', AUDIT, { correlation_id: 'corr-1' },
    );
    expect(mockFindActiveReviewRun).toHaveBeenCalledWith(tx(), 'rev-1');
    expect(mockRecordOutcome).toHaveBeenCalledWith(tx(), {
      runId: 'run-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      attributedAgent: 'reply',
      outcomeKind: 'reply_vetoed_by_owner',
    });
    expect(mockEnqueueSendNotification).toHaveBeenCalledWith(tx(), {
      responseId: 'resp-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });
    expect(mockConsumeLink).toHaveBeenCalledWith(tx(), 'link-1');
  });

  it('locks the response FIRST (approval-lane lock order: responses → rest)', async () => {
    await vetoAutoPost(tx(), LINK, AUDIT);

    const first = harness.sqlCalls[0];
    expect(first).toBeDefined();
    expect(first!.text).toContain('FROM responses');
    expect(first!.text).toContain('FOR UPDATE');
    expect(first!.values).toEqual(['resp-1', 'biz-1']);
  });
});

describe('vetoAutoPost — too_late', () => {
  it('returns too_late when the outbox row is no longer pending, mutating NOTHING after the probe', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([SCHEDULED_RESPONSE]), // responses FOR UPDATE
      mkTaggedResult([]), // job_outbox kill — 0 rows: publisher already claimed
    );

    await expect(vetoAutoPost(tx(), LINK, AUDIT)).resolves.toBe('too_late');

    expect(harness.sqlCalls.some((c) => c.text.includes('UPDATE responses'))).toBe(false);
    expect(mockConsumeLink).not.toHaveBeenCalled();
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockEnqueueSendNotification).not.toHaveBeenCalled();
  });

  it('returns too_late for an already-posted response without touching the outbox', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ ...SCHEDULED_RESPONSE, status: 'posted' }]),
    );

    await expect(vetoAutoPost(tx(), LINK, AUDIT)).resolves.toBe('too_late');

    expect(harness.sqlCalls).toHaveLength(1);
    expect(mockConsumeLink).not.toHaveBeenCalled();
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('returns too_late when the response row does not exist', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await expect(vetoAutoPost(tx(), LINK, AUDIT)).resolves.toBe('too_late');
    expect(harness.sqlCalls).toHaveLength(1);
  });
});

describe('vetoAutoPost — already_cancelled', () => {
  it('recognizes the veto marker on an already-downgraded response (double-tap idempotency)', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{
        status: 'pending_approval',
        approval_method: null,
        posting_error: AUTO_POST_VETOED_BY_OWNER,
        review_id: 'rev-1',
      }]),
    );

    await expect(vetoAutoPost(tx(), LINK, AUDIT)).resolves.toBe('already_cancelled');

    expect(harness.sqlCalls).toHaveLength(1);
    expect(mockConsumeLink).not.toHaveBeenCalled();
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueSendNotification).not.toHaveBeenCalled();
  });
});

describe('vetoAutoPost — legacy/no-run posture', () => {
  it('skips the outcome when no running run exists but completes everything else', async () => {
    mockFindActiveReviewRun.mockResolvedValue(null);
    harness.sqlReturnQueue.push(
      mkTaggedResult([SCHEDULED_RESPONSE]),
      mkTaggedResult([{ id: 'outbox-1' }]),
      mkTaggedResult([{ id: 'resp-1' }]),
    );

    await expect(vetoAutoPost(tx(), LINK, AUDIT, 'corr-2')).resolves.toBe('cancelled');

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockConsumeLink).toHaveBeenCalledWith(tx(), 'link-1');
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      tx(), 'resp-1', 'biz-1', 'veto_cancel', AUDIT, { correlation_id: 'corr-2' },
    );
    expect(mockEnqueueSendNotification).toHaveBeenCalledWith(tx(), {
      responseId: 'resp-1',
      businessId: 'biz-1',
      correlationId: 'corr-2',
    });
  });
});

describe('vetoAutoPost — defensive rollback', () => {
  it('throws veto_downgrade_lost_response when the kill landed but the guarded downgrade hit 0 rows', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([SCHEDULED_RESPONSE]),
      mkTaggedResult([{ id: 'outbox-1' }]), // kill succeeded
      mkTaggedResult([]), // downgrade lost the response — impossible under the lock
    );

    await expect(vetoAutoPost(tx(), LINK, AUDIT)).rejects.toThrow('veto_downgrade_lost_response');

    expect(mockConsumeLink).not.toHaveBeenCalled();
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueSendNotification).not.toHaveBeenCalled();
  });
});
