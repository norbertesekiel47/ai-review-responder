import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { AutonomySuspendedNoticePayload } from '@/lib/shared/worker-types';

const { mockSql, mockLogger } = await vi.hoisted(async () => {
  const { createMockSql, mockWorkerLogger } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mockLogger: mockWorkerLogger() };
});
const mocks = vi.hoisted(() => ({
  load: vi.fn(), dispatch: vi.fn(), eligible: vi.fn(), complete: vi.fn(), fail: vi.fn(),
  handle: vi.fn(() => ({ outboxId: 'ob-1', attempt: 1 })),
}));
vi.mock('../context', () => ({ loadAutonomySuspendedNoticeContext: mocks.load }));
vi.mock('../dispatch', () => ({ dispatchAutonomySuspendedNotice: mocks.dispatch }));
vi.mock('../../notification/eligibility', () => ({ getEligibleChannels: mocks.eligible }));
vi.mock('@/lib/shared/outbox', () => ({ markOutboxCompleted: mocks.complete, markOutboxFailed: mocks.fail, extractOutboxHandle: mocks.handle }));
vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => mockLogger }));

import { handleAutonomySuspendedNotice } from '../AutonomySuspendedNoticeWorker';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

const account = { account_id: 'acct-1', display_name: 'Acme Group', subscription_status: 'active', account_past_due_at: null, account_flags: {}, suspended_at: new Date() };
const business = { business_id: 'biz-1', name: 'Main', display_label: null, owner_email_bounced: false };
const ctx = { kind: 'ok', account, business, audit: { trigger: 'judge_flag', suspension_event_id: 'event-1', reason: 'reason' } };
const job = { id: 'job-1', data: { account_id: 'acct-1', suspension_event_id: 'event-1', trigger: 'judge_flag' } } as unknown as Job<AutonomySuspendedNoticePayload>;
const run = () => handleAutonomySuspendedNotice(mockSql as unknown as Sql, job);

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset(); mockLogger.warn.mockReset(); mockLogger.error.mockReset();
  mocks.handle.mockReturnValue({ outboxId: 'ob-1', attempt: 1 });
  mocks.load.mockResolvedValue(ctx);
  mocks.eligible.mockResolvedValue({ ok: true, enrollments: [{ channel: 'email', handle: 'o@x.com', location_id: null }] });
  mocks.dispatch.mockResolvedValue({ sent: 1, skipped: 0, terminalFailed: 0, retryableFailed: 0 });
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/'; resetWorkerConfigForTests();
});

describe('handleAutonomySuspendedNotice', () => {
  it('has no feature-flag kill switch and dispatches even when AUTO_APPROVAL_ENABLED is off', async () => {
    process.env.AUTO_APPROVAL_ENABLED = 'false';
    await run();
    expect(mocks.load).toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      settingsUrl: 'https://app.example.com/settings/auto-approval',
      supportUrl: 'mailto:support@repworth.net',
    }), expect.any(Array), mockLogger);
    expect(mocks.complete).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('sends the account-scoped notice to org-default enrollments, not per-location overrides', async () => {
    mocks.eligible.mockResolvedValue({
      ok: true,
      enrollments: [
        { channel: 'email', handle: 'override@x.com', location_id: 'biz-1' },
        { channel: 'telegram', handle: 'tg-org', location_id: null },
      ],
    });
    await run();
    expect(mocks.eligible).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      accountId: 'acct-1',
      locationId: 'biz-1',
    }), mockLogger);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      mockSql,
      expect.any(Object),
      [{ channel: 'telegram', handle: 'tg-org', location_id: null }],
      mockLogger,
    );
    expect(mocks.complete).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('falls back to the primary location channels only when no org-default enrollment exists', async () => {
    const overrideOnly = [
      { channel: 'email', handle: 'override@x.com', location_id: 'biz-1' },
      { channel: 'whatsapp', handle: '+15550001111', location_id: 'biz-1' },
    ];
    mocks.eligible.mockResolvedValue({ ok: true, enrollments: overrideOnly });
    await run();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      mockSql,
      expect.any(Object),
      overrideOnly,
      mockLogger,
    );
    expect(mocks.complete).toHaveBeenCalledWith(mockSql, 'ob-1', 1);
  });

  it('marks a missing suspension audit as failed', async () => {
    mocks.load.mockResolvedValue({ kind: 'fail', reason: 'suspension_audit_not_found' });
    await run();
    expect(mocks.fail).toHaveBeenCalledWith(mockSql, 'ob-1', 'suspension_audit_not_found', 1);
  });

  it('completes without dispatch when the subscription guard is ineligible', async () => {
    mocks.eligible.mockResolvedValue({ ok: false, reason: 'subscription_cancelled' });
    await run();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalled();
  });

  it('fails the outbox when the settings URL cannot be constructed', async () => {
    process.env.NEXT_PUBLIC_APP_URL = '';
    resetWorkerConfigForTests();
    await run();
    expect(mocks.fail).toHaveBeenCalledWith(mockSql, 'ob-1', 'NEXT_PUBLIC_APP_URL not configured', 1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('throws when any channel failure is retryable', async () => {
    mocks.dispatch.mockResolvedValue({ sent: 0, skipped: 0, terminalFailed: 0, retryableFailed: 1 });
    await expect(run()).rejects.toThrow(/retryable channel failure/);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('warns on all-skipped and still completes the outbox', async () => {
    mocks.dispatch.mockResolvedValue({ sent: 0, skipped: 2, terminalFailed: 0, retryableFailed: 0 });
    await run();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('systemic-failure'));
    expect(mocks.complete).toHaveBeenCalled();
  });
});
