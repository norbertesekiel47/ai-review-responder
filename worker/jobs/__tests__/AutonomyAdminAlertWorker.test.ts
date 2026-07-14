import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { AutonomyAdminAlertPayload } from '@/lib/shared/worker-types';

const { mockSql, mockLogger } = await vi.hoisted(async () => {
  const { createMockSql, mockWorkerLogger } = await import('../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mockLogger: mockWorkerLogger() };
});

const mocks = vi.hoisted(() => ({
  sendInternalEmail: vi.fn(),
  markOutboxCompleted: vi.fn(),
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'outbox-1', attempt: 3 })),
  getWorkerConfig: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/notifications/email', () => ({ sendInternalEmail: mocks.sendInternalEmail }));
vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: mocks.markOutboxCompleted,
  extractOutboxHandle: mocks.extractOutboxHandle,
}));
vi.mock('@/lib/config/worker', () => ({ getWorkerConfig: mocks.getWorkerConfig }));
vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => mockLogger }));
vi.mock('@sentry/node', () => ({ captureMessage: mocks.captureMessage }));

import { handleAutonomyAdminAlert } from '../AutonomyAdminAlertWorker';

const makeJob = (
  overrides: Partial<AutonomyAdminAlertPayload> = {},
): Job<AutonomyAdminAlertPayload> => ({
  id: 'bull-job-1',
  data: {
    account_id: 'account-1',
    suspension_event_id: 'event-1',
    trigger: 'governor_edit_rate',
    evidence: { rate: 0.6, numer: 3, denom: 5, windowDays: 7 },
    outbox_id: 'outbox-1',
    outbox_attempt: 3,
    ...overrides,
  },
}) as unknown as Job<AutonomyAdminAlertPayload>;

const run = (job = makeJob()) => handleAutonomyAdminAlert(mockSql as unknown as Sql, job);

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'outbox-1', attempt: 3 });
  mocks.getWorkerConfig.mockReturnValue({ ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' });
  mocks.sendInternalEmail.mockResolvedValue({ messageId: 'email-1' });
});

describe('handleAutonomyAdminAlert', () => {
  it('emails complete rate evidence, emits the exact Sentry warning, and completes the owned attempt', async () => {
    await run();

    expect(mocks.sendInternalEmail).toHaveBeenCalledWith({
      to: 'admin@example.com',
      subject: 'Autonomy suspended — governor_edit_rate',
      bodyHtml: expect.stringContaining('account-1'),
      category: 'internal',
      idempotencyKey: 'autonomy_admin_alert:event-1',
    });
    const body = String(mocks.sendInternalEmail.mock.calls[0]![0].bodyHtml);
    expect(body).toContain('event-1');
    expect(body).toContain('governor_edit_rate');
    expect(body).toContain('0.6');
    expect(body).toContain('3');
    expect(body).toContain('5');
    expect(body).toContain('7');
    expect(mocks.captureMessage).toHaveBeenCalledWith('autonomy suspended', {
      level: 'warning',
      tags: { subsystem: 'autonomy_watchdog', trigger: 'governor_edit_rate' },
    });
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
  });

  it('renders verdict evidence and ignores injected raw review/response fields', async () => {
    const sensitiveReview = 'SENSITIVE_REVIEW_TEXT';
    const sensitiveResponse = 'SENSITIVE_RESPONSE_TEXT';
    const job = makeJob({
      trigger: 'judge_flag',
      evidence: { verdict_id: 'verdict-1' },
    });
    Object.assign(job.data, { review_text: sensitiveReview, response_text: sensitiveResponse });

    await run(job);

    const body = String(mocks.sendInternalEmail.mock.calls[0]![0].bodyHtml);
    expect(body).toContain('verdict-1');
    expect(body).not.toContain(sensitiveReview);
    expect(body).not.toContain(sensitiveResponse);
  });

  it('logs an error and completes without retry when ADMIN_NOTIFICATION_EMAIL is unset', async () => {
    mocks.getWorkerConfig.mockReturnValue({ ADMIN_NOTIFICATION_EMAIL: undefined });

    await run();

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('ADMIN_NOTIFICATION_EMAIL'));
    expect(mocks.sendInternalEmail).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith('autonomy suspended', {
      level: 'warning',
      tags: { subsystem: 'autonomy_watchdog', trigger: 'governor_edit_rate' },
    });
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
  });

  it('attempts Sentry after email failure, then rethrows the original email error without completing', async () => {
    const sendError = new Error('Resend unavailable');
    mocks.sendInternalEmail.mockRejectedValue(sendError);

    await expect(run()).rejects.toBe(sendError);

    expect(mocks.captureMessage).toHaveBeenCalledWith('autonomy suspended', {
      level: 'warning',
      tags: { subsystem: 'autonomy_watchdog', trigger: 'governor_edit_rate' },
    });
    expect(mocks.markOutboxCompleted).not.toHaveBeenCalled();
  });

  it('preserves the original email error when the independent Sentry attempt also fails', async () => {
    const sendError = new Error('Resend unavailable');
    mocks.sendInternalEmail.mockRejectedValue(sendError);
    mocks.captureMessage.mockImplementation(() => { throw new Error('Sentry unavailable'); });

    await expect(run()).rejects.toBe(sendError);

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('sentry-failed'));
    expect(mocks.markOutboxCompleted).not.toHaveBeenCalled();
  });

  it('swallows Sentry failure after successful email and still completes', async () => {
    mocks.captureMessage.mockImplementation(() => { throw new Error('Sentry unavailable'); });

    await expect(run()).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('sentry-failed'));
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
  });

  it('propagates awaited outbox completion failure after accepted email and reuses a stable retry key', async () => {
    const completionError = new Error('outbox completion unavailable');
    mocks.markOutboxCompleted.mockRejectedValue(completionError);

    await expect(run()).rejects.toBe(completionError);

    expect(mocks.sendInternalEmail).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'autonomy_admin_alert:event-1',
    }));
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
  });

  it('is statically registered as an injected-sql worker and has no raw process.env read', () => {
    const workerSource = readFileSync('worker/jobs/AutonomyAdminAlertWorker.ts', 'utf8');
    const indexSource = readFileSync('worker/index.ts', 'utf8');

    expect(workerSource).not.toContain('process.env');
    expect(indexSource).toContain("from './jobs/AutonomyAdminAlertWorker'");
    expect(indexSource).toMatch(/handleAutonomyAdminAlert\(sql, job\)/);
    expect(indexSource).toContain('[QUEUE_NAMES.AUTONOMY_ADMIN_ALERT]');
  });
});
