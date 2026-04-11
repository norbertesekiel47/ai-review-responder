import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { NotifyAdminExceptionPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
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
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-exc-1' }),
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
}));

vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));

// Import after mocks are wired
import { handleAdminException } from '../jobs/AdminExceptionWorker';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(): Job<NotifyAdminExceptionPayload> {
  return {
    data: { review_exception_id: 'exc-1', business_id: 'biz-1' },
    id: 'outbox-exc-1',
  } as Job<NotifyAdminExceptionPayload>;
}

function mockExceptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exc-1',
    type: 'review_edited_after_response',
    status: 'open',
    payload: { response_status: 'posted' },
    reviewer_name: 'Jane',
    star_rating: 4,
    review_text: 'Updated review text',
    business_name: 'Test Biz',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('AdminExceptionWorker – handleAdminException', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
  });

  // 1. Success: open exception, admin email set
  it('sends alert email and completes outbox for open exception', async () => {
    sqlReturnQueue.push([mockExceptionRow()]);  // 1: SELECT exception+review+business

    await handleAdminException(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(emailArgs.to).toBe('admin@test.com');
    expect(emailArgs.subject).toContain('Review exception');
    expect(emailArgs.subject).toContain('Test Biz');

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-exc-1');
  });

  // 2. Already resolved — idempotent skip
  it('completes outbox without email when exception already resolved', async () => {
    sqlReturnQueue.push([mockExceptionRow({ status: 'resolved' })]);

    await handleAdminException(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-exc-1');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  // 3. Email failure — throws for BullMQ retry
  it('throws when sendInternalEmail fails so BullMQ retries', async () => {
    sqlReturnQueue.push([mockExceptionRow()]);

    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend API timeout'));

    await expect(handleAdminException(makeJob())).rejects.toThrow('Resend API timeout');

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });
});
