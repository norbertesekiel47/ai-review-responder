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
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));

vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));

// Import after mocks are wired
import { handleAdminException, renderExceptionBody } from '../jobs/AdminExceptionWorker';

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
    review_id: 'rev-1',
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

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-exc-1', undefined);
  });

  // 2. Already resolved — idempotent skip
  it('completes outbox without email when exception already resolved', async () => {
    sqlReturnQueue.push([mockExceptionRow({ status: 'resolved' })]);

    await handleAdminException(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-exc-1', undefined);
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

// ── renderExceptionBody unit tests ─────────────────────────────────────

const baseException = {
  id: 'exc-1',
  type: 'review_edited_after_post',
  status: 'open',
  payload: {} as Record<string, unknown>,
  review_id: 'rev-1',
  reviewer_name: 'Jane Doe',
  star_rating: 5,
  review_text: 'Great place',
  business_name: 'Test Biz',
};

describe('renderExceptionBody', () => {
  it('review_edited_after_post: renders the review-edit copy', () => {
    const out = renderExceptionBody(baseException, { response_status: 'pending_approval' });
    expect(out).toContain('reviewer edited their review');
    expect(out).toContain('pending_approval');
  });

  it('zernio_review_not_found with review_id=null: renders "no local review record" instead of reviewer block', () => {
    const out = renderExceptionBody(
      { ...baseException, type: 'zernio_review_not_found', review_id: null, reviewer_name: null, review_text: null, star_rating: null },
      { provider_review_id: 'zr-1', zernio_account_id: 'A', zernio_location_id: 'L', retries_exhausted_at: '2026-04-29T00:00:00Z' },
    );
    expect(out).toContain('No local review record');
    expect(out).toContain('zr-1');
    expect(out).toContain('Zernio account / location');
    expect(out).not.toContain('reviewer edited');
  });

  it('zernio_permanent_4xx: includes endpoint_kind + http_status', () => {
    const out = renderExceptionBody(
      { ...baseException, type: 'zernio_permanent_4xx' },
      { endpoint_kind: 'publish_reply', http_status: 422 },
    );
    expect(out).toContain('publish_reply');
    expect(out).toContain('422');
    expect(out).not.toContain('reviewer edited');
  });

  it('zernio_reply_verification_indeterminate: includes reason + ids + underlying_error', () => {
    const out = renderExceptionBody(
      { ...baseException, type: 'zernio_reply_verification_indeterminate' },
      {
        reason: 'review_not_found_after_pagination',
        zernio_account_id: 'A',
        zernio_location_id: 'L',
        zernio_review_id: 'zr',
        underlying_error: 'connection refused',
      },
    );
    expect(out).toContain('review_not_found_after_pagination');
    expect(out).toContain('zr');
    expect(out).toContain('connection refused');
  });

  it('zernio_unparseable_review_name: review_name_truncated rendered in <pre>', () => {
    const out = renderExceptionBody(
      { ...baseException, type: 'zernio_unparseable_review_name' },
      { review_name_truncated: 'malformed/path/here', zernio_account_id: 'A', zernio_location_id: 'L' },
    );
    expect(out).toContain('<pre');
    expect(out).toContain('malformed/path/here');
  });

  it('anonymous reviewer (review_id present, reviewer_name=null) renders "Unknown reviewer"', () => {
    const out = renderExceptionBody(
      { ...baseException, reviewer_name: null },
      { response_status: 'pending_approval' },
    );
    expect(out).toContain('Unknown reviewer');
  });

  it('unknown type: falls through to generic fallback listing payload primitives', () => {
    const out = renderExceptionBody(
      { ...baseException, type: 'some_new_type_we_havent_seen' },
      { foo: 'bar', count: 42, ok: true, ignore_object: { nested: 'value' } },
    );
    expect(out).toContain('does not have a specific email template');
    expect(out).toContain('foo');
    expect(out).toContain('bar');
    expect(out).toContain('count');
    expect(out).toContain('42');
    // The nested object should be filtered out by the safeFields filter
    expect(out).not.toContain('nested');
    expect(out).not.toContain('reviewer edited');
  });
});
