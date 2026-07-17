import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted state ────────────────────────────────────────────────────────────
const { sqlReturnQueue, mockSql, mockMarkOutboxCompleted, mockMarkOutboxFailed } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

import { loadPublishResponseContext } from '../load-context';

// ── Helpers ──────────────────────────────────────────────────────────────────

const logger = { error: vi.fn(), warn: vi.fn() };

const BASE_INPUT = {
  responseId: 'resp-1',
  businessId: 'biz-1',
  outboxId: 'outbox-1',
  outboxAttempt: undefined as number | undefined,
  logger,
};

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    review_id: 'rev-1',
    business_id: 'biz-1',
    approved_text: 'Thank you!',
    status: 'approved',
    approval_method: null,
    posting_error: null,
    ...overrides,
  };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    account_id: 'acct-1',
    name: 'Test Biz',
    subscription_status: 'active',
    subscription_tier: 'autopilot',
    account_updated_at: new Date(),
    archived_at: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loadPublishResponseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('returns posting_error from the response row when present', async () => {
    sqlReturnQueue.push([mockResponseRow({ posting_error: 'post_after_delete_failed_x' })]);
    sqlReturnQueue.push([mockBusinessRow()]);

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).not.toBe('terminal');
    if (result === 'terminal') return; // type narrowing only

    expect(result.response.posting_error).toBe('post_after_delete_failed_x');
  });

  it('returns posting_error as null when not set on the response row', async () => {
    sqlReturnQueue.push([mockResponseRow({ posting_error: null })]);
    sqlReturnQueue.push([mockBusinessRow()]);

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).not.toBe('terminal');
    if (result === 'terminal') return;

    expect(result.response.posting_error).toBeNull();
  });

  it('returns approval_method from the response row when present', async () => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow()]);

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).not.toBe('terminal');
    if (result === 'terminal') return;

    expect(result.response.approval_method).toBe('auto_policy');
  });

  it('loads the tier only as an early publisher hint', async () => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_tier: 'copilot' })]);

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).not.toBe('terminal');
    if (result === 'terminal') return;
    expect(result.business.subscription_tier).toBe('copilot');
    const businessSelect = mockSql.mock.calls[1]![0].join('?');
    expect(businessSelect).toContain('a.subscription_tier');
  });

  it('returns terminal and marks outbox failed when response not found', async () => {
    sqlReturnQueue.push([]); // empty → not found

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).toBe('terminal');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      'response_not_found: resp-1',
      undefined,
    );
  });

  it('returns terminal and marks outbox failed on business_id mismatch', async () => {
    sqlReturnQueue.push([mockResponseRow({ business_id: 'biz-other' })]);

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).toBe('terminal');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockSql, 'outbox-1', 'business_id_mismatch', undefined);
  });

  it('returns context when business is archived so the worker can handle terminal behavior', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-05-01T00:00:00Z') })]);

    const result = await loadPublishResponseContext(mockSql, BASE_INPUT);

    expect(result).not.toBe('terminal');
    if (result === 'terminal') return;

    expect(result.business.archived_at).toEqual(new Date('2026-05-01T00:00:00Z'));
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });
});
