// Worker half of the veto-notice family (#631 Task 5,
// docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md). Mirrors
// pending-post-notice/__tests__/PendingPostNoticeWorker.test.ts's mocking
// style. The worker gates on BATCH STATE only (auto_policy, not
// halted/closed) — no flag reads (decision 11).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { SolicitationVetoNoticePayload } from '../../../../src/lib/shared/worker-types';

const { mockSql, resetMockSql, mockLogger } = await vi.hoisted(async () => {
  const { createMockSql, mockWorkerLogger } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mockLogger: mockWorkerLogger() };
});

const mocks = vi.hoisted(() => ({
  loadSolicitationVetoNoticeContext: vi.fn(),
  dispatchSolicitationVetoNotice: vi.fn(),
  resolveEligibleChannels: vi.fn(),
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'ob-1', attempt: 1 })),
}));

vi.mock('../context', () => ({
  loadSolicitationVetoNoticeContext: mocks.loadSolicitationVetoNoticeContext,
}));
vi.mock('../dispatch', () => ({
  dispatchSolicitationVetoNotice: mocks.dispatchSolicitationVetoNotice,
}));
vi.mock('../../notification/eligibility', () => ({
  resolveEligibleChannels: mocks.resolveEligibleChannels,
}));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mocks.markOutboxCompleted,
  markOutboxFailed: mocks.markOutboxFailed,
  extractOutboxHandle: mocks.extractOutboxHandle,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import { handleSolicitationVetoNotice } from '../SolicitationVetoNoticeWorker';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const CTX_OK = {
  kind: 'ok',
  batch: {
    id: 'batch-1',
    account_id: 'acct-1',
    batch_business_id: 'biz-1',
    approval_method: 'auto_policy',
    halted_at: null,
    send_closed_at: null,
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
  requestCount: 5,
} as const;

const ELIGIBLE = {
  ok: true,
  enrollments: [{ channel: 'email', handle: 'o@x.com', location_id: null }],
} as const;

const DISPATCH_OK = { sent: 1, skipped: 0, terminalFailed: 0, retryableFailed: 0 };

function job(): Job<SolicitationVetoNoticePayload> {
  return {
    id: 'job-1',
    data: { batch_id: 'batch-1', business_id: 'biz-1', correlation_id: 'corr-1' },
  } as unknown as Job<SolicitationVetoNoticePayload>;
}

const run = () => handleSolicitationVetoNotice(mockSql as unknown as Sql, job());

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
  mockSql.begin.mockClear();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'ob-1', attempt: 1 });
  mocks.loadSolicitationVetoNoticeContext.mockResolvedValue(CTX_OK);
  mocks.resolveEligibleChannels.mockResolvedValue(ELIGIBLE);
  mocks.dispatchSolicitationVetoNotice.mockResolvedValue({ ...DISPATCH_OK });
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/';
  resetWorkerConfigForTests();
});

describe('SolicitationVetoNoticeWorker', () => {
  it('the Worker logs systemic failure when no veto-notice channels are enrolled', async () => {
    mocks.resolveEligibleChannels.mockResolvedValue({ ok: true, enrollments: [] });

    await run();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('systemic-failure'));
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
    expect(mocks.dispatchSolicitationVetoNotice).not.toHaveBeenCalled();
  });

  it('a queued veto notice is quietly skipped after downgrade, halt, or send closure', async () => {
    // All three batch-state skip reasons share the SAME code path — assert
    // each in turn to pin the whole gate, not just one arm of it.
    const skipReasons = ['not_auto_policy', 'halted', 'send_closed'] as const;
    for (const reason of skipReasons) {
      mocks.loadSolicitationVetoNoticeContext.mockResolvedValue({ kind: 'skip', reason });
      mocks.markOutboxCompleted.mockClear();
      mockLogger.log.mockClear();
      mockLogger.warn.mockClear();

      await run();

      expect(mockLogger.log).toHaveBeenCalledWith(`solicitation_veto_notice skip batch=batch-1 reason=${reason}`);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
      expect(mocks.resolveEligibleChannels).not.toHaveBeenCalled();
      expect(mocks.dispatchSolicitationVetoNotice).not.toHaveBeenCalled();
    }
  });
});
