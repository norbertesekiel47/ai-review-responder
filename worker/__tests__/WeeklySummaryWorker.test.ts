import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-ws-1' }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildWeeklySummaryEmailHtml: vi.fn(() => '<html>summary</html>'),
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleWeeklySummary } from '../jobs/WeeklySummaryWorker';

function makeJob(overrides: Partial<WeeklySummaryPayload> = {}): Job<WeeklySummaryPayload> {
  return {
    data: {
      business_id: 'biz-1',
      week_start_date: '2026-04-06',
      ...overrides,
    },
    id: 'outbox-ws-1',
  } as Job<WeeklySummaryPayload>;
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    name: 'Test Biz',
    owner_email: 'owner@test.com',
    subscription_status: 'active',
    updated_at: new Date(),
    ...overrides,
  };
}

describe('WeeklySummaryWorker – handleWeeklySummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
  });

  it('generates and sends weekly summary for active business', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);                          // business
    sqlReturnQueue.push([{ count: '5' }]);                             // total reviews
    sqlReturnQueue.push([{ count: '4' }]);                             // total responded
    sqlReturnQueue.push([{ reviewer_name: 'Jane', star_rating: 1, review_text: 'Bad' }]); // notable
    sqlReturnQueue.push([{ sent_at: null }]);                          // upsert RETURNING
    sqlReturnQueue.push([]);                                           // UPDATE sent_at

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.to).toBe('owner@test.com');
    expect(emailArgs.subject).toContain('Test Biz');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('skips cancelled subscription', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('skips pending_payment subscription', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('skips duplicate week (sent_at already set)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);                          // business
    sqlReturnQueue.push([{ count: '3' }]);                             // total reviews
    sqlReturnQueue.push([{ count: '3' }]);                             // total responded
    sqlReturnQueue.push([]);                                           // no notable
    // When the row exists with sent_at IS NOT NULL, the ON CONFLICT WHERE clause
    // prevents the update and Postgres returns ZERO rows (not the existing row).
    sqlReturnQueue.push([]);                                           // upsert RETURNING → empty (already sent)

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1');
  });

  it('fails outbox when business not found', async () => {
    sqlReturnQueue.push([]);

    await handleWeeklySummary(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ws-1', 'business_not_found');
  });
});
