import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { EscalationNoticePayload } from '../../../../src/lib/shared/worker-types';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult, mockLogger } = await vi.hoisted(async () => {
  const { createMockSql, mkTaggedResult, mockWorkerLogger } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mkTaggedResult, mockLogger: mockWorkerLogger() };
});

const mocks = vi.hoisted(() => ({
  escalationEnabled: vi.fn(() => true),
  loadEscalationNoticeContext: vi.fn(),
  dispatchEscalationNotice: vi.fn(),
  getEligibleChannels: vi.fn(),
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'ob-1', attempt: 1 })),
  findActiveReviewRun: vi.fn(),
  recordStep: vi.fn(),
}));

vi.mock('../../../../src/lib/escalations/flags', () => ({
  escalationEnabled: mocks.escalationEnabled,
}));
vi.mock('../context', () => ({
  loadEscalationNoticeContext: mocks.loadEscalationNoticeContext,
}));
vi.mock('../dispatch', () => ({
  dispatchEscalationNotice: mocks.dispatchEscalationNotice,
}));
vi.mock('../../notification/eligibility', () => ({
  getEligibleChannels: mocks.getEligibleChannels,
}));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mocks.markOutboxCompleted,
  markOutboxFailed: mocks.markOutboxFailed,
  extractOutboxHandle: mocks.extractOutboxHandle,
}));
vi.mock('../../../../src/lib/agents/run-spine', () => ({
  findActiveReviewRun: mocks.findActiveReviewRun,
  recordStep: mocks.recordStep,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import { handleEscalationNotice } from '../EscalationNoticeWorker';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const CTX_OK = {
  kind: 'ok',
  escalation: {
    id: 'esc-1',
    status: 'escalated',
    esc_business_id: 'biz-1',
    account_id: 'acct-1',
    review_id: 'rev-1',
    triage_severity: 'high',
    triage_source: 'llm_triage_v1',
    triage_suggested_action: 'escalate',
    triage_issues: ['safety_or_health'],
    reviewer_name: 'Jane',
    star_rating: 1,
    review_text: 'terrible visit',
  },
  business: {
    account_id: 'acct-1',
    name: 'Acme Co',
    display_label: null,
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

function job(): Job<EscalationNoticePayload> {
  return {
    id: 'job-1',
    data: { escalation_id: 'esc-1', business_id: 'biz-1', correlation_id: 'corr-1' },
  } as unknown as Job<EscalationNoticePayload>;
}

const run = () => handleEscalationNotice(mockSql as unknown as Sql, job());

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
  mockSql.begin.mockClear();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mocks.escalationEnabled.mockReturnValue(true);
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'ob-1', attempt: 1 });
  mocks.loadEscalationNoticeContext.mockResolvedValue(CTX_OK);
  mocks.getEligibleChannels.mockResolvedValue(ELIGIBLE);
  mocks.dispatchEscalationNotice.mockResolvedValue({ ...DISPATCH_OK });
  mocks.findActiveReviewRun.mockResolvedValue({ id: 'run-1', account_id: 'acct-1' });
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/';
  resetWorkerConfigForTests();
});

describe('handleEscalationNotice', () => {
  it('KILL SWITCH: flag off → outbox completed, no context load, no sends', async () => {
    mocks.escalationEnabled.mockReturnValue(false);

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.loadEscalationNoticeContext).not.toHaveBeenCalled();
    expect(mocks.dispatchEscalationNotice).not.toHaveBeenCalled();
    expect(mocks.recordStep).not.toHaveBeenCalled();
  });

  it('context fail → outbox FAILED with the reason, no dispatch', async () => {
    mocks.loadEscalationNoticeContext.mockResolvedValue({ kind: 'fail', reason: 'escalation_not_found' });

    await run();

    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(mockSql, 'ob-1', 'escalation_not_found', 1);
    expect(mocks.markOutboxCompleted).not.toHaveBeenCalled();
    expect(mocks.dispatchEscalationNotice).not.toHaveBeenCalled();
  });

  it('context skip already_resolved → outbox completed, no sends', async () => {
    mocks.loadEscalationNoticeContext.mockResolvedValue({ kind: 'skip', reason: 'already_resolved' });

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.getEligibleChannels).not.toHaveBeenCalled();
    expect(mocks.dispatchEscalationNotice).not.toHaveBeenCalled();
  });

  it('eligibility not-ok → outbox completed, no dispatch', async () => {
    mocks.getEligibleChannels.mockResolvedValue({ ok: false, reason: 'subscription_cancelled' });

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.dispatchEscalationNotice).not.toHaveBeenCalled();
  });

  it('eligibility empty enrollments → outbox completed, no dispatch', async () => {
    mocks.getEligibleChannels.mockResolvedValue({ ok: true, enrollments: [] });

    await run();

    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.dispatchEscalationNotice).not.toHaveBeenCalled();
  });

  it('missing NEXT_PUBLIC_APP_URL → outbox FAILED, no dispatch', async () => {
    // '' not delete: getWorkerConfig() self-loads .env.local, which would
    // repopulate a DELETED key; dotenv never overrides an existing (empty) one.
    process.env.NEXT_PUBLIC_APP_URL = '';
    resetWorkerConfigForTests();

    await run();

    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(mockSql, 'ob-1', 'NEXT_PUBLIC_APP_URL not configured', 1);
    expect(mocks.dispatchEscalationNotice).not.toHaveBeenCalled();
  });

  it('happy path: dispatches with the triage snapshot + dashboard URL, records escalation_sent with counts, review FOR UPDATE is the tx FIRST statement', async () => {
    mocks.dispatchEscalationNotice.mockResolvedValue({ sent: 2, skipped: 1, terminalFailed: 1, retryableFailed: 0 });
    sqlReturnQueue.push(mkTaggedResult([{ id: 'rev-1' }])); // reviews FOR UPDATE lock

    await run();

    expect(mocks.dispatchEscalationNotice).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        escalationId: 'esc-1',
        businessId: 'biz-1',
        accountId: 'acct-1',
        dashboardUrl: 'https://app.example.com/dashboard/reviews', // trailing slash trimmed
        triage: { severity: 'high', issues: ['safety_or_health'], isFallback: false },
      }),
      ELIGIBLE.enrollments,
      mockLogger,
    );

    // Lock-ordering rule: review FOR UPDATE is the tx's FIRST statement.
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(sqlCalls[0]!.text).toContain('FROM reviews');
    expect(sqlCalls[0]!.text).toContain('FOR UPDATE');

    expect(mocks.findActiveReviewRun).toHaveBeenCalledWith(mockSql, 'rev-1');
    expect(mocks.recordStep).toHaveBeenCalledWith(mockSql, {
      runId: 'run-1',
      stepKey: 'escalation_sent',
      detail: { escalation_id: 'esc-1', sent: 2, skipped: 1, terminal_failed: 1 },
    });
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('marks isFallback=true when triage_source is the fallback classifier', async () => {
    mocks.loadEscalationNoticeContext.mockResolvedValue({
      ...CTX_OK,
      escalation: { ...CTX_OK.escalation, triage_source: 'fallback_high_v1', triage_issues: null },
    });
    sqlReturnQueue.push(mkTaggedResult([{ id: 'rev-1' }]));

    await run();

    expect(mocks.dispatchEscalationNotice).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ triage: { severity: 'high', issues: [], isFallback: true } }),
      ELIGIBLE.enrollments,
      mockLogger,
    );
  });

  it('retryableFailed > 0 → throws BEFORE any step write, outbox NOT completed', async () => {
    mocks.dispatchEscalationNotice.mockResolvedValue({ sent: 1, skipped: 0, terminalFailed: 0, retryableFailed: 2 });

    await expect(run()).rejects.toThrow(/2 retryable channel failure/);

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mocks.recordStep).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).not.toHaveBeenCalled();
  });

  it('step tx failure is BEST-EFFORT: logs step-record-failed, outbox still completed, no re-throw', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'rev-1' }])); // reviews FOR UPDATE lock
    mocks.findActiveReviewRun.mockRejectedValue(new Error('transient db blip'));

    await expect(run()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('escalation_notice step-record-failed escalation=esc-1'),
    );
    expect(mocks.recordStep).not.toHaveBeenCalled();
    // The notices are already sent — the job must still complete the outbox.
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('no active run → no step recorded, outbox still completed', async () => {
    mocks.findActiveReviewRun.mockResolvedValue(null);
    sqlReturnQueue.push(mkTaggedResult([{ id: 'rev-1' }]));

    await run();

    expect(mocks.recordStep).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('review row gone (lock returns no rows) → no spine reads/writes, outbox still completed', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));

    await run();

    expect(mocks.findActiveReviewRun).not.toHaveBeenCalled();
    expect(mocks.recordStep).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('nothing sent (sent=0, all skipped) → no step tx, outbox completed', async () => {
    mocks.dispatchEscalationNotice.mockResolvedValue({ sent: 0, skipped: 1, terminalFailed: 0, retryableFailed: 0 });

    await run();

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mocks.recordStep).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('systemic failure (sent=0, terminal failures) → error-level log, outbox completed', async () => {
    mocks.dispatchEscalationNotice.mockResolvedValue({ sent: 0, skipped: 0, terminalFailed: 2, retryableFailed: 0 });

    await run();

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('systemic-failure'));
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });
});
