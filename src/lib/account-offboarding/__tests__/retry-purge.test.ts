import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn();
  return { mockSql: sqlFn };
});

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
}));

const { mockEnqueuePurge } = vi.hoisted(() => ({
  mockEnqueuePurge: vi.fn(),
}));

vi.mock('@/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('@/lib/account-offboarding/outbox', () => ({
  enqueueAccountOffboardingPurge: mockEnqueuePurge,
}));

import { PurgeRetryError, retryAccountOffboardingPurge } from '../retry-purge';

const OFFBOARDING_ID = 'bbbbbbbb-2222-7333-8444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const ADMIN_ID = '11111111-2222-7333-8444-555555555555';

interface QueryCall {
  text: string;
  values: unknown[];
}

function makeTx(
  options: {
    existingRow?: { id: string } | null;
    resetRow?: { id: string; account_id: string; retry_count: number } | null;
  } = {},
): { tx: any; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const existingRow = options.existingRow === undefined ? { id: OFFBOARDING_ID } : options.existingRow;
  const resetRow = options.resetRow === undefined
    ? { id: OFFBOARDING_ID, account_id: ACCOUNT_ID, retry_count: 2 }
    : options.resetRow;

  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });

    if (text.includes('UPDATE account_offboardings')) {
      return resetRow ? [resetRow] : [];
    }
    if (text.includes('SELECT id') && text.includes('FROM account_offboardings')) {
      return existingRow ? [existingRow] : [];
    }
    return [];
  });
  return { tx, calls };
}

function sqlText(calls: QueryCall[]): string {
  return calls.map((call) => call.text).join('\n');
}

describe('retryAccountOffboardingPurge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws offboarding_not_found (404) when no row matches the id', async () => {
    const { tx } = makeTx({ existingRow: null });
    mockSql.begin.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

    await expect(
      retryAccountOffboardingPurge(mockSql, {
        offboardingId: OFFBOARDING_ID,
        adminUserId: ADMIN_ID,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'offboarding_not_found' });

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueuePurge).not.toHaveBeenCalled();
  });

  it('throws account_offboarding_purge_not_retryable (409) when the reset UPDATE matches no row', async () => {
    const { tx } = makeTx({ resetRow: null });
    mockSql.begin.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

    await expect(
      retryAccountOffboardingPurge(mockSql, {
        offboardingId: OFFBOARDING_ID,
        adminUserId: ADMIN_ID,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'account_offboarding_purge_not_retryable' });

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueuePurge).not.toHaveBeenCalled();
  });

  it('is a PurgeRetryError instance so the route can distinguish it from an unexpected fault', async () => {
    const { tx } = makeTx({ existingRow: null });
    mockSql.begin.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

    await expect(
      retryAccountOffboardingPurge(mockSql, {
        offboardingId: OFFBOARDING_ID,
        adminUserId: ADMIN_ID,
      }),
    ).rejects.toBeInstanceOf(PurgeRetryError);
  });

  it('resets status to purge_scheduled, clears failed_step/last_error, and guards on the exact terminal-purge shape', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

    await retryAccountOffboardingPurge(mockSql, {
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
    });

    const text = sqlText(calls);
    expect(text).toContain("SET status = 'purge_scheduled'");
    expect(text).toContain('failed_step = NULL');
    expect(text).toContain('last_error = NULL');
    expect(text).toContain('retry_count = retry_count + 1');
    expect(text).toContain("AND mode = 'delete_data'");
    expect(text).toContain("AND status = 'failed'");
    expect(text).toContain("AND failed_step = 'purge'");
    expect(text).toContain('AND terminal_at IS NULL');
    // purge_started_at is deliberately never assigned — validatePurgeableOffboarding
    // requires it to stay non-null from the ORIGINAL claim.
    expect(text).not.toContain('purge_started_at');
  });

  it('writes the audit log and enqueues the purge job inside the same transaction, with a deterministic outbox id', async () => {
    const { tx } = makeTx();
    mockSql.begin.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

    const result = await retryAccountOffboardingPurge(mockSql, {
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
      ip: '203.0.113.10',
      userAgent: 'vitest',
      requestId: 'req-1',
    });

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(tx, expect.objectContaining({
      accountId: ACCOUNT_ID,
      actorUserId: ADMIN_ID,
      eventType: 'account_offboarding_purge_retry',
      entityType: 'account_offboarding',
      entityId: OFFBOARDING_ID,
      ip: '203.0.113.10',
      userAgent: 'vitest',
      requestId: 'req-1',
      payload: expect.objectContaining({ status: 'purge_scheduled', retry_count: 2 }),
    }));

    expect(mockEnqueuePurge).toHaveBeenCalledWith(tx, {
      outboxId: result.outboxId,
      accountOffboardingId: OFFBOARDING_ID,
      accountId: ACCOUNT_ID,
      correlationId: 'req-1',
    });
    expect(result).toEqual({
      offboardingId: OFFBOARDING_ID,
      accountId: ACCOUNT_ID,
      status: 'purge_scheduled',
      retryCount: 2,
      outboxId: result.outboxId,
    });
    expect(result.outboxId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('derives a deterministic outbox id from the offboarding id and the NEW retry_count', async () => {
    const first = makeTx({ resetRow: { id: OFFBOARDING_ID, account_id: ACCOUNT_ID, retry_count: 2 } });
    mockSql.begin.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(first.tx));
    const resultA = await retryAccountOffboardingPurge(mockSql, {
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
    });

    const second = makeTx({ resetRow: { id: OFFBOARDING_ID, account_id: ACCOUNT_ID, retry_count: 2 } });
    mockSql.begin.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(second.tx));
    const resultB = await retryAccountOffboardingPurge(mockSql, {
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
    });

    // Same offboarding id + same NEW retry_count ⇒ same outbox id.
    expect(resultA.outboxId).toBe(resultB.outboxId);

    const third = makeTx({ resetRow: { id: OFFBOARDING_ID, account_id: ACCOUNT_ID, retry_count: 3 } });
    mockSql.begin.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(third.tx));
    const resultC = await retryAccountOffboardingPurge(mockSql, {
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
    });

    // A later retry (different retry_count) gets a different outbox id.
    expect(resultC.outboxId).not.toBe(resultA.outboxId);
  });
});
