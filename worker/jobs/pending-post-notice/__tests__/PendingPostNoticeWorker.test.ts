import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { PendingPostNoticePayload } from '../../../../src/lib/shared/worker-types';

const { mockSql, resetMockSql, mockLogger } = await vi.hoisted(async () => {
  const { createMockSql, mockWorkerLogger } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mockLogger: mockWorkerLogger() };
});

const mocks = vi.hoisted(() => ({
  autoApprovalRuntimeEnabled: vi.fn(() => true),
  loadPendingPostNoticeContext: vi.fn(),
  dispatchPendingPostNotice: vi.fn(),
  getEligibleChannels: vi.fn(),
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'ob-1', attempt: 1 })),
}));

vi.mock('../../../../src/lib/auto-approval/flags', () => ({
  autoApprovalRuntimeEnabled: mocks.autoApprovalRuntimeEnabled,
}));
vi.mock('../context', () => ({
  loadPendingPostNoticeContext: mocks.loadPendingPostNoticeContext,
}));
vi.mock('../dispatch', () => ({
  dispatchPendingPostNotice: mocks.dispatchPendingPostNotice,
}));
vi.mock('../../notification/eligibility', () => ({
  getEligibleChannels: mocks.getEligibleChannels,
}));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mocks.markOutboxCompleted,
  markOutboxFailed: mocks.markOutboxFailed,
  extractOutboxHandle: mocks.extractOutboxHandle,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import { handlePendingPostNotice } from '../PendingPostNoticeWorker';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const DEADLINE = new Date('2026-07-09T18:00:00Z');

const CTX_OK = {
  kind: 'ok',
  response: {
    id: 'resp-1',
    status: 'approved',
    approval_method: 'auto_policy',
    resp_business_id: 'biz-1',
    review_id: 'rev-1',
    approved_text: 'Thanks for the kind words!',
    auto_post_scheduled_at: DEADLINE,
    deadline_passed: false,
    reviewer_name: 'Jane',
    star_rating: 5,
    review_text: 'great visit',
  },
  business: {
    account_id: 'acct-1',
    name: 'Acme Co',
    display_label: null,
    owner_email_bounced: false,
    subscription_status: 'active',
    account_past_due_at: null,
    account_flags: {},
    archived_at: null,
  },
} as const;

const ELIGIBLE = {
  ok: true,
  enrollments: [{ channel: 'email', handle: 'o@x.com', location_id: null }],
} as const;

const DISPATCH_OK = { sent: 1, skipped: 0, terminalFailed: 0, retryableFailed: 0 };

function job(): Job<PendingPostNoticePayload> {
  return {
    id: 'job-1',
    data: { response_id: 'resp-1', business_id: 'biz-1', correlation_id: 'corr-1' },
  } as unknown as Job<PendingPostNoticePayload>;
}

const run = () => handlePendingPostNotice(mockSql as unknown as Sql, job());

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
  mockSql.begin.mockClear();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mocks.autoApprovalRuntimeEnabled.mockReturnValue(true);
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'ob-1', attempt: 1 });
  mocks.loadPendingPostNoticeContext.mockResolvedValue(CTX_OK);
  mocks.getEligibleChannels.mockResolvedValue(ELIGIBLE);
  mocks.dispatchPendingPostNotice.mockResolvedValue({ ...DISPATCH_OK });
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/';
  resetWorkerConfigForTests();
});

describe('handlePendingPostNotice', () => {
  it('KILL SWITCH (guard c): AUTO_APPROVAL_ENABLED off → outbox completed, no context load, no sends', async () => {
    mocks.autoApprovalRuntimeEnabled.mockReturnValue(false);

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.loadPendingPostNoticeContext).not.toHaveBeenCalled();
    expect(mocks.dispatchPendingPostNotice).not.toHaveBeenCalled();
  });

  it('context fail → outbox FAILED with the reason, no dispatch', async () => {
    mocks.loadPendingPostNoticeContext.mockResolvedValue({ kind: 'fail', reason: 'response_not_found' });

    await run();

    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(mockSql, 'ob-1', 'response_not_found', 1);
    expect(mocks.markOutboxCompleted).not.toHaveBeenCalled();
    expect(mocks.dispatchPendingPostNotice).not.toHaveBeenCalled();
  });

  it('context skip (vetoed/posted/stale) → outbox completed, no sends', async () => {
    mocks.loadPendingPostNoticeContext.mockResolvedValue({ kind: 'skip', reason: 'deadline_passed' });

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.getEligibleChannels).not.toHaveBeenCalled();
    expect(mocks.dispatchPendingPostNotice).not.toHaveBeenCalled();
  });

  it('eligibility not-ok (guard d, invariant #11) → outbox completed, no dispatch', async () => {
    mocks.getEligibleChannels.mockResolvedValue({ ok: false, reason: 'subscription_cancelled' });

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.dispatchPendingPostNotice).not.toHaveBeenCalled();
  });

  it('eligibility empty enrollments → outbox completed, no dispatch', async () => {
    mocks.getEligibleChannels.mockResolvedValue({ ok: true, enrollments: [] });

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.dispatchPendingPostNotice).not.toHaveBeenCalled();
  });

  it('missing NEXT_PUBLIC_APP_URL → outbox FAILED, no dispatch', async () => {
    // '' not delete: getWorkerConfig() self-loads .env.local, which would
    // repopulate a DELETED key; dotenv never overrides an existing (empty) one.
    process.env.NEXT_PUBLIC_APP_URL = '';
    resetWorkerConfigForTests();

    await run();

    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(mockSql, 'ob-1', 'NEXT_PUBLIC_APP_URL not configured', 1);
    expect(mocks.dispatchPendingPostNotice).not.toHaveBeenCalled();
  });

  it('happy path: dispatches with draft + deadline + trimmed appUrl, logs counts, completes outbox, and performs ZERO spine writes', async () => {
    mocks.dispatchPendingPostNotice.mockResolvedValue({ sent: 2, skipped: 1, terminalFailed: 1, retryableFailed: 0 });

    await run();

    expect(mocks.dispatchPendingPostNotice).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        responseId: 'resp-1',
        businessId: 'biz-1',
        accountId: 'acct-1',
        appUrl: 'https://app.example.com', // trailing slash trimmed
        business: { name: 'Acme Co', displayLabel: null, ownerEmailBounced: false },
        review: { reviewerName: 'Jane', starRating: 5, reviewText: 'great visit' },
        draft: { responsePreview: 'Thanks for the kind words!', scheduledPostAt: DEADLINE },
      }),
      ELIGIBLE.enrollments,
      mockLogger,
    );

    // Counts in an ids-only done line.
    expect(mockLogger.log).toHaveBeenCalledWith(
      'pending_post_notice done response=resp-1 sent=2 skipped=1 terminal_failed=1 retryable_failed=0',
    );
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);

    // WS4 adds no step keys (spec §2.6/§2.8): unlike the escalation-notice
    // precedent there is NO spine tx here — no sql.begin, no direct queries.
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('retryableFailed > 0 → throws so BullMQ retries, outbox NOT completed', async () => {
    mocks.dispatchPendingPostNotice.mockResolvedValue({ sent: 1, skipped: 0, terminalFailed: 0, retryableFailed: 2 });

    await expect(run()).rejects.toThrow(/2 retryable channel failure/);

    expect(mocks.markOutboxCompleted).not.toHaveBeenCalled();
  });

  it('systemic failure (sent=0, terminal failures) → warn-level distinct signal, outbox completed', async () => {
    mocks.dispatchPendingPostNotice.mockResolvedValue({ sent: 0, skipped: 0, terminalFailed: 2, retryableFailed: 0 });

    await run();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('systemic-failure'));
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('all-skipped (sent=0, skips only, zero failures) → still fires the systemic-failure signal', async () => {
    // An all-skipped run leaves the owner just as unnotified as an all-failed
    // one; the publisher's notice-delivery gate owns enforcement, this signal
    // is the observability breadcrumb.
    mocks.dispatchPendingPostNotice.mockResolvedValue({ sent: 0, skipped: 3, terminalFailed: 0, retryableFailed: 0 });

    await run();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('systemic-failure'));
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('nothing attempted (all counters zero) → no systemic-failure signal', async () => {
    mocks.dispatchPendingPostNotice.mockResolvedValue({ sent: 0, skipped: 0, terminalFailed: 0, retryableFailed: 0 });

    await run();

    const allLines = [
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
    ].map((c) => String(c[0]));
    expect(allLines.some((line) => line.includes('systemic-failure'))).toBe(false);
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('never logs review text, draft text, or reviewer name on the happy path (ids only)', async () => {
    await run();

    const allLogLines = [
      ...mockLogger.log.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
    ].map((c) => String(c[0]));
    expect(allLogLines.some((line) => line.includes('great visit'))).toBe(false);
    expect(allLogLines.some((line) => line.includes('Thanks for the kind words'))).toBe(false);
  });
});
