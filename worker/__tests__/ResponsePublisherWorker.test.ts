import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PublishResponsePayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-pub-1' }),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/notifications/email')>();
  return {
    ...actual,
    sendInternalEmail: mockSendInternalEmail,
  };
});
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handlePublishResponse } from '../jobs/ResponsePublisherWorker';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeJob(): Job<PublishResponsePayload> {
  return {
    data: { response_id: 'resp-1', business_id: 'biz-1' },
    id: 'outbox-pub-1',
  } as Job<PublishResponsePayload>;
}

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1', review_id: 'rev-1', business_id: 'biz-1',
    approved_text: 'Thank you for your kind review!', status: 'approved',
    ...overrides,
  };
}

function mockReviewRow() {
  return { id: 'rev-1', reviewer_name: 'Jane', star_rating: 5 };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1', name: 'Test Biz', subscription_status: 'active',
    updated_at: new Date(), google_place_id: 'ChIJ_test123',
    ...overrides,
  };
}

// SQL call order for success path:
// 1. SELECT response
// 2. SELECT review
// 3. SELECT business
// 4. UPDATE responses SET status = 'awaiting_manual_post' (returns count: 1)
// 5. SELECT users (business-scoped onboarded_by)
// 6. (if no business admin) SELECT users (global admin)
// 7. sendInternalEmail

function pushSuccessSequence(responseOverrides: Record<string, unknown> = {}) {
  sqlReturnQueue.push([mockResponseRow(responseOverrides)]);  // 1: response
  sqlReturnQueue.push([mockReviewRow()]);                     // 2: review
  sqlReturnQueue.push([mockBusinessRow()]);                   // 3: business
  sqlReturnQueue.push(Object.assign([], { count: 1 }));      // 4: UPDATE status
  sqlReturnQueue.push([]);                                    // 5: business-scoped admin (none)
  sqlReturnQueue.push([{ email: 'admin@test.com' }]);         // 6: global admin
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ResponsePublisherWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'fallback-admin@test.com';
  });

  it('sets awaiting_manual_post, sends email, completes outbox', async () => {
    pushSuccessSequence();

    await handlePublishResponse(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1');
  });

  it('completes outbox without email when subscription is cancelled', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handlePublishResponse(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1');
  });

  it('completes outbox without action when response already posted', async () => {
    sqlReturnQueue.push([mockResponseRow({ status: 'posted' })]);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);

    await handlePublishResponse(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1');
  });

  it('throws when sendInternalEmail fails so BullMQ retries', async () => {
    pushSuccessSequence();
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend timeout'));

    await expect(handlePublishResponse(makeJob())).rejects.toThrow('Resend timeout');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('retries email send when response is already awaiting_manual_post', async () => {
    // Simulates a retry: previous attempt set awaiting_manual_post but
    // crashed before sending the email. The worker should NOT skip it —
    // it should proceed to the email send path.
    sqlReturnQueue.push([mockResponseRow({ status: 'awaiting_manual_post' })]);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    // No UPDATE (status is already awaiting_manual_post, skips the UPDATE)
    sqlReturnQueue.push([]);                              // business-scoped admin
    sqlReturnQueue.push([{ email: 'admin@test.com' }]);   // global admin

    await handlePublishResponse(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1');
  });
});
